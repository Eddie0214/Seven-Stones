'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { Worker } = require('node:worker_threads');

const game = require('./game.cjs');
const RULES = require('./public/rules.js');
const invitations = require('./invitations.cjs');
const googleAuth = require('./google-auth.cjs');

const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_COOKIE = 'ss_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TURN_MS = 90 * 1000;
const BODY_LIMIT = 64 * 1024;
const PRESENCE_ONLINE_MS = invitations.ONLINE_WINDOW_MS;

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function nowIso() {
  return new Date().toISOString();
}

function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  for (const part of String(header).split(';')) {
    const at = part.indexOf('=');
    if (at === -1) continue;
    const key = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (!key) continue;
    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      cookies[key] = value;
    }
  }
  return cookies;
}

function readBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        settled = true;
        reject(new ApiError(413, 'Request body is too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      try {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('not an object');
        }
        resolve(parsed);
      } catch {
        reject(new ApiError(400, 'Invalid JSON body.'));
      }
    });
    req.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function securityHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self' https://accounts.google.com",
      "frame-src https://accounts.google.com",
      "style-src 'self' 'unsafe-inline' https://accounts.google.com",
      "img-src 'self' data:",
      "connect-src 'self' https://accounts.google.com",
      "base-uri 'none'",
      "form-action 'self'",
    ].join('; '),
  };
}

function createApp(options = {}) {
  const cookiesSecure =
    options.cookieSecure !== undefined
      ? Boolean(options.cookieSecure)
      : process.env.COOKIE_SECURE === '1';
  const googleClientId =
    options.googleClientId !== undefined
      ? options.googleClientId
      : process.env.GOOGLE_CLIENT_ID || '';
  const dbPath =
    options.dbPath || process.env.DB_PATH || path.join(__dirname, 'data', 'league.sqlite');

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');

  migrate(db);

  const aiPending = new Set();
  const timers = [];
  let worker = null;
  let workerSeq = 0;
  const workerJobs = new Map();
  let closed = false;

  // ---------------------------------------------------------------- meta

  function metaGet(key) {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return row ? String(row.value) : null;
  }

  function metaSet(key, value) {
    db.prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(key, String(value));
  }

  function withTransaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      db.exec('COMMIT');
      return value;
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw error;
    }
  }

  function anchorDate() {
    return metaGet('season_anchor') || game.utcDate();
  }

  function seasonStartOn(date) {
    return game.seasonStartFor(anchorDate(), date);
  }

  function seasonInfo(date = game.utcDate()) {
    const anchor = anchorDate();
    const start = game.seasonStartFor(anchor, date);
    const end = game.seasonEndFor(start);
    return {
      anchor,
      start,
      end,
      number: game.seasonNumber(anchor, date),
      daysLeft: game.daysLeftInSeason(anchor, date),
    };
  }

  // ------------------------------------------------------------- sessions

  function setCookie(res, token) {
    const parts = [
      `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Strict',
      `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    ];
    if (cookiesSecure) parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
  }

  function clearCookie(res) {
    const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
    if (cookiesSecure) parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
  }

  function createSession(userId) {
    const token = crypto.randomBytes(32).toString('base64url');
    const tokenHash = sha256(token);
    const now = Date.now();
    db.prepare(
      'INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)'
    ).run(tokenHash, userId, now + SESSION_TTL_MS, now);
    return token;
  }

  function currentSession(req) {
    const raw = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!raw) return null;
    const tokenHash = sha256(raw);
    const row = db
      .prepare(
        `SELECT s.token_hash, s.user_id, s.expires_at, u.name, u.created_at
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ?`
      )
      .get(tokenHash);
    if (!row) return null;
    if (Number(row.expires_at) <= Date.now()) {
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
      return null;
    }
    return {
      tokenHash,
      user: { id: Number(row.user_id), name: row.name, createdAt: Number(row.created_at) },
    };
  }

  function requireUser(req) {
    const session = currentSession(req);
    if (!session) throw new ApiError(401, 'Please sign in first.');
    return session;
  }

  function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
    const derived = crypto.scryptSync(password, salt, 64).toString('hex');
    return { salt, hash: derived };
  }

  function verifyPassword(password, salt, expected) {
    const actual = crypto.scryptSync(password, salt, 64);
    const wanted = Buffer.from(String(expected), 'hex');
    if (actual.length !== wanted.length) return false;
    return crypto.timingSafeEqual(actual, wanted);
  }

  const DUMMY = hashPassword('seven-stones-dummy-password');

  function getUserById(id) {
    return db.prepare('SELECT id, name, created_at FROM users WHERE id = ?').get(id) || null;
  }

  function googleLinked(userId) {
    return Boolean(db.prepare('SELECT sub FROM google_identities WHERE user_id = ?').get(userId));
  }

  // ------------------------------------------------------------- accounts

  function normalizeName(value) {
    return String(value || '').trim().replace(/\s+/g, ' ');
  }

  function validateName(name) {
    if (name.length < 3 || name.length > 18) {
      throw new ApiError(400, 'Player name must be 3–18 characters.');
    }
    if (!/^[A-Za-z0-9 _.-]+$/.test(name)) {
      throw new ApiError(400, 'Player name may use letters, numbers, spaces, dots, dashes and underscores.');
    }
  }

  function validatePassword(password) {
    if (typeof password !== 'string' || password.length < 8) {
      throw new ApiError(400, 'Password must be at least 8 characters.');
    }
    if (password.length > 200) throw new ApiError(400, 'Password is too long.');
  }

  function uniqueName(base) {
    let clean = String(base || 'Player')
      .replace(/[^A-Za-z0-9 _.-]/g, '')
      .trim()
      .slice(0, 15);
    if (clean.length < 3) clean = `${clean || 'Player'} Nova`.slice(0, 15).trim();
    let candidate = clean;
    let suffix = 1;
    while (db.prepare('SELECT id FROM users WHERE name = ? COLLATE NOCASE').get(candidate)) {
      suffix += 1;
      const tail = ` ${suffix}`;
      candidate = `${clean.slice(0, Math.max(3, 15 - tail.length))}${tail}`;
    }
    return candidate;
  }

  // --------------------------------------------------------------- wallet

  function aiNetFor(userId, date) {
    const row = db
      .prepare(
        "SELECT COALESCE(SUM(net), 0) AS net FROM ledger WHERE user_id = ? AND mode = 'ai' AND date = ?"
      )
      .get(userId, date);
    return Number(row.net) || 0;
  }

  function walletFor(userId, date = game.utcDate()) {
    const netRow = db
      .prepare('SELECT COALESCE(SUM(net), 0) AS net FROM ledger WHERE user_id = ? AND date = ?')
      .get(userId, date);
    const reservedRow = db
      .prepare(
        `SELECT COALESCE(SUM(stake), 0) AS reserved FROM games
         WHERE status = 'active' AND (player_id = ? OR opponent_id = ?) AND date = ?`
      )
      .get(userId, userId, date);
    return (
      RULES.DAILY_BASELINE + (Number(netRow.net) || 0) - (Number(reservedRow.reserved) || 0)
    );
  }

  function completedRankedToday(userId, date = game.utcDate()) {
    return Number(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM ledger
           WHERE user_id = ? AND mode = 'ai' AND date = ? AND qualifies = 1`
        )
        .get(userId, date).count
    );
  }

  function startedRankedToday(userId, date = game.utcDate()) {
    return Number(
      db
        .prepare(
          'SELECT COUNT(*) AS count FROM games WHERE player_id = ? AND mode = ? AND date = ?'
        )
        .get(userId, 'ai', date).count
    );
  }

  function inviteScoreFor(userId, date = game.utcDate()) {
    return RULES.DAILY_BASELINE + aiNetFor(userId, date);
  }

  function inviteUnlocked(userId) {
    return Boolean(db.prepare('SELECT user_id FROM invite_unlocks WHERE user_id = ?').get(userId));
  }

  function checkInviteUnlock(userId, date) {
    if (inviteUnlocked(userId)) return;
    const score = inviteScoreFor(userId, date);
    if (score >= RULES.INVITE_TARGET) {
      db.prepare(
        `INSERT OR IGNORE INTO invite_unlocks (user_id, unlocked_at, date, score)
         VALUES (?, ?, ?, ?)`
      ).run(userId, Date.now(), date, score);
    }
  }

  function backfillInviteUnlocks() {
    const users = db.prepare('SELECT id FROM users').all();
    const insert = db.prepare(
      `INSERT OR IGNORE INTO invite_unlocks (user_id, unlocked_at, date, score)
       VALUES (?, ?, ?, ?)`
    );
    for (const user of users) {
      if (db.prepare('SELECT user_id FROM invite_unlocks WHERE user_id = ?').get(user.id)) {
        continue;
      }
      const rows = db
        .prepare(
          `SELECT date, net FROM ledger
           WHERE user_id = ? AND mode = 'ai'
           ORDER BY date ASC, id ASC`
        )
        .all(user.id);
      let day = null;
      let running = 0;
      for (const row of rows) {
        if (row.date !== day) {
          day = row.date;
          running = 0;
        }
        running += Number(row.net) || 0;
        if (RULES.DAILY_BASELINE + running >= RULES.INVITE_TARGET) {
          insert.run(user.id, Date.now(), day, RULES.DAILY_BASELINE + running);
          break;
        }
      }
    }
  }

  // ---------------------------------------------------------- leaderboards

  function leaderboardToday(date) {
    const rows = db
      .prepare(
        `SELECT u.id, u.name,
                COUNT(*) AS games,
                SUM(CASE WHEN l.result = 'win' THEN 1 ELSE 0 END) AS wins,
                SUM(CASE WHEN l.result = 'loss' THEN 1 ELSE 0 END) AS losses,
                COALESCE(SUM(l.net), 0) AS net
         FROM ledger l
         JOIN users u ON u.id = l.user_id
         JOIN games g ON g.id = l.game_id
         WHERE l.mode = 'ai' AND l.date = ?
           AND g.end_reason NOT IN ('midnight', 'error')
         GROUP BY u.id
         ORDER BY net DESC, wins DESC, losses ASC, u.name COLLATE NOCASE ASC
         LIMIT 20`
      )
      .all(date);
    return rank(rows);
  }

  function leaderboardSeason(seasonStart) {
    const rows = db
      .prepare(
        `SELECT u.id, u.name,
                COUNT(*) AS games,
                SUM(CASE WHEN l.result = 'win' THEN 1 ELSE 0 END) AS wins,
                SUM(CASE WHEN l.result = 'loss' THEN 1 ELSE 0 END) AS losses,
                COALESCE(SUM(l.net), 0) AS net
         FROM ledger l
         JOIN users u ON u.id = l.user_id
         JOIN games g ON g.id = l.game_id
         WHERE l.mode = 'ai' AND l.season_start = ?
           AND g.end_reason NOT IN ('midnight', 'error')
         GROUP BY u.id
         ORDER BY net DESC, wins DESC, losses ASC, u.name COLLATE NOCASE ASC
         LIMIT 20`
      )
      .all(seasonStart);
    return rank(rows);
  }

  function rank(rows) {
    return game
      .rankEntries(
        rows.map((row) => ({
          id: Number(row.id),
          name: row.name,
          games: Number(row.games),
          wins: Number(row.wins) || 0,
          losses: Number(row.losses) || 0,
          net: Number(row.net) || 0,
        }))
      )
      .map((entry) => ({ ...entry, online: invitations.isOnline(db, entry.id) }));
  }

  function topThreeIds(date) {
    const today = leaderboardToday(date).slice(0, 3);
    const season = leaderboardSeason(seasonStartOn(date)).slice(0, 3);
    return new Set([...today.map((r) => r.id), ...season.map((r) => r.id)]);
  }

  // --------------------------------------------------------------- games

  function getGame(id) {
    return db.prepare('SELECT * FROM games WHERE id = ?').get(id) || null;
  }

  function parseBoard(json) {
    try {
      return game.boardFromJSON(JSON.parse(json));
    } catch {
      return game.createBoard();
    }
  }

  function finishGame(gameId, winner, reason) {
    return withTransaction(() => {
      const row = getGame(gameId);
      if (!row || row.status !== 'active') return null;
      const now = Date.now();
      const qualifies = row.mode === 'ai' && (reason === 'five' || reason === 'full_draw');
      const resultColor = winner === null ? 'draw' : winner === game.BLACK ? 'black' : 'white';
      const updated = db
        .prepare(
          `UPDATE games
           SET status = 'finished', result = ?, end_reason = ?, qualifies = ?,
               turn = NULL, deadline = NULL, revision = revision + 1, updated_at = ?
           WHERE id = ? AND status = 'active'`
        )
        .run(resultColor, reason, qualifies ? 1 : 0, now, gameId);
      if (!updated.changes) return null;

      const participants = [{ userId: Number(row.player_id), color: Number(row.player_color) }];
      if (row.mode === 'human' && row.opponent_id) {
        participants.push({ userId: Number(row.opponent_id), color: Number(row.opponent_color) });
      }
      const insertLedger = db.prepare(
        `INSERT OR IGNORE INTO ledger
           (game_id, user_id, mode, stake, result, net, qualifies, date, season_start, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const participant of participants) {
        let result = 'draw';
        let net = 0;
        if (winner !== null) {
          result = winner === participant.color ? 'win' : 'loss';
          net = result === 'win' ? Number(row.stake) : -Number(row.stake);
        }
        insertLedger.run(
          gameId,
          participant.userId,
          row.mode,
          Number(row.stake),
          result,
          net,
          qualifies ? 1 : 0,
          row.date,
          row.season_start,
          now
        );
        if (row.mode === 'ai') checkInviteUnlock(participant.userId, row.date);
      }
      return getGame(gameId);
    });
  }

  function applyMove(row, index, color) {
    const now = Date.now();
    const board = parseBoard(row.board);
    if (board[index] !== game.EMPTY) throw new ApiError(409, 'That point is already occupied.');
    board[index] = color;
    db.prepare('UPDATE games SET board = ?, revision = revision + 1, updated_at = ? WHERE id = ?').run(
      JSON.stringify(board),
      now,
      row.id
    );
    const winLine = game.findWinningLine(board, index, color);
    if (winLine) {
      finishGame(row.id, color, 'five');
      return { game: getGame(row.id), winningLine: winLine };
    }
    if (game.isBoardFull(board)) {
      finishGame(row.id, null, 'full_draw');
      return { game: getGame(row.id), winningLine: null };
    }
    const next = color === game.BLACK ? game.WHITE : game.BLACK;
    const deadline = row.mode === 'human' ? now + TURN_MS : null;
    db.prepare(
      'UPDATE games SET turn = ?, deadline = ?, revision = revision + 1, updated_at = ? WHERE id = ?'
    ).run(next, deadline, now, row.id);
    return { game: getGame(row.id), winningLine: null };
  }

  function createHumanGame(playerA, playerB, stake, now) {
    const aColor = crypto.randomInt(0, 2) === 0 ? game.BLACK : game.WHITE;
    const bColor = aColor === game.BLACK ? game.WHITE : game.BLACK;
    const date = game.utcDate(now);
    const seasonStart = seasonStartOn(date);
    const result = db
      .prepare(
        `INSERT INTO games
           (mode, board, player_id, opponent_id, stake, player_color, opponent_color,
            status, result, end_reason, qualifies, turn, deadline, date, season_start,
            revision, created_at, updated_at)
         VALUES ('human', ?, ?, ?, ?, ?, ?, 'active', NULL, NULL, 0, ?, ?, ?, ?, 0, ?, ?)`
      )
      .run(
        JSON.stringify(game.createBoard()),
        playerA,
        playerB,
        stake,
        aColor,
        bColor,
        game.BLACK,
        now + TURN_MS,
        date,
        seasonStart,
        now,
        now
      );
    return getGame(result.lastInsertRowid);
  }

  // ------------------------------------------------------------------- AI

  function ensureWorker() {
    if (worker) return;
    worker = new Worker(path.join(__dirname, 'ai-worker.cjs'));
    worker.unref();
    worker.on('message', (message) => {
      const job = workerJobs.get(message.id);
      if (!job) return;
      workerJobs.delete(message.id);
      clearTimeout(job.timer);
      if (message.error) job.reject(new Error(message.error));
      else job.resolve(message.move);
    });
    worker.on('error', (error) => {
      for (const job of workerJobs.values()) {
        clearTimeout(job.timer);
        job.reject(error);
      }
      workerJobs.clear();
      worker = null;
    });
    worker.on('exit', () => {
      for (const job of workerJobs.values()) {
        clearTimeout(job.timer);
        job.reject(new Error('AI worker stopped.'));
      }
      workerJobs.clear();
      worker = null;
    });
  }

  function askNova(board, color, level) {
    ensureWorker();
    const id = ++workerSeq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        workerJobs.delete(id);
        reject(new Error('AI timed out.'));
      }, 15000);
      workerJobs.set(id, { resolve, reject, timer });
      worker.postMessage({ id, board: Array.from(board), color, level });
    });
  }

  function scheduleAi(gameId) {
    if (closed || aiPending.has(gameId)) return;
    aiPending.add(gameId);
    setTimeout(async () => {
      let row = null;
      try {
        row = getGame(gameId);
        if (!row || row.status !== 'active' || row.mode !== 'ai' || row.date !== game.utcDate()) {
          return;
        }
        const aiColor = Number(row.player_color) === game.BLACK ? game.WHITE : game.BLACK;
        if (Number(row.turn) !== aiColor) return;
        const board = parseBoard(row.board);
        const move = await askNova(board, aiColor, 'advanced');
        if (move === null || !Number.isInteger(move) || move < 0 || move >= game.SIZE * game.SIZE) {
          throw new Error('AI returned an invalid move.');
        }
        row = getGame(gameId);
        if (!row || row.status !== 'active' || row.mode !== 'ai') return;
        if (Number(row.turn) !== aiColor) return;
        if (row.date !== game.utcDate()) {
          finishGame(gameId, null, 'midnight');
          return;
        }
        if (parseBoard(row.board)[move] !== game.EMPTY) {
          throw new Error('AI chose an occupied point.');
        }
        applyMove(row, move, aiColor);
      } catch (error) {
        console.error('[seven-stones] AI move failed:', error);
        const fresh = getGame(gameId);
        if (fresh && fresh.status === 'active') finishGame(gameId, null, 'error');
      } finally {
        aiPending.delete(gameId);
      }
    }, 10);
  }

  function closeWorker() {
    if (worker) {
      worker.terminate().catch(() => {});
      worker = null;
    }
    for (const job of workerJobs.values()) {
      clearTimeout(job.timer);
      job.reject(new Error('Server shutting down.'));
    }
    workerJobs.clear();
  }

  // ------------------------------------------------------ daily / seasons

  function insertAnnouncement(kind, period, title, winners) {
    db.prepare(
      `INSERT OR IGNORE INTO announcements (kind, period, title, winners, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(kind, period, title, JSON.stringify(winners), Date.now());
  }

  function settleDay(date) {
    const rows = leaderboardToday(date);
    if (!rows.length) return;
    insertAnnouncement(
      'daily',
      date,
      `Daily Top 3 · ${date}`,
      rows.slice(0, 3).map((row) => ({
        rank: row.rank,
        id: row.id,
        name: row.name,
        net: row.net,
        wins: row.wins,
        losses: row.losses,
      }))
    );
  }

  function settleDailyThrough(target) {
    let last = metaGet('last_settled_date');
    if (!last) last = game.addDays(anchorDate(), -1);
    let guard = 0;
    let cursor = game.addDays(last, 1);
    while (game.daysBetween(cursor, target) >= 0 && guard < 4000) {
      settleDay(cursor);
      metaSet('last_settled_date', cursor);
      cursor = game.addDays(cursor, 1);
      guard += 1;
    }
  }

  function settleSeasons(today) {
    let start = anchorDate();
    let guard = 0;
    while (guard < 2000) {
      const end = game.seasonEndFor(start);
      if (game.daysBetween(end, today) <= 0) break;
      const rows = leaderboardSeason(start);
      if (rows.length) {
        insertAnnouncement(
          'season',
          start,
          `Seven-day Champions · ${start} – ${end}`,
          rows.slice(0, 3).map((row) => ({
            rank: row.rank,
            id: row.id,
            name: row.name,
            net: row.net,
            wins: row.wins,
            losses: row.losses,
          }))
        );
      }
      start = game.addDays(start, 7);
      guard += 1;
    }
  }

  function rolloverIfNeeded(now) {
    const today = game.utcDate(now);
    const lastSeen = metaGet('last_seen_date') || today;
    if (lastSeen === today) return;
    const stale = db.prepare("SELECT id FROM games WHERE status = 'active' AND date < ?").all(today);
    for (const row of stale) finishGame(row.id, null, 'midnight');
    invitations.expireInvitations(db, now);
    settleDailyThrough(game.addDays(today, -1));
    settleSeasons(today);
    metaSet('last_seen_date', today);
  }

  // ---------------------------------------------------------- serializers

  function serializeGame(row, viewer) {
    if (!row) return null;
    const board = parseBoard(row.board);
    const isPlayer = Number(row.player_id) === viewer.id;
    const yourColor = isPlayer ? Number(row.player_color) : Number(row.opponent_color);
    const opponentId = isPlayer ? row.opponent_id : row.player_id;
    const opponent = opponentId ? getUserById(opponentId) : null;
    let result = null;
    if (row.status === 'finished') {
      if (row.result === 'draw') result = 'draw';
      else result = row.result === (yourColor === game.BLACK ? 'black' : 'white') ? 'win' : 'loss';
    }
    const win = row.status === 'finished' ? game.findAnyWin(board) : null;
    return {
      id: Number(row.id),
      mode: row.mode,
      stake: Number(row.stake),
      board,
      yourColor,
      turn: row.turn === null ? null : Number(row.turn),
      deadline: row.deadline === null ? null : Number(row.deadline),
      revision: Number(row.revision),
      status: row.status,
      result,
      endReason: row.end_reason,
      date: row.date,
      opponent: { id: opponentId ? Number(opponentId) : null, name: opponent ? opponent.name : 'NOVA' },
      winningLine: win ? win.line : null,
      thinking: row.mode === 'ai' && aiPending.has(Number(row.id)),
      createdAt: Number(row.created_at),
    };
  }

  function historyFor(userId) {
    const rows = db
      .prepare(
        `SELECT l.game_id, l.mode, l.stake, l.result, l.net, l.date, l.created_at,
                g.end_reason, g.created_at AS game_created,
                u.name AS opponent_name
         FROM ledger l
         JOIN games g ON g.id = l.game_id
         LEFT JOIN users u
           ON u.id = CASE WHEN g.player_id = l.user_id THEN g.opponent_id ELSE g.player_id END
         WHERE l.user_id = ?
         ORDER BY l.created_at DESC, l.id DESC
         LIMIT 20`
      )
      .all(userId);
    return rows.map((row) => ({
      gameId: Number(row.game_id),
      mode: row.mode,
      stake: Number(row.stake),
      result: row.result,
      net: Number(row.net),
      date: row.date,
      endReason: row.end_reason,
      opponent: row.mode === 'ai' ? 'NOVA' : row.opponent_name || 'Player',
      createdAt: Number(row.created_at),
    }));
  }

  function invitationsFor(userId) {
    const rows = invitations.pendingForUser(db, userId);
    const received = [];
    const sent = [];
    for (const row of rows) {
      const item = {
        id: Number(row.id),
        stake: Number(row.stake),
        status: row.status,
        createdAt: Number(row.created_at),
        expiresAt: Number(row.expires_at),
        sender: { id: Number(row.sender_id), name: row.sender_name },
        receiver: { id: Number(row.receiver_id), name: row.receiver_name },
      };
      if (Number(row.receiver_id) === userId) received.push(item);
      else sent.push(item);
    }
    return { received, sent };
  }

  function announcementList(kind, limit) {
    return db
      .prepare('SELECT * FROM announcements WHERE kind = ? ORDER BY period DESC LIMIT ?')
      .all(kind, limit)
      .map((row) => ({
        kind: row.kind,
        period: row.period,
        title: row.title,
        winners: JSON.parse(row.winners),
        createdAt: Number(row.created_at),
      }));
  }

  function mePayload(user, date) {
    const completed = completedRankedToday(user.id, date);
    const allowed = RULES.allowedStakes(completed);
    const session = seasonInfo(date);
    return {
      id: user.id,
      name: user.name,
      wallet: walletFor(user.id, date),
      net: aiNetFor(user.id, date),
      used: startedRankedToday(user.id, date),
      completed,
      allowedStakes: allowed,
      nextTier: RULES.nextTier(completed),
      inviteUnlocked: inviteUnlocked(user.id),
      inviteScore: inviteScoreFor(user.id, date),
      inviteTarget: RULES.INVITE_TARGET,
      googleLinked: googleLinked(user.id),
      season: session,
    };
  }

  function buildState(req) {
    const session = currentSession(req);
    const now = Date.now();
    const today = game.utcDate(now);
    const season = seasonInfo(today);
    let user = null;
    let me = null;
    let gamePayload = null;
    let lastGame = null;
    let history = [];
    let inviteBox = { received: [], sent: [] };

    if (session) {
      user = session.user;
      invitations.touchPresence(db, user.id, now);
      me = mePayload(user, today);
      let active = invitations.activeGameFor(db, user.id);
      if (active && (active.date !== today || Number(active.deadline) <= now)) {
        if (active.date !== today) {
          finishGame(active.id, null, 'midnight');
        } else if (active.mode === 'human' && Number(active.deadline) <= now) {
          const winner =
            Number(active.turn) === Number(active.player_color)
              ? Number(active.opponent_color)
              : Number(active.player_color);
          finishGame(active.id, winner, 'timeout');
        }
        active = invitations.activeGameFor(db, user.id);
      }
      gamePayload = serializeGame(active, user);
      if (!gamePayload) {
        const last = db
          .prepare(
            `SELECT * FROM games
             WHERE status = 'finished' AND (player_id = ? OR opponent_id = ?)
             ORDER BY id DESC LIMIT 1`
          )
          .get(user.id, user.id);
        lastGame = serializeGame(last || null, user);
      }
      history = historyFor(user.id);
      inviteBox = invitationsFor(user.id);
    }

    const todayBoard = leaderboardToday(today).map((row) => ({
      ...row,
      top3: row.rank <= 3,
    }));
    const seasonBoard = leaderboardSeason(season.start).map((row) => ({
      ...row,
      top3: row.rank <= 3,
    }));

    return {
      ok: true,
      now,
      today,
      server: {
        season,
        googleEnabled: Boolean(googleClientId),
        googleClientId: googleClientId || null,
        cookieSecure: cookiesSecure,
      },
      me,
      game: gamePayload,
      lastGame,
      leaderboard: { today: todayBoard, season: seasonBoard },
      history,
      invitations: inviteBox,
      announcements: {
        daily: announcementList('daily', 7),
        season: announcementList('season', 4),
      },
    };
  }

  // --------------------------------------------------------------- router

  function cookieHeader(token) {
    return token;
  }

  async function handleApi(req, res, url) {
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    const pathname = url.pathname;

    if (method === 'GET' && pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, app: 'seven-stones' });
    }

    if (method === 'GET' && pathname === '/api/state') {
      return sendJson(res, 200, buildState(req));
    }

    if (method === 'POST' && pathname === '/api/register') {
      const body = await readBody(req);
      const name = normalizeName(body.name);
      validateName(name);
      validatePassword(body.password);
      if (db.prepare('SELECT id FROM users WHERE name = ? COLLATE NOCASE').get(name)) {
        throw new ApiError(409, 'That player name is already taken.');
      }
      const { salt, hash } = hashPassword(body.password);
      let result;
      try {
        result = db
          .prepare('INSERT INTO users (name, salt, password_hash, created_at) VALUES (?, ?, ?, ?)')
          .run(name, salt, hash, Date.now());
      } catch {
        throw new ApiError(409, 'That player name is already taken.');
      }
      const token = createSession(Number(result.lastInsertRowid));
      setCookie(res, token);
      invitations.touchPresence(db, Number(result.lastInsertRowid));
      return sendJson(res, 201, { ok: true, name });
    }

    if (method === 'POST' && pathname === '/api/login') {
      const body = await readBody(req);
      const name = normalizeName(body.name);
      const row = db.prepare('SELECT * FROM users WHERE name = ? COLLATE NOCASE').get(name);
      const ok = row
        ? verifyPassword(String(body.password || ''), row.salt, row.password_hash)
        : (verifyPassword(String(body.password || ''), DUMMY.salt, DUMMY.hash), false);
      if (!ok) throw new ApiError(401, 'Incorrect player name or password.');
      const token = createSession(Number(row.id));
      setCookie(res, token);
      invitations.touchPresence(db, Number(row.id));
      return sendJson(res, 200, { ok: true, name: row.name });
    }

    if (method === 'POST' && pathname === '/api/logout') {
      const session = requireUser(req);
      if (invitations.activeGameFor(db, session.user.id)) {
        throw new ApiError(409, 'Finish your game before signing out.');
      }
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(session.tokenHash);
      clearCookie(res);
      return sendJson(res, 200, { ok: true });
    }

    if (method === 'GET' && pathname === '/api/google/challenge') {
      if (!googleClientId) throw new ApiError(404, 'Google login is not configured.');
      const session = currentSession(req);
      const now = Date.now();
      db.prepare('DELETE FROM google_challenges WHERE expires_at <= ?').run(now);
      const nonce = crypto.randomBytes(24).toString('base64url');
      db.prepare(
        `INSERT INTO google_challenges (nonce, session_hash, expires_at, used, created_at)
         VALUES (?, ?, ?, 0, ?)`
      ).run(nonce, session ? session.tokenHash : null, now + 10 * 60 * 1000, now);
      return sendJson(res, 200, { ok: true, nonce });
    }

    if (method === 'POST' && pathname === '/api/google') {
      if (!googleClientId) throw new ApiError(404, 'Google login is not configured.');
      const body = await readBody(req);
      const session = currentSession(req);
      const now = Date.now();
      const nonce = String(body.nonce || '');
      const challenge = db
        .prepare('SELECT * FROM google_challenges WHERE nonce = ?')
        .get(nonce);
      if (!challenge || Number(challenge.used) || Number(challenge.expires_at) <= now) {
        throw new ApiError(400, 'Google login challenge expired. Try again.');
      }
      if (challenge.session_hash && challenge.session_hash !== (session ? session.tokenHash : '')) {
        throw new ApiError(400, 'Google login challenge did not match this session.');
      }
      const claimed = db
        .prepare('UPDATE google_challenges SET used = 1 WHERE nonce = ? AND used = 0')
        .run(nonce);
      if (!claimed.changes) throw new ApiError(400, 'Google login challenge was already used.');

      let payload;
      try {
        payload = await googleAuth.verifyCredential(googleClientId, body.credential, nonce);
      } catch (error) {
        throw new ApiError(401, error.message || 'Google sign-in failed.');
      }

      const identity = db
        .prepare('SELECT * FROM google_identities WHERE sub = ?')
        .get(payload.sub);

      let user;
      if (session) {
        if (identity && Number(identity.user_id) !== session.user.id) {
          throw new ApiError(
            409,
            'That Google account is already linked to another player. Sign in with that account instead.'
          );
        }
        user = session.user;
        if (!identity && googleLinked(user.id)) {
          throw new ApiError(409, 'This player already has a linked Google account.');
        }
        if (!identity) {
          db.prepare(
            `INSERT INTO google_identities (sub, user_id, email, name, created_at)
             VALUES (?, ?, ?, ?, ?)`
          ).run(payload.sub, user.id, payload.email || null, payload.name || null, now);
        }
      } else if (identity) {
        const found = getUserById(identity.user_id);
        if (!found) throw new ApiError(401, 'Linked player no longer exists.');
        user = found;
        const token = createSession(user.id);
        setCookie(res, cookieHeader(token));
      } else {
        const name = uniqueName(payload.name || (payload.email || 'player').split('@')[0]);
        const { salt, hash } = hashPassword(crypto.randomBytes(32).toString('hex'));
        const result = db
          .prepare('INSERT INTO users (name, salt, password_hash, created_at) VALUES (?, ?, ?, ?)')
          .run(name, salt, hash, now);
        user = getUserById(result.lastInsertRowid);
        db.prepare(
          `INSERT INTO google_identities (sub, user_id, email, name, created_at)
           VALUES (?, ?, ?, ?, ?)`
        ).run(payload.sub, user.id, payload.email || null, payload.name || null, now);
        const token = createSession(user.id);
        setCookie(res, cookieHeader(token));
      }
      invitations.touchPresence(db, user.id, now);
      return sendJson(res, 200, { ok: true, name: user.name, linked: Boolean(identity) });
    }

    if (method === 'POST' && pathname === '/api/start-ai') {
      const session = requireUser(req);
      const body = await readBody(req);
      const user = session.user;
      const today = game.utcDate();
      if (invitations.isBusy(db, user.id)) {
        throw new ApiError(409, 'You already have an active game or matchmaking entry.');
      }
      const stake = RULES.stakeFromInput(body.stake);
      if (!stake) throw new ApiError(400, 'Choose a valid stake.');
      const completed = completedRankedToday(user.id, today);
      if (!RULES.canStake(stake, completed)) {
        throw new ApiError(403, `That stake is still locked. Complete ${RULES.nextTier(completed)?.remaining || 0} more ranked AI games to unlock it.`);
      }
      if (walletFor(user.id, today) < stake) {
        throw new ApiError(403, 'Your available balance is too low for that stake.');
      }
      const started = Number(
        db
          .prepare(
            'SELECT COUNT(*) AS count FROM games WHERE date = ? AND (player_id = ? OR opponent_id = ?)'
          )
          .get(today, user.id, user.id).count
      );
      const playerColor = started % 2 === 0 ? game.BLACK : game.WHITE;
      const now = Date.now();
      const result = db
        .prepare(
          `INSERT INTO games
             (mode, board, player_id, opponent_id, stake, player_color, opponent_color,
              status, result, end_reason, qualifies, turn, deadline, date, season_start,
              revision, created_at, updated_at)
           VALUES ('ai', ?, ?, NULL, ?, ?, NULL, 'active', NULL, NULL, 0, ?, NULL, ?, ?, 0, ?, ?)`
        )
        .run(
          JSON.stringify(game.createBoard()),
          user.id,
          stake,
          playerColor,
          game.BLACK,
          today,
          seasonStartOn(today),
          now,
          now
        );
      const row = getGame(result.lastInsertRowid);
      const aiColor = playerColor === game.BLACK ? game.WHITE : game.BLACK;
      if (Number(row.turn) === aiColor) scheduleAi(Number(row.id));
      return sendJson(res, 201, { ok: true, game: serializeGame(row, user) });
    }

    if (method === 'POST' && pathname === '/api/move') {
      const session = requireUser(req);
      const body = await readBody(req);
      const user = session.user;
      const now = Date.now();
      const row = getGame(Number(body.game));
      if (!row) throw new ApiError(404, 'Game not found.');
      if (row.status !== 'active') throw new ApiError(409, 'That game is already finished.');
      const isPlayer = Number(row.player_id) === user.id;
      const isOpponent = Number(row.opponent_id) === user.id;
      if (!isPlayer && !isOpponent) throw new ApiError(403, 'That game belongs to other players.');
      if (row.date !== game.utcDate(now)) {
        finishGame(row.id, null, 'midnight');
        throw new ApiError(409, 'That game expired at midnight UTC and the stake was returned.');
      }
      const myColor = isPlayer ? Number(row.player_color) : Number(row.opponent_color);
      if (Number(row.turn) !== myColor) throw new ApiError(409, 'It is not your turn.');
      if (row.mode === 'human' && row.deadline && Number(row.deadline) <= now) {
        const winner = Number(row.turn) === Number(row.player_color)
          ? Number(row.opponent_color)
          : Number(row.player_color);
        finishGame(row.id, winner, 'timeout');
        throw new ApiError(409, 'Your 90-second turn expired.');
      }
      if (body.revision !== undefined && Number(body.revision) !== Number(row.revision)) {
        throw new ApiError(409, 'The board changed. Refreshing now.');
      }
      const index = Number(body.index);
      if (!Number.isInteger(index) || index < 0 || index >= game.SIZE * game.SIZE) {
        throw new ApiError(400, 'Move must be an empty point from 0 to 224.');
      }
      if (parseBoard(row.board)[index] !== game.EMPTY) {
        throw new ApiError(409, 'That point is already occupied.');
      }
      const applied = applyMove(row, index, myColor);
      const fresh = applied.game;
      if (
        row.mode === 'ai' &&
        fresh &&
        fresh.status === 'active' &&
        Number(fresh.turn) !== Number(fresh.player_color)
      ) {
        scheduleAi(Number(fresh.id));
      }
      return sendJson(res, 200, {
        ok: true,
        winningLine: applied.winningLine,
        game: serializeGame(fresh, user),
      });
    }

    if (method === 'POST' && pathname === '/api/resign') {
      const session = requireUser(req);
      const body = await readBody(req);
      const user = session.user;
      const row = getGame(Number(body.game));
      if (!row) throw new ApiError(404, 'Game not found.');
      if (row.status !== 'active') throw new ApiError(409, 'That game is already finished.');
      const isPlayer = Number(row.player_id) === user.id;
      const isOpponent = Number(row.opponent_id) === user.id;
      if (!isPlayer && !isOpponent) throw new ApiError(403, 'That game belongs to other players.');
      const myColor = isPlayer ? Number(row.player_color) : Number(row.opponent_color);
      const winner = myColor === game.BLACK ? game.WHITE : game.BLACK;
      finishGame(row.id, winner, 'resign');
      return sendJson(res, 200, { ok: true });
    }

    if (method === 'POST' && pathname === '/api/invite') {
      const session = requireUser(req);
      const body = await readBody(req);
      const user = session.user;
      const now = Date.now();
      const today = game.utcDate(now);
      invitations.expireInvitations(db, now);
      if (!inviteUnlocked(user.id)) {
        throw new ApiError(
          403,
          'Leaderboard invitations unlock after reaching 1,000 points in a day.'
        );
      }
      let target = null;
      if (body.player !== undefined) {
        const raw = String(body.player);
        if (/^\d+$/.test(raw)) target = getUserById(Number(raw));
        if (!target) target = db.prepare('SELECT id, name FROM users WHERE name = ? COLLATE NOCASE').get(raw);
      }
      if (!target) throw new ApiError(404, 'That player was not found.');
      if (Number(target.id) === user.id) throw new ApiError(400, 'You cannot challenge yourself.');
      if (!topThreeIds(today).has(Number(target.id))) {
        throw new ApiError(403, 'You can only challenge a top-three player from today or this season.');
      }
      const stake = RULES.stakeFromInput(body.stake);
      if (!stake) throw new ApiError(400, 'Choose a valid stake.');
      const completed = completedRankedToday(user.id, today);
      if (!RULES.canStake(stake, completed)) {
        throw new ApiError(403, 'That stake is still locked for you.');
      }
      if (walletFor(user.id, today) < stake) {
        throw new ApiError(403, 'Your available balance is too low for that stake.');
      }
      if (invitations.recentInviteCount(db, user.id, now - 60 * 60 * 1000) >= 5) {
        throw new ApiError(429, 'You can send at most 5 invitations per hour.');
      }
      if (invitations.pendingBetween(db, user.id, Number(target.id))) {
        throw new ApiError(409, 'You already have a pending invitation to that player.');
      }
      const expiresAt = game.nextUtcMidnight(now);
      const result = db
        .prepare(
          `INSERT INTO invitations
             (sender_id, receiver_id, stake, status, game_id, created_at, expires_at, responded_at)
           VALUES (?, ?, ?, 'pending', NULL, ?, ?, NULL)`
        )
        .run(user.id, Number(target.id), stake, now, expiresAt);
      return sendJson(res, 201, {
        ok: true,
        invitation: {
          id: Number(result.lastInsertRowid),
          stake,
          expiresAt,
          receiver: { id: Number(target.id), name: target.name },
        },
      });
    }

    if (
      method === 'POST' &&
      (pathname === '/api/invite-accept' ||
        pathname === '/api/invite-decline' ||
        pathname === '/api/invite-cancel')
    ) {
      const session = requireUser(req);
      const body = await readBody(req);
      const user = session.user;
      const now = Date.now();
      const row = db.prepare('SELECT * FROM invitations WHERE id = ?').get(Number(body.id));
      if (!row) throw new ApiError(404, 'Invitation not found.');
      const isReceiver = Number(row.receiver_id) === user.id;
      const isSender = Number(row.sender_id) === user.id;
      if (pathname === '/api/invite-accept' && !isReceiver) {
        throw new ApiError(403, 'Only the invited player can accept.');
      }
      if (pathname === '/api/invite-decline' && !isReceiver) {
        throw new ApiError(403, 'Only the invited player can decline.');
      }
      if (pathname === '/api/invite-cancel' && !isSender) {
        throw new ApiError(403, 'Only the sender can cancel.');
      }
      if (!isReceiver && !isSender) throw new ApiError(403, 'That invitation belongs to other players.');
      if (row.status !== 'pending') {
        throw new ApiError(409, `That invitation is already ${row.status}.`);
      }
      if (Number(row.expires_at) <= now) {
        db.prepare("UPDATE invitations SET status = 'expired', responded_at = ? WHERE id = ?").run(
          now,
          row.id
        );
        throw new ApiError(409, 'That invitation expired at midnight UTC.');
      }

      if (pathname === '/api/invite-decline' || pathname === '/api/invite-cancel') {
        db.prepare(
          `UPDATE invitations SET status = ?, responded_at = ? WHERE id = ? AND status = 'pending'`
        ).run(pathname === '/api/invite-cancel' ? 'cancelled' : 'declined', now, row.id);
        return sendJson(res, 200, { ok: true });
      }

      // Accept
      invitations.touchPresence(db, user.id, now);
      const sender = getUserById(row.sender_id);
      if (!sender) throw new ApiError(409, 'The inviting player no longer exists.');
      if (!invitations.isOnline(db, sender.id, now)) {
        throw new ApiError(409, 'The other player is offline right now.');
      }
      if (!invitations.isOnline(db, user.id, now)) {
        throw new ApiError(409, 'Presence could not be confirmed. Try again.');
      }
      if (invitations.isBusy(db, sender.id) || invitations.isBusy(db, user.id)) {
        throw new ApiError(409, 'Both players must be free of active games and matchmaking.');
      }
      const today = game.utcDate(now);
      const stake = Number(row.stake);
      for (const player of [sender, user]) {
        const completed = completedRankedToday(player.id, today);
        if (!RULES.canStake(stake, completed)) {
          throw new ApiError(409, `${player.name} has not unlocked that stake today.`);
        }
        if (walletFor(player.id, today) < stake) {
          throw new ApiError(409, `${player.name} cannot afford that stake right now.`);
        }
      }
      const created = withTransaction(() => {
        const fresh = db.prepare('SELECT * FROM invitations WHERE id = ?').get(row.id);
        if (!fresh || fresh.status !== 'pending') {
          throw new ApiError(409, 'That invitation is no longer available.');
        }
        if (invitations.isBusy(db, Number(fresh.sender_id)) || invitations.isBusy(db, user.id)) {
          throw new ApiError(409, 'Both players must be free of active games and matchmaking.');
        }
        const humanGame = createHumanGame(Number(fresh.sender_id), user.id, stake, now);
        db.prepare(
          `UPDATE invitations SET status = 'accepted', game_id = ?, responded_at = ?
           WHERE id = ? AND status = 'pending'`
        ).run(humanGame.id, now, fresh.id);
        return humanGame;
      });
      return sendJson(res, 201, { ok: true, game: serializeGame(created, user) });
    }

    if (method === 'POST' && pathname === '/api/queue') {
      const session = requireUser(req);
      const body = await readBody(req);
      const user = session.user;
      const now = Date.now();
      const today = game.utcDate(now);
      if (invitations.isBusy(db, user.id)) {
        throw new ApiError(409, 'You already have an active game or matchmaking entry.');
      }
      const stake = RULES.stakeFromInput(body.stake);
      if (!stake) throw new ApiError(400, 'Choose a valid stake.');
      if (!RULES.canStake(stake, completedRankedToday(user.id, today))) {
        throw new ApiError(403, 'That stake is still locked for you.');
      }
      if (walletFor(user.id, today) < stake) {
        throw new ApiError(403, 'Your available balance is too low for that stake.');
      }
      const waiting = db
        .prepare('SELECT * FROM queue WHERE stake = ? AND user_id <> ? ORDER BY created_at ASC LIMIT 1')
        .get(stake, user.id);
      if (waiting) {
        const other = getUserById(waiting.user_id);
        const otherCompleted = completedRankedToday(other.id, today);
        if (
          other &&
          RULES.canStake(stake, otherCompleted) &&
          walletFor(other.id, today) >= stake &&
          !invitations.activeGameFor(db, other.id)
        ) {
          const humanGame = withTransaction(() => {
            db.prepare('DELETE FROM queue WHERE user_id IN (?, ?)').run(user.id, other.id);
            return createHumanGame(other.id, user.id, stake, now);
          });
          return sendJson(res, 200, {
            ok: true,
            matched: true,
            game: serializeGame(humanGame, user),
          });
        }
        db.prepare('DELETE FROM queue WHERE user_id = ?').run(other.id);
      }
      db.prepare(
        `INSERT INTO queue (user_id, stake, created_at) VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET stake = excluded.stake, created_at = excluded.created_at`
      ).run(user.id, stake, now);
      return sendJson(res, 200, { ok: true, matched: false });
    }

    if (method === 'POST' && pathname === '/api/cancel') {
      const session = requireUser(req);
      db.prepare('DELETE FROM queue WHERE user_id = ?').run(session.user.id);
      return sendJson(res, 200, { ok: true });
    }

    throw new ApiError(404, 'Not found.');
  }

  function sendJson(res, status, payload) {
    const text = JSON.stringify(payload);
    res.writeHead(status, {
      ...securityHeaders(),
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(text),
    });
    res.end(text);
  }

  function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      throw new ApiError(405, 'Method not allowed.');
    }
    let relative;
    try {
      relative = decodeURIComponent(pathname);
    } catch {
      throw new ApiError(400, 'Bad path.');
    }
    if (relative.includes('\0') || relative.includes('..')) {
      throw new ApiError(400, 'Bad path.');
    }
    if (relative === '/') relative = '/index.html';
    const filePath = path.join(PUBLIC_DIR, relative);
    if (!filePath.startsWith(PUBLIC_DIR)) throw new ApiError(400, 'Bad path.');
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      throw new ApiError(404, 'Not found.');
    }
    if (!stat.isFile()) throw new ApiError(404, 'Not found.');
    const ext = path.extname(filePath).toLowerCase();
    const headers = {
      ...securityHeaders(),
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control':
        ext === '.html'
          ? 'no-store'
          : ext === '.js' || ext === '.css'
            ? 'no-cache'
            : 'public, max-age=300',
    };
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath).pipe(res);
  }

  async function dispatch(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
    return serveStatic(req, res, url.pathname);
  }

  const server = http.createServer((req, res) => {
    Promise.resolve(dispatch(req, res)).catch((error) => {
      if (res.headersSent) {
        try {
          res.end();
        } catch {
          /* ignore */
        }
        return;
      }
      const status = error instanceof ApiError ? error.status : 500;
      if (status === 500) {
        console.error('[seven-stones]', error);
      }
      sendJson(res, status, { error: status === 500 ? 'Server error.' : error.message });
    });
  });

  function tick() {
    if (closed) return;
    try {
      const now = Date.now();
      rolloverIfNeeded(now);
      invitations.expireInvitations(db, now);
      const expired = db
        .prepare(
          `SELECT * FROM games
           WHERE status = 'active' AND mode = 'human'
             AND deadline IS NOT NULL AND deadline <= ?`
        )
        .all(now);
      for (const row of expired) {
        const winner =
          Number(row.turn) === Number(row.player_color)
            ? Number(row.opponent_color)
            : Number(row.player_color);
        finishGame(row.id, winner, 'timeout');
      }
      db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
    } catch (error) {
      console.error('[seven-stones] tick failed:', error);
    }
  }

  function boot() {
    const today = game.utcDate();
    if (!metaGet('season_anchor')) {
      metaSet('season_anchor', today);
      metaSet('last_settled_date', game.addDays(today, -1));
      metaSet('last_seen_date', today);
    } else {
      if (!metaGet('last_settled_date')) metaSet('last_settled_date', game.addDays(today, -1));
      if (!metaGet('last_seen_date')) metaSet('last_seen_date', today);
    }
    backfillInviteUnlocks();
    settleDailyThrough(game.addDays(today, -1));
    settleSeasons(today);
    tick();
    // Resume ranked games that were waiting on NOVA when the process stopped.
    const pendingAi = db
      .prepare("SELECT id, player_color, turn FROM games WHERE status = 'active' AND mode = 'ai' AND date = ?")
      .all(today);
    for (const row of pendingAi) {
      const aiColor = Number(row.player_color) === game.BLACK ? game.WHITE : game.BLACK;
      if (Number(row.turn) === aiColor) scheduleAi(Number(row.id));
    }
    timers.push(setInterval(tick, 1000));
  }

  function listen(port = 0, host = '127.0.0.1') {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.removeListener('error', reject);
        resolve(server.address());
      });
    });
  }

  function close() {
    if (closed) return Promise.resolve();
    closed = true;
    for (const timer of timers) clearInterval(timer);
    closeWorker();
    return new Promise((resolve) => {
      server.close(() => {
        try {
          db.close();
        } catch {
          /* ignore */
        }
        resolve();
      });
      setTimeout(resolve, 1500).unref();
    });
  }

  return { db, server, tick, boot, listen, close, buildState };
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL COLLATE NOCASE UNIQUE,
      salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS google_identities (
      sub TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL UNIQUE,
      email TEXT,
      name TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS google_challenges (
      nonce TEXT PRIMARY KEY,
      session_hash TEXT,
      expires_at INTEGER NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS games (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mode TEXT NOT NULL,
      board TEXT NOT NULL,
      player_id INTEGER NOT NULL,
      opponent_id INTEGER,
      stake INTEGER NOT NULL,
      player_color INTEGER NOT NULL,
      opponent_color INTEGER,
      status TEXT NOT NULL DEFAULT 'active',
      result TEXT,
      end_reason TEXT,
      qualifies INTEGER NOT NULL DEFAULT 0,
      turn INTEGER,
      deadline INTEGER,
      date TEXT NOT NULL,
      season_start TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (player_id) REFERENCES users(id),
      FOREIGN KEY (opponent_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS games_active_idx ON games(status, mode, date);
    CREATE INDEX IF NOT EXISTS games_player_idx ON games(player_id, date);
    CREATE TABLE IF NOT EXISTS ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      mode TEXT NOT NULL,
      stake INTEGER NOT NULL,
      result TEXT NOT NULL,
      net INTEGER NOT NULL,
      qualifies INTEGER NOT NULL DEFAULT 0,
      date TEXT NOT NULL,
      season_start TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (game_id, user_id),
      FOREIGN KEY (game_id) REFERENCES games(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS ledger_user_date_idx ON ledger(user_id, date);
    CREATE INDEX IF NOT EXISTS ledger_date_idx ON ledger(date, mode);
    CREATE TABLE IF NOT EXISTS announcements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      period TEXT NOT NULL,
      title TEXT NOT NULL,
      winners TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (kind, period)
    );
    CREATE TABLE IF NOT EXISTS presence (
      user_id INTEGER PRIMARY KEY,
      last_seen INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS invitations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_id INTEGER NOT NULL,
      receiver_id INTEGER NOT NULL,
      stake INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      game_id INTEGER,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      responded_at INTEGER,
      FOREIGN KEY (sender_id) REFERENCES users(id),
      FOREIGN KEY (receiver_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS invitations_receiver_idx ON invitations(receiver_id, status);
    CREATE TABLE IF NOT EXISTS invite_unlocks (
      user_id INTEGER PRIMARY KEY,
      unlocked_at INTEGER NOT NULL,
      date TEXT NOT NULL,
      score INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS queue (
      user_id INTEGER PRIMARY KEY,
      stake INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);
}

async function startServer(options = {}) {
  const app = createApp(options);
  app.boot();
  const host = options.host || process.env.HOST || '0.0.0.0';
  const port = options.port !== undefined ? options.port : Number(process.env.PORT || 8787);
  const address = await app.listen(port, host);
  return {
    app,
    server: app.server,
    port: address.port,
    host: address.address,
    close: () => app.close(),
  };
}

if (require.main === module) {
  startServer()
    .then(({ port }) => {
      console.log(`Seven Stones running at http://localhost:${port}`);
      console.log(`Database: ${process.env.DB_PATH || path.join(__dirname, 'data', 'league.sqlite')}`);
      if (process.env.COOKIE_SECURE !== '1') {
        console.log('COOKIE_SECURE is off (use 1 behind HTTPS in production).');
      }
    })
    .catch((error) => {
      console.error('Failed to start Seven Stones:', error);
      process.exitCode = 1;
    });
}

module.exports = { createApp, startServer, migrate, ApiError };
