(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.NOVA = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SIZE = 15;
  const EMPTY = 0;
  const BLACK = 1;
  const WHITE = 2;
  const DIRECTIONS = [
    [1, 0],
    [0, 1],
    [1, 1],
    [1, -1],
  ];
  const WIN_VALUE = 1e8;

  function indexOf(x, y) {
    return y * SIZE + x;
  }

  function inBounds(x, y) {
    return x >= 0 && x < SIZE && y >= 0 && y < SIZE;
  }

  function other(color) {
    return color === BLACK ? WHITE : BLACK;
  }

  function isFull(board) {
    for (let i = 0; i < board.length; i += 1) {
      if (board[i] === EMPTY) return false;
    }
    return true;
  }

  function winningLine(board, index, color) {
    const x = index % SIZE;
    const y = Math.floor(index / SIZE);
    for (const [dx, dy] of DIRECTIONS) {
      let count = 1;
      for (const sign of [-1, 1]) {
        let nx = x + dx * sign;
        let ny = y + dy * sign;
        while (inBounds(nx, ny) && board[indexOf(nx, ny)] === color) {
          count += 1;
          nx += dx * sign;
          ny += dy * sign;
        }
      }
      if (count >= 5) return true;
    }
    return false;
  }

  // Score the 9-cell window around a hypothetical stone at (x, y).
  function windowFor(board, x, y, dx, dy, color) {
    let line = '';
    for (let k = -4; k <= 4; k += 1) {
      if (k === 0) {
        line += '1';
        continue;
      }
      const nx = x + dx * k;
      const ny = y + dy * k;
      if (!inBounds(nx, ny)) {
        line += '2';
        continue;
      }
      const value = board[indexOf(nx, ny)];
      if (value === EMPTY) line += '0';
      else line += value === color ? '1' : '2';
    }
    return line;
  }

  function patternScore(line) {
    if (line.includes('11111')) return 1e9;
    if (line.includes('011110')) return 1e7;
    if (/11110|01111|11011|10111|11101/.test(line)) return 1e6;
    if (/01110|011010|010110/.test(line)) return 1e5;
    if (/11100|00111|11010|01011|10110|01101|10011|11001/.test(line)) return 1e4;
    if (/001100|011000|000110|010100|001010|010010/.test(line)) return 800;
    if (/1100|0011|1010|0101|1001|0110/.test(line)) return 100;
    return 5;
  }

  function moveScore(board, index, color) {
    const x = index % SIZE;
    const y = Math.floor(index / SIZE);
    let total = 0;
    let fours = 0;
    let threes = 0;
    for (const [dx, dy] of DIRECTIONS) {
      const score = patternScore(windowFor(board, x, y, dx, dy, color));
      total += score;
      if (score >= 1e6 && score < 1e9) fours += 1;
      if (score >= 1e5 && score < 1e6) threes += 1;
    }
    if (fours >= 2) total += 5e7;
    else if (fours >= 1 && threes >= 1) total += 1e7;
    else if (threes >= 2) total += 5e6;
    return total;
  }

  function emptyNeighbours(board) {
    const seen = new Set();
    for (let i = 0; i < board.length; i += 1) {
      if (board[i] === EMPTY) continue;
      const x = i % SIZE;
      const y = Math.floor(i / SIZE);
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if (!inBounds(nx, ny)) continue;
          const at = indexOf(nx, ny);
          if (board[at] === EMPTY) seen.add(at);
        }
      }
    }
    return Array.from(seen);
  }

  function findWinningMove(board, color) {
    const moves = emptyNeighbours(board);
    if (!moves.length) {
      for (let i = 0; i < board.length; i += 1) {
        if (board[i] === EMPTY) moves.push(i);
      }
    }
    for (const move of moves) {
      board[move] = color;
      const won = winningLine(board, move, color);
      board[move] = EMPTY;
      if (won) return move;
    }
    return null;
  }

  function scoredMoves(board, color, cap) {
    const opp = other(color);
    const moves = emptyNeighbours(board);
    const scored = [];
    for (const move of moves) {
      const attack = moveScore(board, move, color);
      const defense = moveScore(board, move, opp);
      scored.push({ index: move, attack, defense, score: attack + defense * 0.92 });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, cap);
  }

  function lineStrings(board) {
    const lines = [];
    for (let y = 0; y < SIZE; y += 1) {
      let row = '';
      for (let x = 0; x < SIZE; x += 1) row += board[indexOf(x, y)];
      lines.push(row);
    }
    for (let x = 0; x < SIZE; x += 1) {
      let col = '';
      for (let y = 0; y < SIZE; y += 1) col += board[indexOf(x, y)];
      lines.push(col);
    }
    for (let startX = 0; startX < SIZE; startX += 1) {
      let line = '';
      for (let k = 0; startX + k < SIZE && k < SIZE; k += 1) line += board[indexOf(startX + k, k)];
      if (line.length >= 5) lines.push(line);
    }
    for (let startY = 1; startY < SIZE; startY += 1) {
      let line = '';
      for (let k = 0; startY + k < SIZE && k < SIZE; k += 1) line += board[indexOf(k, startY + k)];
      if (line.length >= 5) lines.push(line);
    }
    for (let startX = 0; startX < SIZE; startX += 1) {
      let line = '';
      for (let k = 0; startX - k >= 0 && k < SIZE; k += 1) line += board[indexOf(startX - k, k)];
      if (line.length >= 5) lines.push(line);
    }
    for (let startY = 1; startY < SIZE; startY += 1) {
      let line = '';
      for (let k = 0; startY + k < SIZE && SIZE - 1 - k >= 0; k += 1) {
        line += board[indexOf(SIZE - 1 - k, startY + k)];
      }
      if (line.length >= 5) lines.push(line);
    }
    return lines;
  }

  const COUNT_PATTERNS = [
    { source: '11111', score: 1e9 },
    { source: '011110', score: 1e7 },
    { source: '11110|01111|11011|10111|11101', score: 1e6 },
    { source: '01110|011010|010110', score: 1e5 },
    { source: '11100|00111|11010|01011|10110|01101|10011|11001', score: 1e4 },
    { source: '001100|011000|000110|010100|001010|010010', score: 800 },
    { source: '1100|0011|1010|0101|1001|0110', score: 100 },
  ].map((entry) => ({
    score: entry.score,
    regex: new RegExp(`(?=(${entry.source}))`, 'g'),
  }));

  function countPatterns(line) {
    let total = 0;
    for (const pattern of COUNT_PATTERNS) {
      pattern.regex.lastIndex = 0;
      let match;
      while ((match = pattern.regex.exec(line)) !== null) {
        total += pattern.score;
        pattern.regex.lastIndex = match.index + 1;
      }
    }
    return total;
  }

  function evaluateBoard(board, color) {
    const opp = other(color);
    let mine = 0;
    let theirs = 0;
    for (const line of lineStrings(board)) {
      const myLine = line.replace(new RegExp(String(opp), 'g'), '2').replace(new RegExp(String(color), 'g'), '1');
      const oppLine = line.replace(new RegExp(String(color), 'g'), '2').replace(new RegExp(String(opp), 'g'), '1');
      mine += countPatterns(myLine);
      theirs += countPatterns(oppLine);
    }
    return mine - theirs * 1.12;
  }

  function minimax(board, turn, depth, alpha, beta, aiColor, deadline) {
    if (depth <= 0 || Date.now() > deadline) return evaluateBoard(board, aiColor);
    const moves = scoredMoves(board, turn, 6);
    if (!moves.length) return 0;
    let best = turn === aiColor ? -Infinity : Infinity;
    for (const move of moves) {
      board[move.index] = turn;
      let value;
      if (winningLine(board, move.index, turn)) {
        value = turn === aiColor ? WIN_VALUE + depth : -(WIN_VALUE + depth);
      } else if (isFull(board)) {
        value = 0;
      } else {
        value = minimax(board, other(turn), depth - 1, alpha, beta, aiColor, deadline);
      }
      board[move.index] = EMPTY;
      if (turn === aiColor) {
        if (value > best) best = value;
        if (best > alpha) alpha = best;
      } else {
        if (value < best) best = value;
        if (best < beta) beta = best;
      }
      if (beta <= alpha) break;
    }
    return best;
  }

  function chooseMove(inputBoard, color, level, rng) {
    const board = Array.from(inputBoard, (v) => Number(v) || 0);
    const random = typeof rng === 'function' ? rng : Math.random;
    const me = color === WHITE ? WHITE : BLACK;
    const opp = other(me);

    if (!board.some((v) => v !== EMPTY)) return indexOf(7, 7);

    const winning = findWinningMove(board, me);
    if (winning !== null) return winning;

    const blocks = [];
    const candidates = emptyNeighbours(board);
    for (const move of candidates) {
      board[move] = opp;
      if (winningLine(board, move, opp)) blocks.push(move);
      board[move] = EMPTY;
    }
    if (blocks.length === 1) return blocks[0];
    if (blocks.length > 1) {
      blocks.sort((a, b) => moveScore(board, b, opp) - moveScore(board, a, opp));
      return blocks[0];
    }

    const moves = scoredMoves(board, me, level === 'standard' ? 7 : 10);
    if (!moves.length) {
      const firstEmpty = board.findIndex((v) => v === EMPTY);
      return firstEmpty === -1 ? null : firstEmpty;
    }

    if (level === 'standard') {
      const pool = moves.slice(0, Math.min(4, moves.length));
      // Mostly take the best heuristic move, occasionally a near-best one.
      const roll = random();
      if (roll < 0.72) return pool[0].index;
      return pool[Math.floor(random() * pool.length)].index;
    }

    const deadline = Date.now() + 1100;
    const root = moves.slice(0, 8);
    let bestValue = -Infinity;
    let bestMoves = [];
    for (const move of root) {
      board[move.index] = me;
      let value;
      if (winningLine(board, move.index, me)) {
        value = WIN_VALUE;
      } else if (isFull(board)) {
        value = 0;
      } else {
        value = minimax(board, opp, 3, -Infinity, Infinity, me, deadline);
      }
      board[move.index] = EMPTY;
      if (value > bestValue) {
        bestValue = value;
        bestMoves = [move.index];
      } else if (value === bestValue) {
        bestMoves.push(move.index);
      }
    }
    if (!bestMoves.length) return root[0].index;
    if (bestMoves.length === 1) return bestMoves[0];
    return bestMoves[Math.floor(random() * bestMoves.length)];
  }

  return {
    SIZE,
    EMPTY,
    BLACK,
    WHITE,
    indexOf,
    winningLine,
    findWinningMove,
    emptyNeighbours,
    moveScore,
    evaluateBoard,
    chooseMove,
  };
});
