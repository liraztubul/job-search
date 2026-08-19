/**
 * Job rows: writing what a scrape found, and reading it back for the UI.
 *
 * `location_search` is a denormalized copy of the location, canonicalized on the
 * way in (see server/domain/locations.js), so the UI can filter on one spelling
 * per city instead of every source's own wording.
 */

const { db } = require('./connection');
const { locationTokens, locationSearchValue, isIsraeliLocation } = require('../domain/locations');
const { isValidPostedAt } = require('../domain/jobFreshness');
// resolveViewer, not requireUser: the job list is public, so a logged-out
// visitor is an allowed caller here (and only here — see tenancy.js). It still
// throws on undefined, so a forgotten user id is still a crash.
const { resolveViewer, requireUser, GUEST } = require('./tenancy');

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/**
 * posted_at is a strict invariant: a real ISO date the source reports as the
 * job's first-published date, or NULL — never anything else. Enforced here,
 * at the one place every adapter's output passes through, rather than
 * trusted from each adapter individually — see docs/ARCHITECTURE.md and
 * server/domain/jobFreshness.js for why (relative text, last-modified
 * timestamps mistaken for posting dates, and future dates have all shown up
 * from real sources).
 */
const sanitizePostedAt = (value) => (isValidPostedAt(value) ? value : null);

/** Returns { isNew, id } — inserts if unseen, otherwise just bumps last_seen_at */
function upsertJobSnapshot(companyId, job) {
    const now = new Date().toISOString();
    const postedAt = sanitizePostedAt(job.postedAt);
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
            postedAt,
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
            postedAt
        );
    return { isNew: true, id: info.lastInsertRowid };
}

// ---------------------------------------------------------------------------
// Sanity gate + closure detection — see server/services/scrapeService.js and
// docs/ARCHITECTURE.md §4.2/§4.3. "No jobs" and "the scraper broke" look
// identical in the data; these two functions are what let the caller tell
// them apart before trusting either one.
// ---------------------------------------------------------------------------

/** The sanity gate's baseline: how many jobs are currently believed open for
 * this company, before this cycle's result is judged against it. */
function countOpenJobs(companyId) {
    return db.prepare('SELECT COUNT(*) AS n FROM job_snapshots WHERE company_id = ? AND is_still_open = 1').get(companyId).n;
}

/**
 * Marks every currently-open job for this company that was NOT in
 * `seenExternalIds` as closed. Only ever safe to call after the sanity gate
 * has passed (see scrapeService.js) — this function itself has no way to
 * tell "the company closed these roles" apart from "the scraper broke and
 * returned an empty list", it just trusts the caller already did.
 *
 * Reads the (small, bounded-per-company) set of open rows and diffs in JS
 * rather than a single `external_id NOT IN (...)` statement — building that
 * with a few hundred dynamic placeholders is more fragile than it's worth
 * for something that runs once per company per cycle, not per request.
 *
 * @returns {number} how many jobs were closed
 */
function closeMissingJobs(companyId, seenExternalIds, now = new Date().toISOString()) {
    const openRows = db
        .prepare('SELECT id, external_id FROM job_snapshots WHERE company_id = ? AND is_still_open = 1')
        .all(companyId);
    const seen = new Set(seenExternalIds);
    const toClose = openRows.filter((row) => !seen.has(row.external_id));
    if (toClose.length === 0) return 0;

    const close = db.prepare('UPDATE job_snapshots SET is_still_open = 0, closed_at = ? WHERE id = ?');
    for (const row of toClose) close.run(now, row.id);
    return toClose.length;
}

/**
 * Every open job's `external_id` for a company — what `closeMissingJobs`
 * treats as "seen" when nothing new was actually scraped. Lets a caller that
 * only wants to close ONE specific job reuse `closeMissingJobs` instead of a
 * second closing routine: pass this list minus the one external_id that
 * should close, and every other currently-open job counts as "seen" and is
 * left alone. See `services/jobVerifyService.js`.
 */
function listOpenExternalIds(companyId) {
    return db
        .prepare('SELECT external_id FROM job_snapshots WHERE company_id = ? AND is_still_open = 1')
        .all(companyId)
        .map((row) => row.external_id);
}

/**
 * One job by id, with enough of its company to verify and close it —
 * `companyId` for `closeMissingJobs`/`listOpenExternalIds`, `externalId` to
 * know which one to remove from the "seen" list, `companyAdapterType` so a
 * caller can refuse to verify a `manual`-adapter company at all (see
 * services/jobVerifyService.js — those companies are hand-maintained
 * specifically because their site blocks automated requests, so a
 * server-side fetch would always read as "gone").
 */
function findJobById(jobId) {
    return db
        .prepare(
            `SELECT j.id, j.external_id AS externalId, j.apply_url AS applyUrl, j.is_still_open AS isStillOpen,
                    j.company_id AS companyId, c.name AS company, c.adapter_type AS companyAdapterType
               FROM job_snapshots j
               JOIN watched_companies c ON c.id = j.company_id
              WHERE j.id = ?`
        )
        .get(jobId);
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
    // Closed postings never show in the search results — a card that opens
    // to a dead link on the source site is worse than not listing it at all.
    // Unconditional, not an opt-in filter: closeMissingJobs() (see
    // scrapeService.js) is the only thing that ever sets this to 0, and once
    // it does, the listing has nothing left to offer a browsing visitor.
    // A tracked application is a different table (applications.js's
    // listApplications has no such filter, on purpose) — closing a job must
    // never make someone's own tracked application vanish from their
    // dashboard, only from the public search.
    where.push('j.is_still_open = 1');

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
 *
 * `companyRecency` (the default sort only, not "sort by title") is the fix for
 * a real usability bug: the day a company is added, its whole back catalogue
 * lands with nearly-identical `first_seen_at` values from that one bulk
 * insert, all newer than any other company's most recent job — so plain
 * `first_seen_at DESC` put that one company's postings across the entire
 * first page and made the site look like it tracked a single employer. A
 * `ROW_NUMBER() OVER (PARTITION BY j.company_id ORDER BY first_seen_at DESC)`
 * ranks each company's own postings by recency, and ordering by that rank
 * first means every company's single newest posting is shown before anyone's
 * second-newest — genuinely new postings (which have rank 1 the moment they
 * exist) still surface immediately, but one company's bulk-loaded history can
 * no longer bury every other company on page one.
 */
function queryJobs(userId, filters = {}) {
    const owner = resolveViewer(userId);
    const { whereClause, params } = buildJobFilters(filters, owner);
    const { page, pageSize } = clampPaging(filters);
    const sort =
        filters.sort === 'title'
            ? 'j.title COLLATE NOCASE ASC, j.id DESC'
            : 'companyRecency ASC, j.first_seen_at DESC, j.id DESC';

    const jobs = db
        .prepare(
            `SELECT j.id, j.external_id AS externalId,
                    j.title, j.location, j.apply_url AS applyUrl, j.job_code AS jobCode, j.employment_type AS employmentType,
                    j.experience_level AS experienceLevel, j.department, j.posted_at AS postedAt,
                    j.first_seen_at AS firstSeenAt, j.is_still_open AS isStillOpen,
                    c.name AS company, c.id AS companyId, c.first_scraped_at AS companyFirstScrapedAt,
                    a.status, a.notes, a.applied_at AS appliedAt,
                    ROW_NUMBER() OVER (PARTITION BY j.company_id ORDER BY j.first_seen_at DESC, j.id DESC) AS companyRecency
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
        // is_active = 0 excludes a company from the filter entirely, not just
        // from future scrapes — a company the site has stopped tracking (see
        // CLAUDE.md's note on IBM Israel) must not still be offered as a
        // filter option implying there's something behind it to browse.
        companies: db
            .prepare(
                `SELECT c.id, c.name, COUNT(j.id) AS count
                   FROM watched_companies c LEFT JOIN job_snapshots j ON j.company_id = c.id
                  WHERE c.is_active = 1
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

module.exports = {
    upsertJobSnapshot,
    queryJobs,
    countJobs,
    filterOptions,
    countOpenJobs,
    closeMissingJobs,
    listOpenExternalIds,
    findJobById,
};
