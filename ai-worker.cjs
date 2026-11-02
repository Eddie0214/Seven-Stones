'use strict';

const path = require('node:path');
const { parentPort } = require('node:worker_threads');
const NOVA = require('./public/engine.js');

if (!parentPort) {
  throw new Error('ai-worker.cjs must run inside a worker thread.');
}

parentPort.on('message', (message) => {
  try {
    const board = Array.isArray(message.board) ? message.board : [];
    const color = message.color === NOVA.WHITE ? NOVA.WHITE : NOVA.BLACK;
    const level = message.level === 'standard' ? 'standard' : 'advanced';
    const move = NOVA.chooseMove(board, color, level);
    parentPort.postMessage({ id: message.id, move });
  } catch (error) {
    parentPort.postMessage({ id: message.id, error: error.message || 'AI failed.' });
  }
});
