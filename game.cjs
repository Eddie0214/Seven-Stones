'use strict';

// Shared rules primitives for Seven Stones.
// 15x15 freestyle Gomoku: five or more in a row wins, no forbidden moves.

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
const DAY_MS = 24 * 60 * 60 * 1000;

function createBoard() {
  return new Array(SIZE * SIZE).fill(EMPTY);
}

function cloneBoard(board) {
  return Array.from(board);
}

function indexOf(x, y) {
  return y * SIZE + x;
}

function coordsOf(index) {
  return { x: index % SIZE, y: Math.floor(index / SIZE) };
}

function inBounds(x, y) {
  return x >= 0 && x < SIZE && y >= 0 && y < SIZE;
}

function isBoardFull(board) {
  for (let i = 0; i < board.length; i += 1) {
    if (board[i] === EMPTY) return false;
  }
  return true;
}

function findWinningLine(board, index, color) {
  const { x, y } = coordsOf(index);
  for (const [dx, dy] of DIRECTIONS) {
    const line = [index];
    for (const sign of [-1, 1]) {
      let nx = x + dx * sign;
      let ny = y + dy * sign;
      while (inBounds(nx, ny)) {
        const at = board[indexOf(nx, ny)];
        if (at !== color) break;
        line.push(indexOf(nx, ny));
        nx += dx * sign;
        ny += dy * sign;
      }
    }
    if (line.length >= 5) {
      line.sort((a, b) => a - b);
      return line;
    }
  }
  return null;
}

function findAnyWin(board) {
  for (let i = 0; i < board.length; i += 1) {
    const color = board[i];
    if (color === EMPTY) continue;
    const line = findWinningLine(board, i, color);
    if (line) return { color, index: i, line };
  }
  return null;
}

function boardFromJSON(value) {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return createBoard();
    }
  }
  if (Array.isArray(value)) return value.map((v) => Number(v) || 0);
  return createBoard();
}

// Ranking contract: AI net winnings desc, wins desc, losses asc, name asc.
function compareRankEntries(a, b) {
  if (b.net !== a.net) return b.net - a.net;
  if (b.wins !== a.wins) return b.wins - a.wins;
  if (a.losses !== b.losses) return a.losses - b.losses;
  return String(a.name).localeCompare(String(b.name), 'en', { sensitivity: 'base' });
}

function rankEntries(entries) {
  return entries
    .slice()
    .sort(compareRankEntries)
    .map((entry, index) => ({ ...entry, rank: index + 1 }));
}

function utcDate(ms = Date.now()) {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function dateToMs(date) {
  const [y, m, d] = String(date).split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function addDays(date, days) {
  return utcDate(dateToMs(date) + days * DAY_MS);
}

function daysBetween(from, to) {
  return Math.round((dateToMs(to) - dateToMs(from)) / DAY_MS);
}

function nextUtcMidnight(ms = Date.now()) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

function seasonStartFor(anchorDate, date) {
  const diff = daysBetween(anchorDate, date);
  if (diff < 0) return anchorDate;
  return addDays(anchorDate, Math.floor(diff / 7) * 7);
}

function seasonEndFor(startDate) {
  return addDays(startDate, 6);
}

function seasonNumber(anchorDate, date) {
  return Math.floor(daysBetween(anchorDate, date) / 7) + 1;
}

function daysLeftInSeason(anchorDate, date) {
  const end = seasonEndFor(seasonStartFor(anchorDate, date));
  return Math.max(0, daysBetween(date, end));
}

module.exports = {
  SIZE,
  EMPTY,
  BLACK,
  WHITE,
  DAY_MS,
  createBoard,
  cloneBoard,
  indexOf,
  coordsOf,
  inBounds,
  isBoardFull,
  findWinningLine,
  findAnyWin,
  boardFromJSON,
  compareRankEntries,
  rankEntries,
  utcDate,
  dateToMs,
  addDays,
  daysBetween,
  nextUtcMidnight,
  seasonStartFor,
  seasonEndFor,
  seasonNumber,
  daysLeftInSeason,
};
