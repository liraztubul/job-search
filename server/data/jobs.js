/**
 * Job rows: writing what a scrape found, and reading it back for the UI.
 *
 * `location_search` is a denormalized copy of the location, canonicalized on the
 * way in (see server/domain/locations.js), so the UI can filter on one spelling
 * per city instead of every source's own wording.
 */

const { db } = require('./connection');
const { locationTokens, locationSearchValue, isIsraeliLocation } = require('../domain/locations');
// resolveViewer, not requireUser: the job list is public, so a logged-out
// visitor is an allowed caller here (and only here — see tenancy.js). It still
// throws on undefined, so a forgotten user id is still a crash.
const { resolveViewer, requireUser, GUEST } = require('./tenancy');

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

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
 * Shared by queryJobs and countJobs so they can never disagree about which
 * rows match — countJobs would be pointless as a sanity check on pagination
 * if the two built their WHERE clauses independently and drifted apart.
 *
 * `a.status` is read from `applications`, a personal table, so the join that
 * uses this clause must also carry `AND a.user_id = ?` — the WHERE
 * clause alone doesn't scope the join, that's the caller's job.
 */
/**
 * POSITIONAL `?` PARAMETERS, NOT NAMED `@name` ONES
 *
 * This used to bind `@companyId`, `@q` and friends from an object, which is
 * more readable and is what better-sqlite3 documents. It does not survive the
 * remote protocol: against a hosted libSQL database the named values are not
 * bound, every filtered comparison becomes `column = NULL`, and the query
 * returns zero rows — no error, no warning, just an empty list.
 *
 * It hid for a long time because the *unfiltered* query has exactly one
 * parameter, `owner`, and it sits in a LEFT JOIN. An unbound owner makes the
 * join match nothing, which is precisely what a logged-out visitor should see.
 * The page looked perfect until someone picked a company.
 *
 * Positional parameters work identically on both, so there is one code path
 * again rather than one that is exercised and one that is merely hoped for.
 *
 * The cost is that ORDER NOW MATTERS: `owner` is bound first because
 * `a.user_id = ?` appears in the JOIN, ahead of the WHERE clause. Both callers
 * must keep that shape, which is why they share this function.
 *
 * @returns {{whereClause: string, params: unknown[]}} params[0] is always owner
 */
function buildJobFilters(filters, owner) {
    const where = ['1 = 1'];
    const params = [owner];

    if (filters.companyId) {
        where.push('j.company_id = ?');
        params.push(Number(filters.companyId));
    }
    if (filters.employmentType) {
        where.push('j.employment_type = ?');
        params.push(filters.employmentType);
    }
    if (filters.experienceLevel) {
        where.push('j.experience_level = ?');
        params.push(filters.experienceLevel);
    }
    // Any one of several locations, not all of them — a job is in Tel Aviv OR
    // Haifa, never both, so "narrow to these cities" has to mean OR across the
    // list. One placeholder per value; a LIKE list can't be bound as an array.
    if (filters.locations && filters.locations.length) {
        const clauses = filters.locations.map((loc) => {
            params.push(`%${loc}%`);
            return 'j.location_search LIKE ?';
        });
        where.push(`(${clauses.join(' OR ')})`);
    }
    if (filters.q) {
        // Two placeholders, so the value is pushed twice — with positional
        // parameters a repeated value is not a repeated name.
        where.push('(j.title LIKE ? OR j.department LIKE ?)');
        params.push(`%${filters.q}%`, `%${filters.q}%`);
    }
    if (filters.status) {
        where.push(filters.status === 'none' ? 'a.status IS NULL' : 'a.status = ?');
        if (filters.status !== 'none') params.push(filters.status);
    }
    if (filters.openOnly) {
        where.push('j.is_still_open = 1');
    }

    return { whereClause: where.join(' AND '), params };
}

/** Clamp to a page/pageSize SQLite will never choke on — 1+ and 1..100. */
/**
 * `LIMIT n OFFSET m`, written into the SQL rather than bound as parameters.
 *
 * WHY, BECAUSE THIS LOOKS LIKE THE WRONG THING TO DO
 *
 * Every other value in this file is a bound parameter, and that is correct:
 * bound parameters are how untrusted input stays data instead of becoming SQL.
 * These two are different in a way that forces the exception.
 *
 * SQLite is loosely typed almost everywhere — it will happily compare 1.0 to 1
 * — but LIMIT and OFFSET are two of the few places it insists on an integer and
 * raises "datatype mismatch" otherwise. Every JavaScript number is a double, so
 * whether `20` arrives as INTEGER 20 or REAL 20.0 depends entirely on the
 * driver. The native binding converts integral doubles to integers; the remote
 * Hrana protocol sends a JSON number and SQLite sees a float and refuses.
 *
 * The result was a query that worked perfectly against a local file and failed
 * on every page load against the hosted database — the same class of bug as
 * `db.transaction()` and the missing migration columns, and the third one this
 * deployment found.
 *
 * Interpolating is safe here only because these two values cannot be anything
 * but integers: `clampPaging` truncates and clamps them, and the assertion
 * below makes that a crash rather than an assumption if it ever stops being
 * true. Do not copy this pattern for a value that comes from a request.
 */
function limitClause(pageSize, offset) {
    if (!Number.isInteger(pageSize) || !Number.isInteger(offset) || pageSize < 1 || offset < 0) {
        throw new Error(`limitClause: refusing to inline non-integer paging (${pageSize}, ${offset})`);
    }
    return `${pageSize} OFFSET ${offset}`;
}

function clampPaging(filters) {
    const page = Math.max(1, Math.trunc(Number(filters.page)) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(Number(filters.pageSize)) || DEFAULT_PAGE_SIZE));
    return { page, pageSize };
}

/**
 * One page of the filtered job list. Every filter is optional; omitted ones
 * don't constrain. Built as parameterised SQL — never string-concatenated
 * with user input.
 *
 * `, j.id DESC` is not decoration: `first_seen_at` alone is not a unique
 * order (a whole scrape's worth of jobs — 673 of them, for Elbit — share one
 * timestamp), so without a tiebreaker SQLite is free to order ties
 * differently between two calls and a job can appear on two pages, or none.
 */
function queryJobs(userId, filters = {}) {
    const owner = resolveViewer(userId);
    const { whereClause, params } = buildJobFilters(filters, owner);
    const { page, pageSize } = clampPaging(filters);
    const sort =
        filters.sort === 'title'
            ? 'j.title COLLATE NOCASE ASC, j.id DESC'
            : 'j.first_seen_at DESC, j.id DESC';

    const jobs = db
        .prepare(
            `SELECT j.id, j.external_id AS externalId,
                    j.title, j.location, j.apply_url AS applyUrl, j.job_code AS jobCode, j.employment_type AS employmentType,
                    j.experience_level AS experienceLevel, j.department, j.posted_at AS postedAt,
                    j.first_seen_at AS firstSeenAt, j.is_still_open AS isStillOpen,
                    c.name AS company, c.id AS companyId,
                    a.status, a.notes, a.applied_at AS appliedAt
               FROM job_snapshots j
               JOIN watched_companies c ON c.id = j.company_id
               LEFT JOIN applications a ON a.job_snapshot_id = j.id AND a.user_id = ?
              WHERE ${whereClause}
              ORDER BY ${sort}
              LIMIT ${limitClause(pageSize, (page - 1) * pageSize)}`
        )
        .all(...params);

    return { jobs, page, pageSize };
}

/**
 * How many rows `queryJobs` would page through in total — a second query
 * with the identical WHERE clause, not a number derived from one page's
 * results. That's the whole point: a page of 20 rows can never tell you
 * whether 21 or 21,000 more exist.
 */
function countJobs(userId, filters = {}) {
    const owner = resolveViewer(userId);
    const { whereClause, params } = buildJobFilters(filters, owner);

    return db
        .prepare(
            `SELECT COUNT(*) AS n
               FROM job_snapshots j
               LEFT JOIN applications a ON a.job_snapshot_id = j.id AND a.user_id = ?
              WHERE ${whereClause}`
        )
        .get(...params).n;
}

/**
 * Distinct values actually present in the data — so the UI never offers an
 * empty filter.
 *
 * `statuses` is the one personal facet here (application status is per
 * account, everything else — companies, employment types, locations — is the
 * shared job market). It is included only for a real signed-in caller, scoped
 * to that account's own rows.
 *
 * @param {number|typeof GUEST} userId
 */
function filterOptions(userId) {
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

    const options = {
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
        total: db.prepare('SELECT COUNT(*) AS n FROM job_snapshots').get().n,
    };

    // A logged-out visitor gets no `statuses` key at all — not an empty
    // array, which reads identically to "you have zero tracked applications"
    // for a real account, and not an aggregate across every account either
    // (that was the bug this guard exists to fix: the query below used to run
    // unconditionally with no WHERE clause, so every visitor — including
    // guests — received application-status counts from every account
    // combined).
    if (userId !== GUEST) {
        const owner = requireUser(userId);
        options.statuses = db
            .prepare('SELECT status AS value, COUNT(*) AS count FROM applications WHERE user_id = ? GROUP BY status')
            .all(owner);
    }

    return options;
}

module.exports = { upsertJobSnapshot, queryJobs, countJobs, filterOptions };
