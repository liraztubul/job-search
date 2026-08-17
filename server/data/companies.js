/**
 * Companies we watch. Thin SQL only — no business rules, no validation.
 */

const { db } = require('./connection');

function getActiveCompanies() {
    return db.prepare('SELECT * FROM watched_companies WHERE is_active = 1').all();
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

module.exports = { getActiveCompanies, listCompanies, findCompanyByName, addCompany, setFirstScrapedAt };
