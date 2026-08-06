/**
 * Your application pipeline: status, notes and the date you applied.
 *
 * Kept apart from job rows on purpose — a scrape rewrites jobs, and your own
 * notes must never be collateral damage.
 */

const { db } = require('./connection');
const { requireUser } = require('./tenancy');

/** Dates are stored as plain YYYY-MM-DD: that's what <input type="date"> speaks,
 *  and an application date has no meaningful time of day. */
const today = () => new Date().toISOString().slice(0, 10);
const asDate = (value) => (value ? String(value).slice(0, 10) : null);

/**
 * Insert or update the application row for one job.
 *
 * Every field is optional except the job. Passing `status: null` deletes the
 * row — that's how the UI clears an entry. Passing a field as `undefined`
 * leaves it alone, which is what lets the dashboard save the date without
 * touching the notes and vice versa.
 */
function setApplication({ userId, jobSnapshotId, status, notes, appliedAt }) {
    const owner = requireUser(userId);
    const now = new Date().toISOString();

    if (status === null) {
        db.prepare('DELETE FROM applications WHERE user_id = ? AND job_snapshot_id = ?').run(owner, jobSnapshotId);
        return null;
    }

    const existing = db
        .prepare('SELECT * FROM applications WHERE user_id = ? AND job_snapshot_id = ?')
        .get(owner, jobSnapshotId);

    const nextStatus = status ?? existing?.status ?? 'saved';

    // Stamp the date the first time something is marked applied, but never
    // overwrite a date you set by hand.
    let nextAppliedAt;
    if (appliedAt !== undefined) {
        nextAppliedAt = asDate(appliedAt);
    } else if (existing?.applied_at) {
        nextAppliedAt = asDate(existing.applied_at);
    } else {
        nextAppliedAt = nextStatus === 'applied' ? today() : null;
    }

    const nextNotes = notes !== undefined ? notes || null : existing?.notes ?? null;

    if (existing) {
        db.prepare(
            `UPDATE applications SET status = ?, notes = ?, applied_at = ?, updated_at = ?
              WHERE user_id = ? AND job_snapshot_id = ?`
        ).run(nextStatus, nextNotes, nextAppliedAt, now, owner, jobSnapshotId);
    } else {
        db.prepare(
            `INSERT INTO applications (user_id, job_snapshot_id, status, notes, applied_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`
        ).run(owner, jobSnapshotId, nextStatus, nextNotes, nextAppliedAt, now);
    }

    return db.prepare('SELECT * FROM applications WHERE user_id = ? AND job_snapshot_id = ?').get(owner, jobSnapshotId);
}

/** Everything in the application pipeline, newest activity first. */
function listApplications(userId) {
    const owner = requireUser(userId);
    return db
        .prepare(
            `SELECT a.status, a.notes, a.updated_at AS updatedAt,
                    substr(a.applied_at, 1, 10) AS appliedAt,
                    j.id AS jobId, j.external_id AS externalId, j.job_code AS jobCode, j.title, j.location,
                    j.apply_url AS applyUrl, j.is_still_open AS isStillOpen,
                    c.name AS company
               FROM applications a
               JOIN job_snapshots j ON j.id = a.job_snapshot_id
               JOIN watched_companies c ON c.id = j.company_id
              WHERE a.user_id = ?
              ORDER BY COALESCE(a.applied_at, a.updated_at) DESC, j.id DESC`
        )
        .all(owner);
}

module.exports = { setApplication, listApplications };
