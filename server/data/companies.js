/**
 * Companies we watch. Thin SQL only — no business rules, no validation.
 */

const { db } = require('./connection');

/**
 * What a scrape cycle actually visits — `is_active = 1` and not link-only.
 * A link-only company (Rafael; see the comment on watched_companies in
 * schema.sql) is deliberately never fetched, so it is excluded here rather
 * than left for scrapeService.js to skip case by case — the one place that
 * decides what gets scraped is the one place that needs to know why not.
 */
function getActiveCompanies() {
    return db.prepare('SELECT * FROM watched_companies WHERE is_active = 1 AND link_only_reason IS NULL').all();
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

/**
 * Records the end of this company's first successful (sanity-gate-passing)
 * scrape cycle — see scrapeService.js and server/domain/jobFreshness.js. Set
 * once; the `WHERE first_scraped_at IS NULL` makes every later call a no-op,
 * so scrapeService can call this unconditionally after every healthy cycle
 * without needing to track "have I already set this" itself.
 */
function setFirstScrapedAt(companyId, timestamp) {
    db.prepare('UPDATE watched_companies SET first_scraped_at = ? WHERE id = ? AND first_scraped_at IS NULL').run(
        timestamp,
        companyId
    );
}

/**
 * Stops (or resumes) tracking a company: `is_active = 0` excludes it from
 * `getActiveCompanies()` (no future scrape cycle touches it) AND from the
 * filter dropdown (`filterOptions()` in jobs.js) — a company the site has
 * stopped tracking must not still be offered as something to browse. Existing
 * `job_snapshots` rows are left untouched either way; this only changes
 * whether the company is scraped and offered going forward.
 */
function setCompanyActive(companyId, isActive) {
    db.prepare('UPDATE watched_companies SET is_active = ? WHERE id = ?').run(isActive ? 1 : 0, companyId);
}

/**
 * A human's deliberate "I know about this" — see the comment on
 * watched_companies in schema.sql. `kind` is one of
 * server/domain/scrapeOutcome.js's FAILURE_KIND values; scrapeService.js
 * mutes a failure of exactly this kind for this company, and no other.
 */
function setKnownIssue(companyId, kind, reason) {
    db.prepare(
        'UPDATE watched_companies SET known_issue_kind = ?, known_issue_reason = ?, known_issue_at = ? WHERE id = ?'
    ).run(kind, reason, new Date().toISOString(), companyId);
}

function clearKnownIssue(companyId) {
    db.prepare(
        'UPDATE watched_companies SET known_issue_kind = NULL, known_issue_reason = NULL, known_issue_at = NULL WHERE id = ?'
    ).run(companyId);
}

/**
 * The sanity gate trusted this cycle's result (either normally, or because a
 * drop repeated closely enough to be believed — see scrapeSanity.js) —
 * clears the streak so a future, unrelated refusal starts counting from
 * scratch rather than inheriting an old one.
 */
function resetRefusalStreak(companyId) {
    db.prepare('UPDATE watched_companies SET refusal_streak = 0, last_refused_count = NULL WHERE id = ?').run(companyId);
}

/**
 * The sanity gate refused this cycle's result. Records what it refused (so
 * the NEXT cycle's evaluateSanityGate call can compare against it — see
 * scrapeSanity.js) and returns the new streak length, which is what
 * scrapeService.js uses to decide whether this has gone on long enough (3
 * in a row) to escalate from a quiet "refused" to a loud "broken".
 *
 * @returns {number} the streak length after this refusal
 */
function recordRefusal(companyId, returnedCount) {
    const before = db.prepare('SELECT refusal_streak FROM watched_companies WHERE id = ?').get(companyId);
    const streak = (before?.refusal_streak || 0) + 1;
    db.prepare('UPDATE watched_companies SET refusal_streak = ?, last_refused_count = ? WHERE id = ?').run(
        streak,
        returnedCount,
        companyId
    );
    return streak;
}

/**
 * "Listed, but not collected" — see the comment on watched_companies in
 * schema.sql. Distinct from setKnownIssue on purpose: an acknowledgment says
 * a *failure* is expected right now; this says there is no attempt to fail
 * in the first place. Reversible — existing job_snapshots rows are never
 * touched by either this or clearLinkOnly, only whether they're offered.
 */
function setLinkOnly(companyId, reason) {
    db.prepare('UPDATE watched_companies SET link_only_reason = ? WHERE id = ?').run(reason, companyId);
}

function clearLinkOnly(companyId) {
    db.prepare('UPDATE watched_companies SET link_only_reason = NULL WHERE id = ?').run(companyId);
}

module.exports = {
    getActiveCompanies,
    listCompanies,
    findCompanyByName,
    addCompany,
    setFirstScrapedAt,
    setCompanyActive,
    setKnownIssue,
    clearKnownIssue,
    resetRefusalStreak,
    recordRefusal,
    setLinkOnly,
    clearLinkOnly,
};
