/**
 * Which (job, profile) pairs have already been announced, so nothing alerts
 * twice. Thin SQL only.
 */

const { db } = require('./connection');

function wasNotified(jobSnapshotId, profileId) {
    return !!db
        .prepare('SELECT 1 FROM notifications_sent WHERE job_snapshot_id = ? AND profile_id = ?')
        .get(jobSnapshotId, profileId);
}

function recordNotification(jobSnapshotId, profileId) {
    // Idempotent: UNIQUE(job_snapshot_id, profile_id) + OR IGNORE.
    db.prepare(
        'INSERT OR IGNORE INTO notifications_sent (job_snapshot_id, profile_id, sent_at) VALUES (?, ?, ?)',
        { idempotent: true }
    ).run(jobSnapshotId, profileId, new Date().toISOString());
}

module.exports = { wasNotified, recordNotification };
