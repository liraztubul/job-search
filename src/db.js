const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'jobtracker.db'));
db.exec(fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8'));

/**
 * `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists, so
 * new columns never reach a database created before they were added. This adds
 * only what's missing, which makes running it repeatedly harmless.
 *
 * A real migration framework would be overkill for one developer and one file;
 * this is the smallest thing that stops `node src/main.js` from crashing on a
 * database you seeded last week.
 */
function ensureColumn(table, column, definition) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some((c) => c.name === column)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
}

for (const [column, definition] of [
    ['employment_type', 'TEXT'],
    ['experience_level', 'TEXT'],
    ['department', 'TEXT'],
    ['posted_at', 'TEXT'],
]) {
    ensureColumn('job_snapshots', column, definition);
}

function getActiveCompanies() {
    return db.prepare('SELECT * FROM watched_companies WHERE is_active = 1').all();
}

function getActiveProfiles() {
    return db.prepare('SELECT * FROM search_profiles WHERE is_active = 1').all();
}

function listCompanies() {
    return db.prepare('SELECT * FROM watched_companies ORDER BY name').all();
}

function findCompanyByName(name) {
    return db.prepare('SELECT * FROM watched_companies WHERE name = ?').get(name);
}

/** @returns {number} the new company's id */
function addCompany({ name, careerUrl, adapterType, config }) {
    const info = db
        .prepare(
            `INSERT INTO watched_companies (name, career_url, adapter_type, adapter_config)
             VALUES (?, ?, ?, ?)`
        )
        .run(name, careerUrl, adapterType, JSON.stringify(config || {}));
    return info.lastInsertRowid;
}

/** Returns { isNew, id } — inserts if unseen, otherwise just bumps last_seen_at */
function upsertJobSnapshot(companyId, job) {
    const now = new Date().toISOString();
    const existing = db
        .prepare('SELECT id FROM job_snapshots WHERE company_id = ? AND external_id = ?')
        .get(companyId, job.externalId);

    if (existing) {
        // Refresh the filterable fields too: a posting can be re-tagged, and an
        // adapter that learns to read a new field should backfill old rows.
        db.prepare(
            `UPDATE job_snapshots
                SET last_seen_at = ?, title = ?, location = ?, apply_url = ?,
                    employment_type = ?, experience_level = ?, department = ?, posted_at = ?,
                    is_still_open = 1
              WHERE id = ?`
        ).run(
            now,
            job.title,
            job.location,
            job.applyUrl,
            job.employmentType ?? null,
            job.experienceLevel ?? null,
            job.department ?? null,
            job.postedAt ?? null,
            existing.id
        );
        return { isNew: false, id: existing.id };
    }

    const info = db
        .prepare(
            `INSERT INTO job_snapshots
                (company_id, external_id, title, location, apply_url, first_seen_at, last_seen_at,
                 employment_type, experience_level, department, posted_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
            companyId,
            job.externalId,
            job.title,
            job.location,
            job.applyUrl,
            now,
            now,
            job.employmentType ?? null,
            job.experienceLevel ?? null,
            job.department ?? null,
            job.postedAt ?? null
        );
    return { isNew: true, id: info.lastInsertRowid };
}

// ---------------------------------------------------------------------------
// Queries for the web UI
// ---------------------------------------------------------------------------

/**
 * Filtered job list. Every filter is optional; omitted ones don't constrain.
 * Built as parameterised SQL — never string-concatenated with user input.
 */
function queryJobs(filters = {}) {
    const where = ['1 = 1'];
    const params = {};

    if (filters.companyId) {
        where.push('j.company_id = @companyId');
        params.companyId = Number(filters.companyId);
    }
    if (filters.employmentType) {
        where.push('j.employment_type = @employmentType');
        params.employmentType = filters.employmentType;
    }
    if (filters.experienceLevel) {
        where.push('j.experience_level = @experienceLevel');
        params.experienceLevel = filters.experienceLevel;
    }
    if (filters.location) {
        where.push('j.location LIKE @location');
        params.location = `%${filters.location}%`;
    }
    if (filters.q) {
        where.push('(j.title LIKE @q OR j.department LIKE @q)');
        params.q = `%${filters.q}%`;
    }
    if (filters.status) {
        where.push(filters.status === 'none' ? 'a.status IS NULL' : 'a.status = @status');
        if (filters.status !== 'none') params.status = filters.status;
    }
    if (filters.openOnly) {
        where.push('j.is_still_open = 1');
    }

    const sort =
        filters.sort === 'title' ? 'j.title COLLATE NOCASE ASC' : 'j.first_seen_at DESC, j.id DESC';

    return db
        .prepare(
            `SELECT j.id, j.external_id AS externalId,
                    j.title, j.location, j.apply_url AS applyUrl, j.employment_type AS employmentType,
                    j.experience_level AS experienceLevel, j.department, j.posted_at AS postedAt,
                    j.first_seen_at AS firstSeenAt, j.is_still_open AS isStillOpen,
                    c.name AS company, c.id AS companyId,
                    a.status, a.notes, a.applied_at AS appliedAt
               FROM job_snapshots j
               JOIN watched_companies c ON c.id = j.company_id
               LEFT JOIN applications a ON a.job_snapshot_id = j.id
              WHERE ${where.join(' AND ')}
              ORDER BY ${sort}
              LIMIT @limit`
        )
        .all({ ...params, limit: Math.min(Number(filters.limit) || 500, 2000) });
}

/** Distinct values actually present in the data — so the UI never offers an empty filter. */
function filterOptions() {
    const distinct = (column) =>
        db
            .prepare(
                `SELECT ${column} AS value, COUNT(*) AS count FROM job_snapshots
                  WHERE ${column} IS NOT NULL AND ${column} != ''
                  GROUP BY ${column} ORDER BY count DESC`
            )
            .all();

    return {
        companies: db
            .prepare(
                `SELECT c.id, c.name, COUNT(j.id) AS count
                   FROM watched_companies c LEFT JOIN job_snapshots j ON j.company_id = c.id
                  GROUP BY c.id ORDER BY c.name`
            )
            .all(),
        employmentTypes: distinct('employment_type'),
        experienceLevels: distinct('experience_level'),
        locations: distinct('location').slice(0, 60),
        statuses: db
            .prepare('SELECT status AS value, COUNT(*) AS count FROM applications GROUP BY status')
            .all(),
        total: db.prepare('SELECT COUNT(*) AS n FROM job_snapshots').get().n,
    };
}

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
function setApplication({ jobSnapshotId, status, notes, appliedAt }) {
    const now = new Date().toISOString();

    if (status === null) {
        db.prepare('DELETE FROM applications WHERE job_snapshot_id = ?').run(jobSnapshotId);
        return null;
    }

    const existing = db
        .prepare('SELECT * FROM applications WHERE job_snapshot_id = ?')
        .get(jobSnapshotId);

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
              WHERE job_snapshot_id = ?`
        ).run(nextStatus, nextNotes, nextAppliedAt, now, jobSnapshotId);
    } else {
        db.prepare(
            `INSERT INTO applications (job_snapshot_id, status, notes, applied_at, updated_at)
             VALUES (?, ?, ?, ?, ?)`
        ).run(jobSnapshotId, nextStatus, nextNotes, nextAppliedAt, now);
    }

    return db.prepare('SELECT * FROM applications WHERE job_snapshot_id = ?').get(jobSnapshotId);
}

/** Everything in the application pipeline, newest activity first. */
function listApplications() {
    return db
        .prepare(
            `SELECT a.status, a.notes, a.updated_at AS updatedAt,
                    substr(a.applied_at, 1, 10) AS appliedAt,
                    j.id AS jobId, j.external_id AS externalId, j.title, j.location,
                    j.apply_url AS applyUrl, j.is_still_open AS isStillOpen,
                    c.name AS company
               FROM applications a
               JOIN job_snapshots j ON j.id = a.job_snapshot_id
               JOIN watched_companies c ON c.id = j.company_id
              ORDER BY COALESCE(a.applied_at, a.updated_at) DESC, j.id DESC`
        )
        .all();
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
    listCompanies,
    findCompanyByName,
    addCompany,
    queryJobs,
    filterOptions,
    setApplication,
    listApplications,
    upsertJobSnapshot,
    wasNotified,
    recordNotification,
};
