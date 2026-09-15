/**
 * Saved search profiles — the filters that decide whether a new job is worth
 * telling you about. Thin SQL only.
 */

const { db } = require('./connection');
const { requireUser } = require('./tenancy');

/**
 * Every account's profiles, active or not — deliberately unscoped by user.
 * Called once per scrape cycle by scrapeService.js to check a new job against
 * every saved search system-wide, which is correct for a background job and
 * would be a cross-account leak for anything serving a browser request.
 *
 * Never expose this function's result to a route — see `listProfiles` below
 * for the user-scoped equivalent a route must use instead.
 */
function getActiveProfiles() {
    return db.prepare('SELECT * FROM search_profiles WHERE is_active = 1').all();
}

/** The signed-in account's own profiles, newest first. */
function listProfiles(userId) {
    const owner = requireUser(userId);
    return db.prepare('SELECT * FROM search_profiles WHERE user_id = ? ORDER BY id DESC').all(owner);
}

/** One profile, or null when it doesn't exist or belongs to someone else. */
function getProfile(userId, id) {
    const owner = requireUser(userId);
    return db.prepare('SELECT * FROM search_profiles WHERE user_id = ? AND id = ?').get(owner, id) ?? null;
}

/** @returns {number} the new profile's id */
function addSearchProfile({ userId, name, keywords, locationFilter, experienceFilter, employmentFilter }) {
    const owner = requireUser(userId);
    const info = db
        .prepare(
            `INSERT INTO search_profiles (user_id, name, keywords, location_filter, experience_filter, employment_filter)
             VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(owner, name, keywords, locationFilter ?? null, experienceFilter ?? null, employmentFilter ?? null);
    return info.lastInsertRowid;
}

/**
 * Partial update, same three-way convention as applications.js's
 * setApplication: a key absent from `fields` leaves that column alone, a key
 * present with `null`/`''` clears it (only meaningful for the two optional
 * filters), a key present with a value sets it.
 *
 * @returns {object|null} the updated row, or null when no such profile
 *   belongs to this user (a nonexistent id, or someone else's).
 */
function updateProfile(userId, id, fields) {
    const owner = requireUser(userId);
    const existing = db.prepare('SELECT * FROM search_profiles WHERE user_id = ? AND id = ?').get(owner, id);
    if (!existing) return null;

    const next = {
        name: 'name' in fields ? fields.name : existing.name,
        keywords: 'keywords' in fields ? fields.keywords : existing.keywords,
        location_filter: 'locationFilter' in fields ? fields.locationFilter || null : existing.location_filter,
        experience_filter: 'experienceFilter' in fields ? fields.experienceFilter || null : existing.experience_filter,
        employment_filter: 'employmentFilter' in fields ? fields.employmentFilter || null : existing.employment_filter,
        is_active: 'isActive' in fields ? (fields.isActive ? 1 : 0) : existing.is_active,
    };

    db.prepare(
        `UPDATE search_profiles SET name = ?, keywords = ?, location_filter = ?, experience_filter = ?,
                employment_filter = ?, is_active = ?
          WHERE user_id = ? AND id = ?`
    ).run(
        next.name,
        next.keywords,
        next.location_filter,
        next.experience_filter,
        next.employment_filter,
        next.is_active,
        owner,
        id
    );

    return db.prepare('SELECT * FROM search_profiles WHERE user_id = ? AND id = ?').get(owner, id);
}

/** @returns {boolean} whether a profile was actually deleted */
function deleteProfile(userId, id) {
    const owner = requireUser(userId);
    // Confirmed owned BEFORE touching notifications_sent below — that table
    // has no user_id of its own (owned indirectly through profile_id), so
    // deleting by a bare id with no ownership check first would let one
    // account delete another's notification history by guessing/iterating ids.
    const existing = db.prepare('SELECT id FROM search_profiles WHERE user_id = ? AND id = ?').get(owner, id);
    if (!existing) return false;

    db.prepare('DELETE FROM notifications_sent WHERE profile_id = ?').run(id);
    db.prepare('DELETE FROM search_profiles WHERE user_id = ? AND id = ?').run(owner, id);
    return true;
}

module.exports = { getActiveProfiles, listProfiles, getProfile, addSearchProfile, updateProfile, deleteProfile };
