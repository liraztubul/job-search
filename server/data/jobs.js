/**
 * Job rows: writing what a scrape found, and reading it back for the UI.
 *
 * `location_search` is a denormalized copy of the location, canonicalized on the
 * way in (see server/domain/locations.js), so the UI can filter on one spelling
 * per city instead of every source's own wording.
 */

const { db } = require('./connection');
const { locationTokens, locationSearchValue, isIsraeliLocation } = require('../domain/locations');

/** Returns { isNew, id } — inserts if unseen, otherwise just bumps last_seen_at */
function upsertJobSnapshot(companyId, job) {
    const now = new Date().toISOString();
    const existing = db
        .prepare('SELECT id FROM job_snapshots WHERE company_id = ? AND external_id = ?')
        .get(companyId, job.externalId);

    if (existing) {
        const searchLocation = locationSearchValue(job.location);
        // Refresh the filterable fields too: a posting can be re-tagged, and an
        // adapter that learns to read a new field should backfill old rows.
        db.prepare(
            `UPDATE job_snapshots
                SET last_seen_at = ?, title = ?, location = ?, location_search = ?, apply_url = ?, job_code = ?,
                    employment_type = ?, experience_level = ?, department = ?, posted_at = ?,
                    is_still_open = 1
              WHERE id = ?`
        ).run(
            now,
            job.title,
            job.location,
            searchLocation,
            job.applyUrl,
            job.jobCode ?? null,
            job.employmentType ?? null,
            job.experienceLevel ?? null,
            job.department ?? null,
            job.postedAt ?? null,
            existing.id
        );
        return { isNew: false, id: existing.id };
    }

    const searchLocation = locationSearchValue(job.location);
    const info = db
        .prepare(
            `INSERT INTO job_snapshots
                (company_id, external_id, title, location, location_search, apply_url, job_code, first_seen_at, last_seen_at,
                 employment_type, experience_level, department, posted_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
            companyId,
            job.externalId,
            job.title,
            job.location,
            searchLocation,
            job.applyUrl,
            job.jobCode ?? null,
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
        where.push('j.location_search LIKE @location');
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
                    j.title, j.location, j.apply_url AS applyUrl, j.job_code AS jobCode, j.employment_type AS employmentType,
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

    const locationCounts = new Map();
    for (const row of db
        .prepare("SELECT location FROM job_snapshots WHERE location IS NOT NULL AND location != ''")
        .all()) {
        for (const token of locationTokens(row.location)) {
            // Every job on this site is already Israel-based, so the generic
            // "Israel" bucket has no filtering power of its own — only a real
            // city or region does.
            if (!isIsraeliLocation(token) || token === 'Israel') continue;
            locationCounts.set(token, (locationCounts.get(token) || 0) + 1);
        }
    }

    const locations = Array.from(locationCounts, ([value, count]) => ({ value, count }))
        .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
        .slice(0, 60);

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
        locations,
        statuses: db
            .prepare('SELECT status AS value, COUNT(*) AS count FROM applications GROUP BY status')
            .all(),
        total: db.prepare('SELECT COUNT(*) AS n FROM job_snapshots').get().n,
    };
}

module.exports = { upsertJobSnapshot, queryJobs, filterOptions };
