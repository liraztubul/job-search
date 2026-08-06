/**
 * Saved search profiles — the filters that decide whether a new job is worth
 * telling you about. Thin SQL only.
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
