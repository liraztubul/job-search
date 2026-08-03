const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'jobtracker.db'));
db.exec(fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8'));

function getActiveCompanies() {
    return db.prepare('SELECT * FROM watched_companies WHERE is_active = 1').all();
}

function getActiveProfiles() {
    return db.prepare('SELECT * FROM search_profiles WHERE is_active = 1').all();
}

/** Returns { isNew, id } — inserts if unseen, otherwise just bumps last_seen_at */
function upsertJobSnapshot(companyId, job) {
    const now = new Date().toISOString();
    const existing = db
        .prepare('SELECT id FROM job_snapshots WHERE company_id = ? AND external_id = ?')
        .get(companyId, job.externalId);

    if (existing) {
        db.prepare('UPDATE job_snapshots SET last_seen_at = ? WHERE id = ?').run(now, existing.id);
        return { isNew: false, id: existing.id };
    }

    const info = db
        .prepare(
            `INSERT INTO job_snapshots (company_id, external_id, title, location, apply_url, first_seen_at, last_seen_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(companyId, job.externalId, job.title, job.location, job.applyUrl, now, now);
    return { isNew: true, id: info.lastInsertRowid };
}

function wasNotified(jobSnapshotId, profileId) {
    return !!db
        .prepare('SELECT 1 FROM notifications_sent WHERE job_snapshot_id = ? AND profile_id = ?')
        .get(jobSnapshotId, profileId);
}

function recordNotification(jobSnapshotId, profileId) {
    db.prepare(
        'INSERT OR IGNORE INTO notifications_sent (job_snapshot_id, profile_id, sent_at) VALUES (?, ?, ?)'
    ).run(jobSnapshotId, profileId, new Date().toISOString());
}

module.exports = {
    getActiveCompanies,
    getActiveProfiles,
    upsertJobSnapshot,
    wasNotified,
    recordNotification,
};
