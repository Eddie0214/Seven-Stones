'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const LETTERS = 'ABCDEFGHIJKLMNO'.split('');
  const ALL_STAKES = [25, 50, 100, 200, 300, 500];
  const PRACTICE_KEY = 'sevenStones.practiceHistory.v1';
  const LARGER_KEY = 'sevenStones.largerBoard';
  const MAX_HISTORY = 20;

  const state = {
    data: null,
    tab: 'play',
    activeStake: 25,
    practiceLevel: 'advanced',
    practice: null,
    leaderboardMode: 'today',
    larger: false,
    busy: false,
    initialized: false,
    lastGameId: null,
    authMode: 'login',
    challengeTarget: null,
    challengeStake: 25,
    googleNonce: null,
    clockOffset: 0,
    connectionLost: false,
  };

  let googleScriptPromise = null;
  let boardCells = [];

  document.addEventListener('DOMContentLoaded', init);

  function init() {
    buildBoard();
    bindEvents();
    render();
    refresh();
    setInterval(refresh, 1500);
    setInterval(updateClock, 250);
  }

  // ------------------------------------------------------------- board

  function buildBoard() {
    const labelsX = $('labelsX');
    const labelsY = $('labelsY');
    const board = $('board');
    labelsX.innerHTML = '';
    labelsY.innerHTML = '';
    board.innerHTML = '';
    boardCells = [];

    for (const letter of LETTERS) {
      const span = document.createElement('span');
      span.textContent = letter;
      labelsX.appendChild(span);
    }
    for (let row = 1; row <= 15; row += 1) {
      const span = document.createElement('span');
      span.textContent = String(row);
      labelsY.appendChild(span);
    }

    let rowElement = null;
    for (let i = 0; i < 225; i += 1) {
      if (i % 15 === 0) {
        rowElement = document.createElement('div');
        rowElement.className = 'board-row';
        rowElement.setAttribute('role', 'row');
        board.appendChild(rowElement);
      }
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'cell';
      cell.dataset.index = String(i);
      cell.setAttribute('role', 'gridcell');
      cell.setAttribute('aria-label', cellLabel(i, 0));
      const stone = document.createElement('span');
      stone.className = 'stone';
      stone.hidden = true;
      cell.appendChild(stone);
      rowElement.appendChild(cell);
      boardCells.push(cell);
    }
  }

  function cellLabel(index, value) {
    const name = `${LETTERS[index % 15]}${Math.floor(index / 15) + 1}`;
    if (!value) return `${name}, empty`;
    return `${name}, ${value === 1 ? 'black' : 'white'}`;
  }

  function paintBoard(board, options = {}) {
    const winSet = new Set(options.winningLine || []);
    for (let i = 0; i < 225; i += 1) {
      const cell = boardCells[i];
      if (!cell) continue;
      const stone = cell.firstElementChild;
      const value = board[i] || 0;
      if (value) {
        stone.hidden = false;
        stone.className = `stone ${value === 1 ? 'black' : 'white'}`;
        cell.classList.add('occupied');
      } else {
        stone.hidden = true;
        stone.className = 'stone';
        cell.classList.remove('occupied');
      }
      cell.classList.toggle('win', winSet.has(i));
      cell.setAttribute('aria-label', cellLabel(i, value));
    }
    $('board').classList.toggle('disabled', !options.interactive);
  }

  // -------------------------------------------------------------- api

  async function api(path, options = {}) {
    const response = await fetch(path, {
      method: options.method || 'GET',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      credentials: 'same-origin',
      cache: 'no-store',
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok) {
      throw new Error((payload && payload.error) || `Request failed (${response.status}).`);
    }
    return payload || {};
  }

  async function refresh() {
    try {
      const data = await api('/api/state');
      state.data = data;
      state.clockOffset = Number(data.now) - Date.now();
      if (state.connectionLost) {
        state.connectionLost = false;
        toast('Connection restored.');
      }
      if (state.practice && data.game) {
        state.practice = null;
        toast('Practice ended — a live game is waiting.', 'gold');
      }
      observeLastGame(data);
      render();
    } catch (error) {
      if (!state.connectionLost) {
        state.connectionLost = true;
        toast('Cannot reach the server. Retrying…', 'loss');
      }
    }
  }

  function observeLastGame(data) {
    const id = data.lastGame ? Number(data.lastGame.id) : null;
    if (!state.initialized) {
      state.initialized = true;
      state.lastGameId = id;
      return;
    }
    if (id && id !== state.lastGameId) {
      state.lastGameId = id;
      announceResult(data.lastGame);
    }
    if (!id) state.lastGameId = null;
  }

  function announceResult(lastGame) {
    if (!lastGame) return;
    const stake = Number(lastGame.stake) || 0;
    if (lastGame.endReason === 'midnight') {
      toast('Your game crossed 00:00 UTC. The stake was returned.', 'gold');
      return;
    }
    if (lastGame.endReason === 'error') {
      toast('NOVA hit an error. The stake was returned.', 'gold');
      return;
    }
    if (lastGame.result === 'win') {
      toast(`You won +${stake} chips${lastGame.mode === 'ai' ? ' vs NOVA' : ` vs ${lastGame.opponent.name}`}.`, 'win');
    } else if (lastGame.result === 'loss') {
      toast(`You lost −${stake} chips${lastGame.mode === 'ai' ? ' vs NOVA' : ` vs ${lastGame.opponent.name}`}.`, 'loss');
    } else {
      toast('Draw. The stake was returned.', 'gold');
    }
  }

  // ----------------------------------------------------------- render

  function render() {
    renderHeader();
    renderWallet();
    renderStakes();
    renderProgress();
    renderGame();
    renderPractice();
    renderLeaderboard();
    renderHistory();
    renderInvitations();
    updateClock();
  }

  function renderHeader() {
    const me = state.data && state.data.me;
    $('accountLabel').textContent = me ? me.name : 'Sign in';
    $('accountButton').classList.toggle('signed-in', Boolean(me));
    const received = (state.data && state.data.invitations.received) || [];
    const badge = $('inviteBadge');
    if (received.length) {
      badge.hidden = false;
      badge.textContent = String(received.length);
    } else {
      badge.hidden = true;
    }
  }

  function renderWallet() {
    const me = state.data && state.data.me;
    const wallet = me ? Math.max(0, me.wallet) : 300;
    $('walletValue').textContent = String(wallet);
    $('netValue').textContent = me ? signed(me.net) : '0';
    $('usedValue').textContent = me ? String(me.used) : '0';

    const hint = $('rankedHint');
    const game = state.data && state.data.game;
    if (!me) {
      hint.textContent = 'Sign in to play ranked games and build a leaderboard score.';
    } else if (game) {
      hint.textContent = 'A game is in progress. Finish it before starting another.';
    } else if (me.wallet < 25) {
      hint.textContent =
        'Available balance is below 25. Practice, or return after 00:00 UTC for the 300-chip baseline.';
    } else if (me.nextTier) {
      hint.textContent = `${me.nextTier.remaining} more qualifying ranked game${
        me.nextTier.remaining === 1 ? '' : 's'
      } to unlock ${me.nextTier.stakes.join(' / ')}.`;
    } else {
      hint.textContent = 'All stakes unlocked for today.';
    }
  }

  function renderStakes() {
    const container = $('stakeList');
    const me = state.data && state.data.me;
    const allowed = me ? me.allowedStakes : [25, 50];
    if (!allowed.includes(state.activeStake)) {
      const affordable = allowed.find((stake) => !me || me.wallet >= stake);
      state.activeStake = affordable || allowed[0];
    }
    container.innerHTML = '';
    for (const stake of ALL_STAKES) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'stake';
      button.textContent = String(stake);
      button.dataset.stake = String(stake);
      button.setAttribute('aria-pressed', state.activeStake === stake ? 'true' : 'false');
      const locked = !allowed.includes(stake);
      if (locked) {
        button.classList.add('locked');
        button.disabled = true;
        button.title = 'Complete more ranked AI games to unlock this stake.';
      } else if (me && me.wallet < stake) {
        button.classList.add('unaffordable');
      }
      if (state.activeStake === stake) button.classList.add('selected');
      button.addEventListener('click', () => {
        if (locked) return;
        state.activeStake = stake;
        renderStakes();
        renderWallet();
      });
      container.appendChild(button);
    }

    const start = $('startAiBtn');
    const game = state.data && state.data.game;
    const canStart =
      Boolean(me) && !game && !state.busy && me.wallet >= state.activeStake && allowed.includes(state.activeStake);
    start.disabled = !canStart;
    start.textContent = !me
      ? 'Sign in to play ranked'
      : game
        ? 'Game in progress'
        : `Start ranked game · ${state.activeStake}`;
  }

  function renderProgress() {
    const me = state.data && state.data.me;
    const score = me ? Math.max(0, me.inviteScore) : 300;
    const target = (me && me.inviteTarget) || 1000;
    const unlocked = Boolean(me && me.inviteUnlocked);
    const percent = Math.max(0, Math.min(100, (score / target) * 100));
    $('inviteProgressBar').style.width = `${percent}%`;
    $('progressCard').classList.toggle('unlocked', unlocked);

    const text = $('inviteProgressText');
    if (unlocked) {
      text.textContent = 'LEADERBOARD INVITATIONS UNLOCKED';
    } else if (score >= target) {
      text.textContent = '1,000 points reached. Your seat is unlocked.';
    } else {
      const remaining = Math.max(0, target - score);
      text.textContent = `${score} / ${target} points · ${remaining} to go`;
    }

    const note = $('inviteUnlockNote');
    if (!me) {
      note.textContent = 'Sign in to track today’s score. The daily baseline is 300 points.';
    } else if (unlocked) {
      note.textContent = 'You earned your seat. Challenge the top three.';
    } else {
      const needed = Math.max(0, target - me.inviteScore);
      note.textContent = `Today's AI score is 300 + your settled AI net. Reach ${target} in any single UTC day to unlock invitations permanently. ${needed} points to go.`;
    }
  }

  function renderGame() {
    const data = state.data;
    const me = data && data.me;
    const game = data && data.game;
    const practice = state.practice;
    const badge = $('gameBadge');
    const title = $('gameTitle');
    const sub = $('gameSub');
    const banner = $('gameBanner');
    const resign = $('resignBtn');

    banner.hidden = true;
    banner.className = 'banner';
    resign.hidden = true;
    resign.textContent = 'Resign';

    if (practice) {
      badge.textContent = 'PRACTICE · LOCAL';
      badge.className = 'badge practice';
      const board = practice.board;
      let interactive = false;
      if (practice.over) {
        title.textContent = practice.result === 'win' ? 'Practice win' : practice.result === 'loss' ? 'Practice loss' : 'Practice draw';
        sub.textContent = `${practice.level === 'advanced' ? 'Advanced' : 'Standard'} NOVA · Saved on this device only`;
        banner.hidden = false;
        banner.className = `banner ${practice.result}`;
        if (practice.result === 'win') {
          banner.textContent = 'You completed five in a row. Practice does not affect the leaderboard.';
        } else if (practice.result === 'loss') {
          banner.textContent =
            practice.reason === 'resign'
              ? 'Practice ended. Nothing was staked.'
              : 'NOVA completed five in a row. Practice does not affect your ranked score.';
        } else {
          banner.textContent = 'The board is full. Practice draw.';
        }
      } else {
        title.textContent =
          practice.turn === 'player'
            ? 'Your move'
            : state.busy
              ? 'NOVA is thinking…'
              : 'NOVA is thinking…';
        sub.textContent = `${practice.level === 'advanced' ? 'Advanced' : 'Standard'} NOVA · You are Black · No sign-in required`;
        interactive = practice.turn === 'player' && !state.busy;
      }
      paintBoard(board, { interactive, winningLine: practice.winningLine });
      resign.hidden = practice.over;
      resign.textContent = 'End practice';
      return;
    }

    if (game) {
      const myTurn = game.status === 'active' && game.turn === game.yourColor;
      badge.textContent = game.mode === 'ai' ? 'RANKED · VS NOVA' : 'HUMAN DUEL';
      badge.className = `badge ${game.mode === 'ai' ? 'ranked' : 'human'}`;
      const color = game.yourColor === 1 ? 'Black' : 'White';
      if (game.mode === 'ai') {
        title.textContent = myTurn ? 'Your move' : game.thinking ? 'NOVA is thinking…' : 'NOVA’s move';
        sub.textContent = `Ranked · ${game.stake} chips · You are ${color}`;
      } else {
        title.textContent = myTurn ? `Your move vs ${game.opponent.name}` : `${game.opponent.name} is thinking…`;
        sub.textContent = `Human duel · ${game.stake} chips · You are ${color}`;
      }
      paintBoard(game.board, {
        interactive: myTurn && !state.busy,
        winningLine: game.winningLine,
      });
      resign.hidden = false;
      resign.textContent = 'Resign';
      return;
    }

    if (me && data.lastGame) {
      const last = data.lastGame;
      badge.textContent = last.mode === 'ai' ? 'RANKED · FINISHED' : 'HUMAN DUEL · FINISHED';
      badge.className = `badge ${last.mode === 'ai' ? 'ranked' : 'human'}`;
      title.textContent =
        last.result === 'win' ? 'Game won' : last.result === 'loss' ? 'Game lost' : 'Game drawn';
      sub.textContent = `${last.mode === 'ai' ? 'vs NOVA' : `vs ${last.opponent.name}`} · ${last.stake} chips`;
      banner.hidden = false;
      banner.className = `banner ${last.result || 'draw'}`;
      banner.textContent = resultBanner(last);
      paintBoard(last.board, { interactive: false, winningLine: last.winningLine });
    } else {
      badge.textContent = 'READY';
      badge.className = 'badge';
      title.textContent = 'Your move';
      sub.textContent = 'Five in a row wins. Black moves first.';
      paintBoard(new Array(225).fill(0), { interactive: false });
    }
  }

  function resultBanner(last) {
    if (last.endReason === 'midnight') {
      return 'This game crossed 00:00 UTC and was refunded as a draw. The stake returned to your balance.';
    }
    if (last.endReason === 'error') {
      return 'NOVA could not finish its move. The game was refunded as a draw.';
    }
    if (last.result === 'win') {
      return `You won +${last.stake} chips. ${reasonText(last.endReason)}`;
    }
    if (last.result === 'loss') {
      return `You lost −${last.stake} chips. ${reasonText(last.endReason)}`;
    }
    return `Draw. Your ${last.stake}-chip stake was returned. ${reasonText(last.endReason)}`;
  }

  function renderPractice() {
    const button = $('practiceBtn');
    const game = state.data && state.data.game;
    button.textContent = state.practice && !state.practice.over ? 'Restart practice' : 'Start practice';
    button.disabled = Boolean(game) || state.busy;
    const record = loadPracticeRecord();
    const wins = record.filter((item) => item.result === 'win').length;
    const losses = record.filter((item) => item.result === 'loss').length;
    const draws = record.filter((item) => item.result === 'draw').length;
    $('practiceRecord').textContent = record.length
      ? `On this device: ${wins}W · ${losses}L · ${draws}D`
      : 'On this device: no practice games yet.';
    document.querySelectorAll('#practiceLevel button').forEach((buttonEl) => {
      buttonEl.classList.toggle('active', buttonEl.dataset.level === state.practiceLevel);
    });
  }

  function renderLeaderboard() {
    const data = state.data;
    if (!data) return;
    const me = data.me;
    const mode = state.leaderboardMode;
    const rows = data.leaderboard[mode] || [];
    const season = data.server.season;
    $('seasonLine').textContent = `Season ${season.number} · ${season.start} → ${season.end} · ${
      season.daysLeft === 0 ? 'final day' : `${season.daysLeft} day${season.daysLeft === 1 ? '' : 's'} left`
    }`;
    document.querySelectorAll('#leaderboardMode button').forEach((button) => {
      button.classList.toggle('active', button.dataset.mode === mode);
    });

    const list = $('leaderboardList');
    list.innerHTML = '';
    if (!rows.length) {
      list.appendChild(
        element(
          'p',
          'empty',
          mode === 'today'
            ? 'No ranked AI games have been settled today. Be the first to beat NOVA.'
            : 'No ranked AI games in this season yet. The first result writes the table.'
        )
      );
    } else {
      for (const row of rows) {
        const rowEl = element('div', `leader-row${row.rank <= 3 ? ' top' : ''}`);
        rowEl.appendChild(element('div', 'leader-rank', `#${row.rank}`));

        const name = element('div', 'leader-name');
        const dot = element('span', `online-dot${row.online ? ' on' : ''}`);
        dot.title = row.online ? 'Online now' : 'Offline';
        name.appendChild(dot);
        name.appendChild(element('span', 'name-text', row.name));
        if (me && me.id === row.id) name.appendChild(element('span', 'you-tag', 'YOU'));
        rowEl.appendChild(name);

        const net = element('div', `leader-net${row.net > 0 ? ' positive' : row.net < 0 ? ' negative' : ''}`, signed(row.net));
        rowEl.appendChild(net);
        rowEl.appendChild(element('div', 'leader-record', `${row.wins}W · ${row.losses}L`));

        const challenge = element('button', 'ghost challenge-btn', 'Challenge');
        challenge.type = 'button';
        if (!me) {
          challenge.textContent = 'Challenge';
          challenge.title = 'Sign in and unlock invitations to challenge.';
        } else if (me.id === row.id) {
          challenge.textContent = 'You';
          challenge.disabled = true;
        } else if (!me.inviteUnlocked) {
          challenge.textContent = 'Locked';
          challenge.disabled = true;
          challenge.title = 'Reach 1,000 points in a day to unlock leaderboard invitations.';
        } else if (row.rank > 3) {
          challenge.textContent = 'Top 3';
          challenge.disabled = true;
          challenge.title = 'Only top-three players can be challenged.';
        }
        challenge.addEventListener('click', () => {
          if (!me) {
            openAuth();
            return;
          }
          if (challenge.disabled) {
            if (!me.inviteUnlocked) {
              toast('Reach 1,000 points in a day to unlock leaderboard invitations.', 'gold');
            } else if (row.rank > 3) {
              toast('Only a top-three player can be challenged.', 'gold');
            }
            return;
          }
          openChallenge(row);
        });
        rowEl.appendChild(challenge);
        list.appendChild(rowEl);
      }
    }

    renderAnnouncements(data);
  }

  function renderAnnouncements(data) {
    const dailyBox = $('dailyAnnouncement');
    const seasonBox = $('seasonAnnouncements');
    dailyBox.innerHTML = '';
    seasonBox.innerHTML = '';
    const daily = data.announcements.daily[0];
    if (!daily) {
      dailyBox.appendChild(element('p', 'empty', 'No ranked games were settled for the previous UTC day.'));
    } else {
      dailyBox.appendChild(element('p', 'micro', daily.title));
      for (const winner of daily.winners) {
        dailyBox.appendChild(archiveRow(winner));
      }
    }
    const seasons = data.announcements.season || [];
    if (!seasons.length) {
      seasonBox.appendChild(element('p', 'empty', 'No completed season yet. Seven days. One champion.'));
    } else {
      for (const archive of seasons) {
        seasonBox.appendChild(element('p', 'micro', archive.title));
        for (const winner of archive.winners) {
          seasonBox.appendChild(archiveRow(winner));
        }
      }
    }
  }

  function archiveRow(winner) {
    const row = element('div', 'archive-item');
    row.appendChild(element('span', 'archive-rank', `#${winner.rank}`));
    row.appendChild(element('span', 'archive-name', winner.name));
    row.appendChild(element('span', 'archive-net', `${signed(winner.net)} · ${winner.wins}W`));
    return row;
  }

  function renderHistory() {
    const data = state.data;
    if (!data) return;
    const serverHistory = (data.history || []).map((row) => ({ ...row, createdAt: Number(row.createdAt) }));
    const practice = loadPracticeRecord().map((row, index) => ({
      gameId: `practice-${index}`,
      mode: 'practice',
      stake: 0,
      result: row.result,
      net: 0,
      date: new Date(row.at).toISOString().slice(0, 10),
      endReason: row.reason,
      opponent: 'NOVA (practice)',
      createdAt: row.at,
      practiceLevel: row.level,
    }));
    const combined = [...serverHistory, ...practice]
      .sort((a, b) => Number(b.createdAt) - Number(a.createdAt))
      .slice(0, MAX_HISTORY);

    const list = $('historyList');
    list.innerHTML = '';
    if (!data.me) {
      list.appendChild(element('p', 'empty', 'Sign in to keep a server history of ranked games and human duels.'));
      return;
    }
    if (!combined.length) {
      list.appendChild(element('p', 'empty', 'No finished games yet. Beat NOVA to start your record.'));
      return;
    }
    for (const row of combined) {
      const rowEl = element('div', 'history-row');
      rowEl.appendChild(element('div', 'history-date', formatWhen(row.createdAt)));
      rowEl.appendChild(element('div', 'history-opponent', row.opponent));
      const modeText =
        row.mode === 'ai'
          ? 'Ranked AI'
          : row.mode === 'human'
            ? 'Human duel'
            : `Practice · ${row.practiceLevel === 'standard' ? 'Standard' : 'Advanced'}`;
      rowEl.appendChild(element('div', `history-mode ${row.mode}`, modeText));
      rowEl.appendChild(element('div', `history-result ${row.result}`, row.result));
      rowEl.appendChild(
        element(
          'div',
          `history-net${row.net > 0 ? ' positive' : row.net < 0 ? ' negative' : ''}`,
          row.mode === 'practice' ? '—' : signed(row.net)
        )
      );
      rowEl.appendChild(element('div', 'history-reason', reasonText(row.endReason)));
      list.appendChild(rowEl);
    }
  }

  function renderInvitations() {
    const data = state.data;
    const receivedBox = $('receivedInvites');
    const sentBox = $('sentInvites');
    const lockedNote = $('inviteLockedNote');
    receivedBox.innerHTML = '';
    sentBox.innerHTML = '';
    const me = data && data.me;
    const received = (data && data.invitations.received) || [];
    const sent = (data && data.invitations.sent) || [];

    lockedNote.hidden = !me || me.inviteUnlocked;

    if (!me) {
      receivedBox.appendChild(element('p', 'empty', 'Sign in to receive invitations from top-three players.'));
      sentBox.appendChild(element('p', 'empty', 'Sign in to send invitations after reaching 1,000 points.'));
      return;
    }

    if (!received.length) {
      receivedBox.appendChild(element('p', 'empty', 'No pending invitations. Your next rival awaits.'));
    } else {
      for (const invite of received) {
        const item = element('div', 'invite-item');
        const head = element('div', 'invite-item-head');
        head.appendChild(element('strong', '', invite.sender.name));
        head.appendChild(element('span', 'invite-stake', `${invite.stake} chips`));
        item.appendChild(head);
        item.appendChild(element('p', 'micro', `Expires in ${expiresIn(invite.expiresAt)} · stake reserved only on accept`));
        const actions = element('div', 'invite-actions');
        const accept = element('button', 'primary small', 'Accept');
        accept.type = 'button';
        accept.disabled = state.busy;
        accept.addEventListener('click', () => respondInvite('invite-accept', invite.id));
        const decline = element('button', 'ghost small', 'Decline');
        decline.type = 'button';
        decline.disabled = state.busy;
        decline.addEventListener('click', () => respondInvite('invite-decline', invite.id));
        actions.appendChild(accept);
        actions.appendChild(decline);
        item.appendChild(actions);
        receivedBox.appendChild(item);
      }
    }

    if (!sent.length) {
      sentBox.appendChild(element('p', 'empty', 'No sent invitations. Challenge a top-three player from the Leaderboard.'));
    } else {
      for (const invite of sent) {
        const item = element('div', 'invite-item');
        const head = element('div', 'invite-item-head');
        head.appendChild(element('strong', '', invite.receiver.name));
        head.appendChild(element('span', 'invite-stake', `${invite.stake} chips`));
        item.appendChild(head);
        item.appendChild(element('p', 'micro', `Waiting for a response · expires in ${expiresIn(invite.expiresAt)}`));
        const actions = element('div', 'invite-actions');
        const cancel = element('button', 'ghost small', 'Cancel');
        cancel.type = 'button';
        cancel.disabled = state.busy;
        cancel.addEventListener('click', () => respondInvite('invite-cancel', invite.id));
        actions.appendChild(cancel);
        item.appendChild(actions);
        sentBox.appendChild(item);
      }
    }
  }

  async function respondInvite(action, id) {
    if (state.busy) return;
    state.busy = true;
    renderInvitations();
    try {
      const result = await api(`/api/${action}`, { method: 'POST', body: { id } });
      if (action === 'invite-accept') {
        toast(`Challenge accepted${result.game ? ` · ${result.game.stake} chips staked` : ''}.`, 'win');
        showTab('play');
      } else if (action === 'invite-decline') {
        toast('Invitation declined.');
      } else {
        toast('Invitation cancelled.');
      }
      await refresh();
    } catch (error) {
      toast(error.message, 'loss');
    } finally {
      state.busy = false;
      render();
    }
  }

  // ------------------------------------------------------------- clock

  function updateClock() {
    const el = $('turnClock');
    const game = state.data && state.data.game;
    if (!game || game.mode !== 'human' || !game.deadline || game.status !== 'active') {
      el.hidden = true;
      return;
    }
    const remaining = Number(game.deadline) - (Date.now() + state.clockOffset);
    const seconds = Math.max(0, Math.ceil(remaining / 1000));
    el.hidden = false;
    el.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    el.classList.toggle('low', seconds <= 20);
  }

  // --------------------------------------------------------- interaction

  function bindEvents() {
    document.querySelectorAll('.tab').forEach((button) => {
      button.addEventListener('click', () => showTab(button.dataset.tab));
    });

    $('board').addEventListener('click', (event) => {
      const cell = event.target.closest('.cell');
      if (!cell) return;
      handleCellClick(Number(cell.dataset.index));
    });

    $('accountButton').addEventListener('click', openAuth);

    $('startAiBtn').addEventListener('click', startRanked);

    $('resignBtn').addEventListener('click', resign);

    $('largerBoardBtn').addEventListener('click', () => {
      state.larger = !state.larger;
      $('boardWrap').classList.toggle('large', state.larger);
      $('largerBoardBtn').textContent = `Larger board: ${state.larger ? 'on' : 'off'}`;
      $('largerBoardBtn').setAttribute('aria-pressed', state.larger ? 'true' : 'false');
      try {
        localStorage.setItem(LARGER_KEY, state.larger ? '1' : '0');
      } catch {
        /* ignore */
      }
    });

    try {
      state.larger = localStorage.getItem(LARGER_KEY) === '1';
    } catch {
      state.larger = false;
    }
    if (state.larger) {
      $('boardWrap').classList.add('large');
      $('largerBoardBtn').textContent = 'Larger board: on';
      $('largerBoardBtn').setAttribute('aria-pressed', 'true');
    }

    $('practiceBtn').addEventListener('click', startPractice);

    $('practiceLevel').addEventListener('click', (event) => {
      const button = event.target.closest('button[data-level]');
      if (!button) return;
      state.practiceLevel = button.dataset.level;
      renderPractice();
    });

    $('leaderboardMode').addEventListener('click', (event) => {
      const button = event.target.closest('button[data-mode]');
      if (!button) return;
      state.leaderboardMode = button.dataset.mode;
      renderLeaderboard();
    });

    document.querySelectorAll('[data-close]').forEach((button) => {
      button.addEventListener('click', () => {
        const dialog = $(button.dataset.close);
        if (dialog) dialog.close();
      });
    });

    $('authMode').addEventListener('click', (event) => {
      const button = event.target.closest('button[data-auth]');
      if (!button) return;
      state.authMode = button.dataset.auth;
      updateAuthUi();
    });

    $('authForm').addEventListener('submit', submitAuth);

    $('logoutBtn').addEventListener('click', logout);

    $('challengeSendBtn').addEventListener('click', sendChallenge);

    $('authDialog').addEventListener('close', () => {
      $('authMessage').hidden = true;
    });
  }

  function showTab(tab) {
    state.tab = tab;
    document.querySelectorAll('.tab').forEach((button) => {
      button.classList.toggle('active', button.dataset.tab === tab);
    });
    document.querySelectorAll('.tab-panel').forEach((panel) => {
      panel.hidden = panel.dataset.panel !== tab;
    });
    if (tab === 'invitations') refresh();
  }

  async function handleCellClick(index) {
    if (state.busy) return;
    if (state.practice) {
      playPractice(index);
      return;
    }
    const data = state.data;
    const game = data && data.game;
    if (!data || !data.me) {
      openAuth();
      return;
    }
    if (!game || game.status !== 'active') {
      toast('Start a ranked game or a practice game first.', 'gold');
      return;
    }
    if (game.turn !== game.yourColor) {
      toast('Wait for your turn.', 'gold');
      return;
    }
    if (game.board[index]) return;

    const originalRevision = game.revision;
    const optimistic = game.board.slice();
    optimistic[index] = game.yourColor;
    game.board = optimistic;
    paintBoard(optimistic, { interactive: false });
    state.busy = true;
    syncInteractive();

    try {
      const result = await api('/api/move', {
        method: 'POST',
        body: { game: game.id, index, revision: originalRevision },
      });
      if (result.game && result.game.status === 'active') {
        state.data.game = result.game;
      } else if (result.game) {
        state.data.game = null;
        state.data.lastGame = result.game;
        state.lastGameId = Number(result.game.id);
        announceResult(result.game);
      }
      await refresh();
    } catch (error) {
      toast(error.message, 'loss');
      await refresh();
    } finally {
      state.busy = false;
      render();
    }
  }

  function syncInteractive() {
    const game = state.data && state.data.game;
    const interactive = Boolean(
      game && game.status === 'active' && game.turn === game.yourColor && !state.busy
    );
    $('board').classList.toggle('disabled', !interactive);
  }

  async function startRanked() {
    if (!state.data || !state.data.me) {
      openAuth();
      return;
    }
    if (state.busy) return;
    state.busy = true;
    renderStakes();
    try {
      await api('/api/start-ai', { method: 'POST', body: { stake: state.activeStake } });
      state.practice = null;
      await refresh();
      toast(`Ranked game started · ${state.activeStake} chips reserved.`, 'gold');
      showTab('play');
    } catch (error) {
      toast(error.message, 'loss');
    } finally {
      state.busy = false;
      render();
    }
  }

  async function resign() {
    if (state.busy) return;
    if (state.practice) {
      if (state.practice.over) return;
      endPractice('loss', 'resign');
      return;
    }
    const game = state.data && state.data.game;
    if (!game) return;
    const confirmed = window.confirm(
      'Resign this game? A resignation counts as a loss and does not count toward stake unlocks.'
    );
    if (!confirmed) return;
    state.busy = true;
    try {
      await api('/api/resign', { method: 'POST', body: { game: game.id } });
      toast('You resigned. The stake counts as a loss.', 'loss');
      await refresh();
    } catch (error) {
      toast(error.message, 'loss');
    } finally {
      state.busy = false;
      render();
    }
  }

  // ------------------------------------------------------------ practice

  function startPractice() {
    if (state.data && state.data.game) {
      toast('Finish your live game before starting practice.', 'loss');
      return;
    }
    state.practice = {
      board: new Array(225).fill(0),
      turn: 'player',
      over: false,
      level: state.practiceLevel,
      startedAt: Date.now(),
      moves: 0,
      result: null,
      reason: null,
      winningLine: null,
    };
    showTab('play');
    render();
    toast('Practice started. You are Black.', 'gold');
  }

  function playPractice(index) {
    const practice = state.practice;
    if (!practice || practice.over || practice.turn !== 'player' || practice.board[index]) return;
    practice.board[index] = 1;
    practice.moves += 1;
    if (NOVA.winningLine(practice.board, index, 1)) {
      practice.winningLine = lineThrough(practice.board, index, 1);
      endPractice('win', 'five');
      return;
    }
    if (practice.board.every((value) => value !== 0)) {
      endPractice('draw', 'full_draw');
      return;
    }
    practice.turn = 'ai';
    render();
    setTimeout(runPracticeAi, 280);
  }

  function runPracticeAi() {
    const practice = state.practice;
    if (!practice || practice.over) return;
    const move = NOVA.chooseMove(practice.board, 2, practice.level);
    if (move === null || move === undefined) {
      endPractice('draw', 'full_draw');
      return;
    }
    practice.board[move] = 2;
    practice.moves += 1;
    if (NOVA.winningLine(practice.board, move, 2)) {
      practice.winningLine = lineThrough(practice.board, move, 2);
      endPractice('loss', 'five');
      return;
    }
    if (practice.board.every((value) => value !== 0)) {
      endPractice('draw', 'full_draw');
      return;
    }
    practice.turn = 'player';
    render();
  }

  function lineThrough(board, index, color) {
    const x = index % 15;
    const y = Math.floor(index / 15);
    const directions = [
      [1, 0],
      [0, 1],
      [1, 1],
      [1, -1],
    ];
    for (const [dx, dy] of directions) {
      const line = [index];
      for (const sign of [-1, 1]) {
        let nx = x + dx * sign;
        let ny = y + dy * sign;
        while (nx >= 0 && nx < 15 && ny >= 0 && ny < 15 && board[ny * 15 + nx] === color) {
          line.push(ny * 15 + nx);
          nx += dx * sign;
          ny += dy * sign;
        }
      }
      if (line.length >= 5) return line;
    }
    return null;
  }

  function endPractice(result, reason) {
    const practice = state.practice;
    if (!practice || practice.over) return;
    practice.over = true;
    practice.result = result;
    practice.reason = reason;
    practice.turn = null;
    practice.endedAt = Date.now();
    const record = loadPracticeRecord();
    record.push({
      result,
      reason,
      level: practice.level,
      at: practice.endedAt,
      moves: practice.moves,
    });
    try {
      localStorage.setItem(PRACTICE_KEY, JSON.stringify(record.slice(-MAX_HISTORY)));
    } catch {
      /* ignore */
    }
    render();
    if (result === 'win') toast('Practice win. Five in a row.', 'win');
    else if (result === 'loss') toast(reason === 'resign' ? 'Practice ended.' : 'Practice loss. NOVA connected five.', 'loss');
    else toast('Practice draw. The board is full.', 'gold');
  }

  function loadPracticeRecord() {
    try {
      const raw = localStorage.getItem(PRACTICE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter((row) => row && row.at) : [];
    } catch {
      return [];
    }
  }

  // --------------------------------------------------------- invitations

  function openChallenge(row) {
    state.challengeTarget = row;
    const allowed = state.data.me.allowedStakes;
    if (!allowed.includes(state.challengeStake)) {
      state.challengeStake = allowed.find((stake) => state.data.me.wallet >= stake) || allowed[0];
    }
    $('challengeName').textContent = row.name;
    const list = $('challengeStakes');
    list.innerHTML = '';
    for (const stake of ALL_STAKES) {
      const button = element('button', 'stake', String(stake));
      button.type = 'button';
      const unlocked = allowed.includes(stake);
      const affordable = state.data.me.wallet >= stake;
      if (!unlocked) {
        button.classList.add('locked');
        button.disabled = true;
        button.title = 'You have not unlocked this stake today.';
      } else if (!affordable) {
        button.classList.add('unaffordable');
        button.title = 'Your available balance is below this stake.';
      }
      if (state.challengeStake === stake) button.classList.add('selected');
      button.addEventListener('click', () => {
        if (!unlocked || !affordable) return;
        state.challengeStake = stake;
        list.querySelectorAll('.stake').forEach((chip) => {
          chip.classList.toggle('selected', Number(chip.textContent) === stake);
        });
      });
      list.appendChild(button);
    }
    $('challengeMessage').hidden = true;
    $('challengeDialog').showModal();
  }

  async function sendChallenge() {
    if (!state.challengeTarget || state.busy) return;
    const button = $('challengeSendBtn');
    const message = $('challengeMessage');
    message.hidden = true;
    button.disabled = true;
    state.busy = true;
    try {
      await api('/api/invite', {
        method: 'POST',
        body: {
          player: state.challengeTarget.id,
          stake: state.challengeStake,
        },
      });
      $('challengeDialog').close();
      toast(`Invitation sent to ${state.challengeTarget.name}.`, 'gold');
      await refresh();
    } catch (error) {
      message.hidden = false;
      message.textContent = error.message;
    } finally {
      state.busy = false;
      button.disabled = false;
    }
  }

  // --------------------------------------------------------------- auth

  function openAuth() {
    state.authMode = state.data && state.data.me ? 'login' : state.authMode || 'login';
    updateAuthUi();
    const dialog = $('authDialog');
    if (!dialog.open) dialog.showModal();
    mountGoogle();
  }

  function updateAuthUi() {
    const me = state.data && state.data.me;
    const dialogMode = state.authMode === 'register' ? 'register' : 'login';
    $('authTitle').textContent = me ? me.name : dialogMode === 'register' ? 'Create account' : 'Sign in';
    $('authMode').hidden = Boolean(me);
    $('authForm').hidden = Boolean(me);
    $('logoutBtn').hidden = !me;
    $('authSubmit').textContent = dialogMode === 'register' ? 'Create account' : 'Sign in';
    $('authPassword').autocomplete = dialogMode === 'register' ? 'new-password' : 'current-password';
    $('authHint').textContent = me
      ? `Signed in as ${me.name}.`
      : '3–18 characters. Letters, numbers, spaces, dots, dashes, underscores. Password: 8+ characters.';
    document.querySelectorAll('#authMode button').forEach((button) => {
      button.classList.toggle('active', button.dataset.auth === dialogMode);
    });
    $('authMessage').hidden = true;
  }

  async function submitAuth(event) {
    event.preventDefault();
    const name = $('authName').value.trim();
    const password = $('authPassword').value;
    const message = $('authMessage');
    message.hidden = true;
    const button = $('authSubmit');
    button.disabled = true;
    try {
      await api(state.authMode === 'register' ? '/api/register' : '/api/login', {
        method: 'POST',
        body: { name, password },
      });
      $('authPassword').value = '';
      $('authDialog').close();
      toast(state.authMode === 'register' ? 'Account created. Welcome to Seven Stones.' : 'Signed in.', 'win');
      state.initialized = false;
      await refresh();
    } catch (error) {
      message.hidden = false;
      message.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  }

  async function logout() {
    const message = $('authMessage');
    message.hidden = true;
    try {
      await api('/api/logout', { method: 'POST', body: {} });
      state.practice = null;
      state.initialized = false;
      state.lastGameId = null;
      $('authDialog').close();
      toast('Signed out.');
      await refresh();
    } catch (error) {
      message.hidden = false;
      message.textContent = error.message;
    }
  }

  async function mountGoogle() {
    const holder = $('googleButton');
    const note = $('googleNote');
    holder.innerHTML = '';
    const data = state.data;
    if (!data || !data.server.googleEnabled) {
      note.textContent = 'Google sign-in is not configured on this server. Name and password login still work.';
      return;
    }
    note.textContent = 'Loading Google sign-in…';
    try {
      await loadGsi();
      const challenge = await api('/api/google/challenge');
      state.googleNonce = challenge.nonce;
      window.google.accounts.id.initialize({
        client_id: data.server.googleClientId,
        nonce: challenge.nonce,
        callback: onGoogleCredential,
        auto_select: false,
        cancel_on_tap_outside: true,
        ux_mode: 'popup',
      });
      window.google.accounts.id.renderButton(holder, {
        theme: 'filled_black',
        size: 'large',
        shape: 'pill',
        text: data.me ? 'continue_with' : 'signin_with',
        width: 288,
      });
      note.textContent = data.me
        ? 'Link a Google account to this player. Existing accounts are never merged by email.'
        : 'Your Google account is verified by Google and this server.';
    } catch (error) {
      holder.innerHTML = '';
      note.textContent = error.message || 'Google sign-in is unavailable right now.';
    }
  }

  function loadGsi() {
    if (window.google && window.google.accounts && window.google.accounts.id) {
      return Promise.resolve();
    }
    if (!googleScriptPromise) {
      googleScriptPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://accounts.google.com/gsi/client';
        script.async = true;
        script.defer = true;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error('The Google sign-in script could not be loaded.'));
        document.head.appendChild(script);
      });
    }
    return googleScriptPromise;
  }

  async function onGoogleCredential(response) {
    const message = $('authMessage');
    const linking = Boolean(state.data && state.data.me);
    message.hidden = true;
    try {
      await api('/api/google', {
        method: 'POST',
        body: { credential: response.credential, nonce: state.googleNonce },
      });
      $('authDialog').close();
      toast(linking ? 'Google account linked.' : 'Signed in with Google.', 'win');
      state.initialized = false;
      await refresh();
    } catch (error) {
      message.hidden = false;
      message.textContent = error.message;
    }
  }

  // ------------------------------------------------------------- helpers

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function signed(value) {
    const number = Number(value) || 0;
    if (number > 0) return `+${number}`;
    if (number < 0) return `−${Math.abs(number)}`;
    return '0';
  }

  function reasonText(reason) {
    switch (reason) {
      case 'five':
        return 'Five in a row.';
      case 'full_draw':
        return 'Full board draw.';
      case 'resign':
        return 'Resignation.';
      case 'timeout':
        return '90-second turn expired.';
      case 'midnight':
        return 'Midnight UTC refund.';
      case 'error':
        return 'AI error refund.';
      default:
        return '';
    }
  }

  function formatWhen(ts) {
    if (!ts) return '—';
    const iso = new Date(Number(ts)).toISOString();
    return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
  }

  function expiresIn(ts) {
    const remaining = Math.max(0, Number(ts) - Date.now());
    const minutes = Math.ceil(remaining / 60000);
    if (minutes <= 0) return 'under a minute';
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return `${hours}h ${rest}m`;
  }

  function toast(message, kind) {
    const box = $('toasts');
    const node = element('div', `toast ${kind || ''}`, message);
    box.appendChild(node);
    setTimeout(() => {
      node.remove();
    }, 4200);
  }
})();
