'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const game = require('../game.cjs');
const RULES = require('../public/rules.js');
const NOVA = require('../public/engine.js');
const { startServer } = require('../server.cjs');

function fillBoard(values) {
  const board = new Array(225).fill(0);
  for (const [x, y, color] of values) board[game.indexOf(x, y)] = color;
  return board;
}

test('rules: stakes unlock at 0, 3, 5, 7 and 10 qualifying games', () => {
  assert.deepEqual(RULES.allowedStakes(0), [25, 50]);
  assert.deepEqual(RULES.allowedStakes(2), [25, 50]);
  assert.deepEqual(RULES.allowedStakes(3), [25, 50, 100]);
  assert.deepEqual(RULES.allowedStakes(5), [25, 50, 100, 200]);
  assert.deepEqual(RULES.allowedStakes(7), [25, 50, 100, 200, 300]);
  assert.deepEqual(RULES.allowedStakes(10), [25, 50, 100, 200, 300, 500]);
  assert.equal(RULES.canStake(100, 2), false);
  assert.equal(RULES.canStake(100, 3), true);
  assert.equal(RULES.canStake(500, 9), false);
  assert.equal(RULES.canStake(500, 10), true);
  assert.deepEqual(RULES.nextTier(0), { completed: 3, remaining: 3, stakes: [100] });
  assert.deepEqual(RULES.nextTier(4), { completed: 5, remaining: 1, stakes: [200] });
  assert.equal(RULES.nextTier(10), null);
});

test('game: five in a row wins in every direction, including overlines', () => {
  const horizontal = fillBoard([
    [3, 7, 1],
    [4, 7, 1],
    [5, 7, 1],
    [6, 7, 1],
    [7, 7, 1],
  ]);
  assert.ok(game.findWinningLine(horizontal, game.indexOf(5, 7), 1));
  assert.deepEqual(game.findWinningLine(horizontal, game.indexOf(5, 7), 1).length, 5);

  const vertical = fillBoard([
    [7, 3, 2],
    [7, 4, 2],
    [7, 5, 2],
    [7, 6, 2],
    [7, 7, 2],
  ]);
  assert.ok(game.findWinningLine(vertical, game.indexOf(7, 7), 2));

  const diagonal = fillBoard([
    [2, 2, 1],
    [3, 3, 1],
    [4, 4, 1],
    [5, 5, 1],
    [6, 6, 1],
  ]);
  assert.ok(game.findWinningLine(diagonal, game.indexOf(4, 4), 1));

  const antiDiagonal = fillBoard([
    [2, 8, 2],
    [3, 7, 2],
    [4, 6, 2],
    [5, 5, 2],
    [6, 4, 2],
  ]);
  assert.ok(game.findWinningLine(antiDiagonal, game.indexOf(4, 6), 2));

  const overline = fillBoard([
    [1, 1, 1],
    [2, 1, 1],
    [3, 1, 1],
    [4, 1, 1],
    [5, 1, 1],
    [6, 1, 1],
  ]);
  assert.equal(game.findWinningLine(overline, game.indexOf(3, 1), 1).length, 6);

  const four = fillBoard([
    [3, 7, 1],
    [4, 7, 1],
    [5, 7, 1],
    [6, 7, 1],
  ]);
  assert.equal(game.findWinningLine(four, game.indexOf(5, 7), 1), null);
});

test('game: board full detection and board parsing', () => {
  assert.equal(game.isBoardFull(new Array(225).fill(1)), true);
  const board = new Array(225).fill(0);
  board[0] = 1;
  assert.equal(game.isBoardFull(board), false);
  assert.deepEqual(game.boardFromJSON(JSON.stringify([0, 1, 2])), [0, 1, 2]);
  assert.equal(game.boardFromJSON('not json').length, 225);
});

test('game: ranking contract is net, wins, losses, then name', () => {
  const rows = [
    { name: 'Zoe', net: 100, wins: 4, losses: 1 },
    { name: 'Amy', net: 100, wins: 4, losses: 1 },
    { name: 'Bob', net: 100, wins: 5, losses: 1 },
    { name: 'Cara', net: 100, wins: 4, losses: 0 },
    { name: 'Drew', net: 150, wins: 1, losses: 3 },
  ];
  const ranked = game.rankEntries(rows);
  assert.deepEqual(
    ranked.map((row) => row.name),
    ['Drew', 'Bob', 'Cara', 'Amy', 'Zoe']
  );
  assert.deepEqual(
    ranked.map((row) => row.rank),
    [1, 2, 3, 4, 5]
  );
});

test('game: UTC dates and seven-day seasons', () => {
  assert.equal(game.addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(game.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(game.addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(game.daysBetween('2026-11-01', '2026-11-08'), 7);
  assert.equal(game.seasonStartFor('2026-11-01', '2026-11-01'), '2026-11-01');
  assert.equal(game.seasonStartFor('2026-11-01', '2026-11-07'), '2026-11-01');
  assert.equal(game.seasonStartFor('2026-11-01', '2026-11-08'), '2026-11-08');
  assert.equal(game.seasonNumber('2026-11-01', '2026-11-08'), 2);
  assert.equal(game.seasonEndFor('2026-11-01'), '2026-11-07');
  assert.equal(game.daysLeftInSeason('2026-11-01', '2026-11-01'), 6);
  assert.equal(game.daysLeftInSeason('2026-11-01', '2026-11-07'), 0);
  assert.equal(game.utcDate(Date.UTC(2026, 10, 1, 23, 59, 59)), '2026-11-01');
  assert.equal(game.utcDate(Date.UTC(2026, 10, 2, 0, 0, 1)), '2026-11-02');
});

test('NOVA: opens in the centre, takes wins and blocks a single immediate threat', () => {
  const empty = new Array(225).fill(0);
  assert.equal(NOVA.chooseMove(empty, 1, 'advanced'), game.indexOf(7, 7));

  const win = fillBoard([
    [4, 7, 2],
    [5, 7, 2],
    [6, 7, 2],
    [7, 7, 2],
    [3, 7, 1],
  ]);
  assert.equal(NOVA.chooseMove(win, 2, 'advanced'), game.indexOf(8, 7));

  const block = fillBoard([
    [4, 7, 1],
    [5, 7, 1],
    [6, 7, 1],
    [7, 7, 1],
    [3, 7, 2],
    [3, 3, 2],
  ]);
  assert.equal(NOVA.chooseMove(block, 2, 'advanced'), game.indexOf(8, 7));
});

test('NOVA: all levels return a legal empty point', () => {
  const board = fillBoard([
    [7, 7, 1],
    [7, 8, 2],
    [8, 7, 2],
    [6, 6, 1],
  ]);
  for (const level of ['standard', 'advanced']) {
    for (const color of [1, 2]) {
      const move = NOVA.chooseMove(board, color, level);
      assert.ok(Number.isInteger(move));
      assert.equal(board[move], 0);
    }
  }
});

// ---------------------------------------------------------------- server

function uniqueName(prefix) {
  return `${prefix}${Math.random().toString(36).slice(2, 8)}`;
}

async function request(base, method, pathname, body, cookie) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  const setCookie = response.headers.getSetCookie ? response.headers.getSetCookie()[0] : null;
  return {
    status: response.status,
    payload,
    cookie: setCookie ? setCookie.split(';')[0] : null,
  };
}

async function waitFor(check, timeout = 12000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('Timed out waiting for condition.');
}

test('server: accounts, ranked AI, resignations, human settlement, unlocks and invitations', { timeout: 90000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seven-stones-test-'));
  const dbPath = path.join(dir, 'league.sqlite');
  let running = await startServer({
    dbPath,
    port: 0,
    host: '127.0.0.1',
    googleClientId: '',
    cookieSecure: false,
  });
  let base = `http://127.0.0.1:${running.port}`;
  t.after(async () => {
    await running.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const aliceName = uniqueName('Alice');
  const bobName = uniqueName('Bob');
  const password = 'correct-horse-1';

  const health = await request(base, 'GET', '/api/health');
  assert.equal(health.status, 200);
  assert.deepEqual(health.payload, { ok: true, app: 'seven-stones' });

  const google = await request(base, 'GET', '/api/google/challenge');
  assert.equal(google.status, 404);

  const alice = await request(base, 'POST', '/api/register', { name: aliceName, password });
  assert.equal(alice.status, 201);
  assert.ok(alice.cookie);
  const bob = await request(base, 'POST', '/api/register', { name: bobName, password });
  assert.equal(bob.status, 201);
  assert.ok(bob.cookie);
  const bobInitial = await request(base, 'GET', '/api/state', undefined, bob.cookie);
  const bobId = bobInitial.payload.me.id;
  assert.ok(Number.isInteger(bobId));

  const duplicate = await request(base, 'POST', '/api/register', { name: aliceName, password });
  assert.equal(duplicate.status, 409);

  const wrong = await request(base, 'POST', '/api/login', { name: aliceName, password: 'wrong-password' });
  assert.equal(wrong.status, 401);

  const initial = await request(base, 'GET', '/api/state', undefined, alice.cookie);
  assert.equal(initial.status, 200);
  assert.equal(initial.payload.me.wallet, 300);
  assert.equal(initial.payload.me.net, 0);
  assert.equal(initial.payload.me.used, 0);
  assert.equal(initial.payload.me.completed, 0);
  assert.equal(initial.payload.me.inviteScore, 300);
  assert.equal(initial.payload.me.inviteUnlocked, false);
  assert.deepEqual(initial.payload.me.allowedStakes, [25, 50]);
  assert.equal(initial.payload.game, null);

  const badStake = await request(base, 'POST', '/api/start-ai', { stake: 999 }, alice.cookie);
  assert.equal(badStake.status, 400);
  const lockedStake = await request(base, 'POST', '/api/start-ai', { stake: 100 }, alice.cookie);
  assert.equal(lockedStake.status, 403);

  const started = await request(base, 'POST', '/api/start-ai', { stake: 25 }, alice.cookie);
  assert.equal(started.status, 201);
  assert.equal(started.payload.game.stake, 25);

  let afterStart = await request(base, 'GET', '/api/state', undefined, alice.cookie);
  assert.equal(afterStart.payload.me.wallet, 275);
  assert.equal(afterStart.payload.game.status, 'active');
  const playerColor = afterStart.payload.game.yourColor;

  // A live game blocks logout.
  const blockedLogout = await request(base, 'POST', '/api/logout', {}, alice.cookie);
  assert.equal(blockedLogout.status, 409);

  if (afterStart.payload.game.turn !== playerColor) {
    await waitFor(async () => {
      const state = await request(base, 'GET', '/api/state', undefined, alice.cookie);
      return state.payload.game && state.payload.game.turn === playerColor ? state : null;
    });
    afterStart = await request(base, 'GET', '/api/state', undefined, alice.cookie);
  }
  const firstBoard = afterStart.payload.game.board;
  const moveIndex = firstBoard[112] === 0 ? 112 : 113;
  const firstMove = await request(
    base,
    'POST',
    '/api/move',
    { game: afterStart.payload.game.id, index: moveIndex, revision: afterStart.payload.game.revision },
    alice.cookie
  );
  assert.equal(firstMove.status, 200);

  if (firstMove.payload.game && firstMove.payload.game.status === 'active') {
    await waitFor(async () => {
      const state = await request(base, 'GET', '/api/state', undefined, alice.cookie);
      const active = state.payload.game;
      if (!active || active.status !== 'active') return null;
      return active.turn === active.yourColor && active.revision > firstMove.payload.game.revision
        ? state
        : null;
    });
  }

  const resign = await request(
    base,
    'POST',
    '/api/resign',
    { game: started.payload.game.id },
    alice.cookie
  );
  assert.equal(resign.status, 200);

  const afterResign = await request(base, 'GET', '/api/state', undefined, alice.cookie);
  assert.equal(afterResign.payload.game, null);
  assert.equal(afterResign.payload.lastGame.result, 'loss');
  assert.equal(afterResign.payload.lastGame.endReason, 'resign');
  assert.equal(afterResign.payload.me.wallet, 275);
  assert.equal(afterResign.payload.me.completed, 0);
  assert.equal(afterResign.payload.me.used, 1);
  assert.equal(afterResign.payload.me.inviteScore, 275);
  assert.equal(afterResign.payload.history[0].result, 'loss');
  assert.equal(afterResign.payload.history[0].net, -25);

  const inviteBlocked = await request(
    base,
    'POST',
    '/api/invite',
    { player: bobId, stake: 25 },
    alice.cookie
  );
  assert.equal(inviteBlocked.status, 403);

  // Logout then login again; the session must be server-issued only.
  const logout = await request(base, 'POST', '/api/logout', {}, alice.cookie);
  assert.equal(logout.status, 200);
  const loggedOut = await request(base, 'GET', '/api/state', undefined, alice.cookie);
  assert.equal(loggedOut.payload.me, null);
  const login = await request(base, 'POST', '/api/login', { name: aliceName, password });
  assert.equal(login.status, 200);
  assert.ok(login.cookie);

  const db = running.app.db;
  const today = game.utcDate();
  const anchor = db.prepare("SELECT value FROM meta WHERE key = 'season_anchor'").get().value;
  const seasonStart = game.seasonStartFor(anchor, today);
  const now = Date.now();

  // Fixture: a human game where Alice (black) already has four in a row.
  const humanBoard = new Array(225).fill(0);
  for (let x = 3; x <= 6; x += 1) humanBoard[game.indexOf(x, 7)] = 1;
  const humanInsert = db
    .prepare(
      `INSERT INTO games
         (mode, board, player_id, opponent_id, stake, player_color, opponent_color,
          status, result, end_reason, qualifies, turn, deadline, date, season_start,
          revision, created_at, updated_at)
       VALUES ('human', ?, ?, ?, 25, 1, 2, 'active', NULL, NULL, 0, 1, ?, ?, ?, 0, ?, ?)`
    )
    .run(
      JSON.stringify(humanBoard),
      initial.payload.me.id,
      bobId,
      now + 90000,
      today,
      seasonStart,
      now,
      now
    );
  const humanGameId = Number(humanInsert.lastInsertRowid);

  const humanMove = await request(
    base,
    'POST',
    '/api/move',
    { game: humanGameId, index: game.indexOf(7, 7), revision: 0 },
    login.cookie
  );
  assert.equal(humanMove.status, 200);
  assert.equal(humanMove.payload.game.status, 'finished');
  assert.equal(humanMove.payload.winningLine.length, 5);

  const aliceAfterHuman = await request(base, 'GET', '/api/state', undefined, login.cookie);
  assert.equal(aliceAfterHuman.payload.me.wallet, 300);
  assert.equal(aliceAfterHuman.payload.me.net, -25);
  assert.equal(aliceAfterHuman.payload.lastGame.result, 'win');
  assert.equal(aliceAfterHuman.payload.lastGame.mode, 'human');
  assert.equal(aliceAfterHuman.payload.history[0].mode, 'human');
  assert.equal(aliceAfterHuman.payload.history[0].net, 25);

  const bobAfterHuman = await request(base, 'GET', '/api/state', undefined, bob.cookie);
  assert.equal(bobAfterHuman.payload.me.wallet, 275);
  assert.equal(bobAfterHuman.payload.history[0].result, 'loss');
  assert.equal(bobAfterHuman.payload.history[0].net, -25);

  // Human games must not appear on the ranked AI leaderboard.
  assert.equal(
    aliceAfterHuman.payload.leaderboard.today.some((row) => row.id === bobId),
    false
  );
  const aliceLeaderRow = aliceAfterHuman.payload.leaderboard.today.find(
    (row) => row.id === initial.payload.me.id
  );
  assert.equal(aliceLeaderRow.net, -25);
  assert.equal(aliceLeaderRow.games, 1);

  // Fixture: one settled ranked AI win for Bob (top-three target) and a big
  // AI day for Alice, so the restart backfill must grant her invitation unlock.
  function insertAiResult(userId, net) {
    const board = new Array(225).fill(0);
    const inserted = db
      .prepare(
        `INSERT INTO games
           (mode, board, player_id, opponent_id, stake, player_color, opponent_color,
            status, result, end_reason, qualifies, turn, deadline, date, season_start,
            revision, created_at, updated_at)
         VALUES ('ai', ?, ?, NULL, 25, 1, NULL, 'finished', 'black', 'five', 1, NULL, NULL, ?, ?, 1, ?, ?)`
      )
      .run(JSON.stringify(board), userId, today, seasonStart, now, now);
    db.prepare(
      `INSERT INTO ledger
         (game_id, user_id, mode, stake, result, net, qualifies, date, season_start, created_at)
       VALUES (?, ?, 'ai', 25, 'win', ?, 1, ?, ?, ?)`
    ).run(Number(inserted.lastInsertRowid), userId, net, today, seasonStart, now);
  }
  insertAiResult(bobId, 700);
  insertAiResult(initial.payload.me.id, 750);

  const beforeRestart = await request(base, 'GET', '/api/state', undefined, bob.cookie);
  assert.equal(beforeRestart.payload.leaderboard.today[0].name, aliceName);
  assert.equal(beforeRestart.payload.leaderboard.today[0].net, 725);
  const bobLeaderRow = beforeRestart.payload.leaderboard.today.find((row) => row.id === bobId);
  assert.equal(bobLeaderRow.rank, 2);
  assert.equal(bobLeaderRow.net, 700);

  await running.close();
  running = await startServer({
    dbPath,
    port: 0,
    host: '127.0.0.1',
    googleClientId: '',
    cookieSecure: false,
  });
  base = `http://127.0.0.1:${running.port}`;

  // Sessions survive restart; same cookie still works.
  const aliceUnlocked = await request(base, 'GET', '/api/state', undefined, login.cookie);
  assert.equal(aliceUnlocked.status, 200);
  assert.equal(aliceUnlocked.payload.me.inviteUnlocked, true);
  assert.equal(aliceUnlocked.payload.me.inviteScore, 1025);

  const bobOnline = await request(base, 'GET', '/api/state', undefined, bob.cookie);
  assert.equal(bobOnline.payload.me.inviteScore, 1000);
  const bobRankedOnline = bobOnline.payload.leaderboard.today.find((row) => row.id === bobId);
  assert.equal(bobRankedOnline.online, true);

  const invite = await request(
    base,
    'POST',
    '/api/invite',
    { player: bobId, stake: 25 },
    login.cookie
  );
  assert.equal(invite.status, 201);

  const aliceSent = await request(base, 'GET', '/api/state', undefined, login.cookie);
  assert.equal(aliceSent.payload.invitations.sent.length, 1);
  assert.equal(aliceSent.payload.invitations.sent[0].receiver.name, bobName);

  const bobReceived = await request(base, 'GET', '/api/state', undefined, bob.cookie);
  assert.equal(bobReceived.payload.invitations.received.length, 1);

  // The sender must not be able to accept on the receiver's behalf.
  const senderAccept = await request(
    base,
    'POST',
    '/api/invite-accept',
    { id: bobReceived.payload.invitations.received[0].id },
    login.cookie
  );
  assert.equal(senderAccept.status, 403);

  const accept = await request(
    base,
    'POST',
    '/api/invite-accept',
    { id: bobReceived.payload.invitations.received[0].id },
    bob.cookie
  );
  assert.equal(accept.status, 201);
  assert.equal(accept.payload.game.mode, 'human');
  assert.equal(accept.payload.game.stake, 25);

  const bobGame = await request(base, 'GET', '/api/state', undefined, bob.cookie);
  assert.equal(bobGame.payload.game.status, 'active');
  assert.equal(bobGame.payload.game.opponent.name, aliceName);
  assert.equal(bobGame.payload.me.wallet, 950);
  const aliceGame = await request(base, 'GET', '/api/state', undefined, login.cookie);
  assert.equal(aliceGame.payload.game.status, 'active');
  assert.equal(aliceGame.payload.me.wallet, 1025);
  assert.equal(aliceGame.payload.me.inviteUnlocked, true);

  const resignDuel = await request(
    base,
    'POST',
    '/api/resign',
    { game: bobGame.payload.game.id },
    login.cookie
  );
  assert.equal(resignDuel.status, 200);

  const bobWon = await request(base, 'GET', '/api/state', undefined, bob.cookie);
  assert.equal(bobWon.payload.me.wallet, 1000);
  assert.equal(bobWon.payload.history[0].mode, 'human');
  assert.equal(bobWon.payload.history[0].result, 'win');
  assert.equal(
    bobWon.payload.leaderboard.today.find((row) => row.id === bobId).net,
    700
  );

  const aliceLost = await request(base, 'GET', '/api/state', undefined, login.cookie);
  assert.equal(aliceLost.payload.me.wallet, 1025);
  assert.equal(aliceLost.payload.history[0].mode, 'human');
  assert.equal(aliceLost.payload.history[0].result, 'loss');
});

test('server: restart resumes a ranked game waiting on NOVA', { timeout: 60000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seven-stones-resume-test-'));
  const dbPath = path.join(dir, 'league.sqlite');
  const options = { dbPath, port: 0, host: '127.0.0.1', googleClientId: '', cookieSecure: false };
  let running = await startServer(options);
  let base = `http://127.0.0.1:${running.port}`;
  t.after(async () => {
    await running.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const name = uniqueName('Resume');
  const account = await request(base, 'POST', '/api/register', { name, password: 'correct-horse-3' });
  assert.ok(account.cookie);
  const initial = await request(base, 'GET', '/api/state', undefined, account.cookie);
  const userId = initial.payload.me.id;
  const today = initial.payload.today;
  const seasonStart = initial.payload.me.season.start;
  const board = game.createBoard();
  board[game.indexOf(7, 7)] = game.BLACK;
  const now = Date.now();
  const inserted = running.app.db
    .prepare(
      `INSERT INTO games
         (mode, board, player_id, opponent_id, stake, player_color, opponent_color,
          status, result, end_reason, qualifies, turn, deadline, date, season_start,
          revision, created_at, updated_at)
       VALUES ('ai', ?, ?, NULL, 25, 1, NULL, 'active', NULL, NULL, 0, 2, NULL, ?, ?, 1, ?, ?)`
    )
    .run(JSON.stringify(board), userId, today, seasonStart, now, now);
  assert.ok(Number(inserted.lastInsertRowid) > 0);

  await running.close();
  running = await startServer(options);
  base = `http://127.0.0.1:${running.port}`;

  const resumed = await waitFor(async () => {
    const state = await request(base, 'GET', '/api/state', undefined, account.cookie);
    const current = state.payload.game;
    if (!current || current.status !== 'active') return null;
    return current.board.filter((value) => value === game.WHITE).length === 1 ? current : null;
  });
  assert.equal(resumed.turn, game.BLACK);
  assert.equal(resumed.revision, 3);
});

test('server: midnight rollover settles daily top three and archives a seven-day season', { timeout: 60000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seven-stones-season-test-'));
  const dbPath = path.join(dir, 'league.sqlite');
  const options = { dbPath, port: 0, host: '127.0.0.1', googleClientId: '', cookieSecure: false };
  let running = await startServer(options);
  let base = `http://127.0.0.1:${running.port}`;
  t.after(async () => {
    await running.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const today = game.utcDate();
  const anchor = game.addDays(today, -8);
  const aliceName = uniqueName('Dana');
  const bobName = uniqueName('Evan');
  const password = 'correct-horse-2';
  const alice = await request(base, 'POST', '/api/register', { name: aliceName, password });
  const bob = await request(base, 'POST', '/api/register', { name: bobName, password });
  assert.ok(alice.cookie);
  assert.ok(bob.cookie);
  const aliceId = (await request(base, 'GET', '/api/state', undefined, alice.cookie)).payload.me.id;
  const bobId = (await request(base, 'GET', '/api/state', undefined, bob.cookie)).payload.me.id;

  const db = running.app.db;
  const now = Date.now();

  function insertPastAiResult(userId, date, net) {
    const inserted = db
      .prepare(
        `INSERT INTO games
           (mode, board, player_id, opponent_id, stake, player_color, opponent_color,
            status, result, end_reason, qualifies, turn, deadline, date, season_start,
            revision, created_at, updated_at)
         VALUES ('ai', ?, ?, NULL, 25, 1, NULL, 'finished', 'black', 'five', 1,
                 NULL, NULL, ?, ?, 1, ?, ?)`
      )
      .run(
        JSON.stringify(new Array(225).fill(0)),
        userId,
        date,
        game.seasonStartFor(anchor, date),
        now,
        now
      );
    db.prepare(
      `INSERT INTO ledger
         (game_id, user_id, mode, stake, result, net, qualifies, date, season_start, created_at)
       VALUES (?, ?, 'ai', 25, 'win', ?, 1, ?, ?, ?)`
    ).run(
      Number(inserted.lastInsertRowid),
      userId,
      net,
      date,
      game.seasonStartFor(anchor, date),
      now
    );
  }

  insertPastAiResult(bobId, game.addDays(anchor, 1), 200);
  insertPastAiResult(aliceId, game.addDays(anchor, 2), 100);

  db.prepare("UPDATE meta SET value = ? WHERE key = 'season_anchor'").run(anchor);
  db.prepare("UPDATE meta SET value = ? WHERE key = 'last_settled_date'").run(anchor);
  db.prepare("UPDATE meta SET value = ? WHERE key = 'last_seen_date'").run(game.addDays(today, -1));
  db.prepare('DELETE FROM announcements').run();

  await running.close();
  running = await startServer(options);
  base = `http://127.0.0.1:${running.port}`;

  const state = await request(base, 'GET', '/api/state', undefined, alice.cookie);
  assert.equal(state.status, 200);
  assert.equal(state.payload.server.season.anchor, anchor);
  assert.equal(state.payload.server.season.start, game.addDays(anchor, 7));

  const daily = state.payload.announcements.daily;
  assert.equal(daily.length, 2, 'empty days must not invent a champion');
  assert.equal(daily[0].period, game.addDays(anchor, 2));
  assert.equal(daily[0].winners[0].name, aliceName);
  assert.equal(daily[1].period, game.addDays(anchor, 1));
  assert.equal(daily[1].winners[0].name, bobName);

  const archived = state.payload.announcements.season.find((row) => row.period === anchor);
  assert.ok(archived, 'completed season should be archived');
  assert.equal(archived.winners[0].name, bobName);
  assert.equal(archived.winners[0].net, 200);
  assert.equal(archived.winners[1].name, aliceName);

  const lastSettled = running.app.db
    .prepare("SELECT value FROM meta WHERE key = 'last_settled_date'")
    .get().value;
  assert.equal(lastSettled, game.addDays(today, -1));
});
