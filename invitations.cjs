'use strict';

// In-site invitation helpers: presence, expiry, busy checks.
// Route-level validation (rank, stakes, wallets) lives in server.cjs.

const ONLINE_WINDOW_MS = 30 * 1000;

function touchPresence(db, userId, now = Date.now()) {
  db.prepare(
    `INSERT INTO presence (user_id, last_seen) VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET last_seen = excluded.last_seen`
  ).run(userId, now);
}

function isOnline(db, userId, now = Date.now()) {
  const row = db.prepare('SELECT last_seen FROM presence WHERE user_id = ?').get(userId);
  return Boolean(row) && now - Number(row.last_seen) <= ONLINE_WINDOW_MS;
}

function activeGameFor(db, userId) {
  return (
    db
      .prepare(
        `SELECT * FROM games
         WHERE status = 'active' AND (player_id = ? OR opponent_id = ?)
         ORDER BY id DESC LIMIT 1`
      )
      .get(userId, userId) || null
  );
}

function isQueued(db, userId) {
  return Boolean(db.prepare('SELECT user_id FROM queue WHERE user_id = ?').get(userId));
}

function isBusy(db, userId) {
  return Boolean(activeGameFor(db, userId)) || isQueued(db, userId);
}

function expireInvitations(db, now = Date.now()) {
  return db
    .prepare(
      `UPDATE invitations SET status = 'expired', responded_at = ?
       WHERE status = 'pending' AND expires_at <= ?`
    )
    .run(now, now).changes;
}

function pendingBetween(db, senderId, receiverId) {
  return (
    db
      .prepare(
        `SELECT * FROM invitations
         WHERE status = 'pending' AND sender_id = ? AND receiver_id = ?`
      )
      .get(senderId, receiverId) || null
  );
}

function recentInviteCount(db, senderId, since) {
  return Number(
    db
      .prepare('SELECT COUNT(*) AS count FROM invitations WHERE sender_id = ? AND created_at >= ?')
      .get(senderId, since).count
  );
}

function pendingForUser(db, userId) {
  return db
    .prepare(
      `SELECT i.*, s.name AS sender_name, r.name AS receiver_name
       FROM invitations i
       JOIN users s ON s.id = i.sender_id
       JOIN users r ON r.id = i.receiver_id
       WHERE i.status = 'pending' AND (i.sender_id = ? OR i.receiver_id = ?)
       ORDER BY i.created_at DESC`
    )
    .all(userId, userId);
}

module.exports = {
  ONLINE_WINDOW_MS,
  touchPresence,
  isOnline,
  activeGameFor,
  isQueued,
  isBusy,
  expireInvitations,
  pendingBetween,
  recentInviteCount,
  pendingForUser,
};
