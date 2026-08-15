/**
 * Saved search profiles — the filters that decide whether a new job is worth
 * telling you about. Thin SQL only.
 *
 * NEITHER FUNCTION BELOW IS SCOPED BY requireUser, AND THAT IS CURRENTLY SAFE
 * ONLY BECAUSE NOTHING HERE IS REACHABLE FROM AN HTTP ROUTE YET.
 *
 * `getActiveProfiles()` deliberately returns every account's profiles — it's
 * called once per scrape cycle by scrapeService.js to check a new job against
 * every saved search system-wide, which is correct for a background job and
 * would be a cross-account leak for anything serving a browser request. If a
 * profiles API/UI is ever built (see docs/ROADMAP.md), it needs its own
 * user-scoped query (`WHERE user_id = ?`, threaded through `requireUser`,
 * same pattern as applications.js) — do not expose this function's result to
 * a route. This is the same bug class the AMENDMENT A fix in jobs.js's
 * `filterOptions()` closed for the applications-status facet; this file is
 * the next place it would reappear.
 *
 * `addSearchProfile()` doesn't even accept a `userId` — its INSERT is missing
 * the column entirely, which the schema's `NOT NULL` would reject outright.
 * It has no caller anywhere in the codebase today; whoever wires up the first
 * one needs to add `userId` to both the signature and the INSERT.
 */

const { db } = require('./connection');

function getActiveProfiles() {
    return db.prepare('SELECT * FROM search_profiles WHERE is_active = 1').all();
}

/** @returns {number} the new profile's id */
function addSearchProfile({ name, keywords, locationFilter, experienceFilter }) {
    const info = db
        .prepare(
            `INSERT INTO search_profiles (name, keywords, location_filter, experience_filter)
             VALUES (?, ?, ?, ?)`
        )
        .run(name, keywords, locationFilter ?? null, experienceFilter ?? null);
    return info.lastInsertRowid;
}

module.exports = { getActiveProfiles, addSearchProfile };
