const fs = require('fs');
const path = require('path');
const { JobSource } = require('./JobSource');
const { normalizeEmploymentType, guessExperienceFromTitle } = require('../domain/vocabulary');

/**
 * Jobs you enter by hand, from a JSON file.
 *
 * WHY THIS EXISTS
 *
 * Some companies cannot be scraped, and that is a decision they made rather
 * than a puzzle to solve. Rafael sits behind Reblaze; AllJobs, checked as an
 * indirect route to the same postings, is behind hCaptcha and the same family
 * of bot management. Both are security products saying no, and getting past
 * them is not a technical problem this project is willing to treat as one.
 *
 * The result was that those companies were simply absent — not tracked, not
 * filterable, not part of the application dashboard. This closes that gap the
 * boring way: you paste in what you find, and from that point every other
 * feature treats it like any other job.
 *
 * WHAT IT IS NOT
 *
 * Not a scraper, and not a workaround. Nothing here contacts the company at
 * all. It reads a file you maintain.
 *
 * FILE FORMAT — data/manual/<name>.json
 *
 * [
 *   {
 *     "externalId": "12345",              required, anything stable and unique
 *     "title": "Embedded Engineer",       required
 *     "applyUrl": "https://...",          required
 *     "location": "Haifa",                optional
 *     "department": "R&D",                optional
 *     "employmentType": "Full time",      optional, normalized on the way in
 *     "postedAt": "2026-08-01",           optional
 *     "jobCode": "REQ-88"                 optional
 *   }
 * ]
 *
 * Keep `externalId` stable. Change it and the job counts as brand new: it
 * re-alerts, and any application you tracked against the old one is orphaned.
 */

const MANUAL_DIR = path.join(__dirname, '..', '..', 'data', 'manual');

/** Pure mapping, exported so it can be tested without touching the disk. */
function mapManualJob(raw, index) {
    const externalId = String(raw.externalId ?? '').trim();
    const title = String(raw.title ?? '').trim();
    const applyUrl = String(raw.applyUrl ?? '').trim();

    // A typo in a hand-written file should name the entry it's in. "undefined
    // is not a string" three screens later helps nobody.
    if (!externalId) throw new Error(`entry ${index + 1}: missing "externalId"`);
    if (!title) throw new Error(`entry ${index + 1} (${externalId}): missing "title"`);
    if (!applyUrl) throw new Error(`entry ${index + 1} (${title}): missing "applyUrl"`);

    return {
        externalId,
        title,
        applyUrl,
        location: String(raw.location ?? '').trim(),
        department: raw.department ? String(raw.department).trim() : null,
        employmentType: normalizeEmploymentType(raw.employmentType),
        experienceLevel: guessExperienceFromTitle(title),
        postedAt: raw.postedAt ? String(raw.postedAt).slice(0, 10) : null,
        jobCode: raw.jobCode != null ? String(raw.jobCode) : null,
    };
}

/** Pure parse: file contents -> RawJob[]. */
function parseManualJobs(contents, label = 'file') {
    let rows;
    try {
        rows = JSON.parse(contents);
    } catch (err) {
        throw new Error(`${label} is not valid JSON: ${err.message}`);
    }

    if (!Array.isArray(rows)) {
        throw new Error(`${label} must contain a JSON array, got ${typeof rows}`);
    }

    const jobs = rows.map(mapManualJob);

    const ids = jobs.map((job) => job.externalId);
    const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
    if (duplicate) {
        // Left alone, the second entry silently overwrites the first on every
        // cycle and one of the two jobs is permanently invisible.
        throw new Error(`${label} has two entries with externalId "${duplicate}"`);
    }

    return jobs;
}

class ManualAdapter extends JobSource {
    static type = 'manual';
    static describe = {
        help: 'Jobs you maintain by hand, for companies that block automated access.',
        required: { file: "file name under data/manual/, e.g. 'rafael'" },
        optional: {},
    };

    constructor(config = {}) {
        super();
        this.file = String(config.file || '').replace(/\.json$/, '');
    }

    get filePath() {
        // Never let a config value escape the folder.
        const resolved = path.join(MANUAL_DIR, `${path.basename(this.file)}.json`);
        if (!resolved.startsWith(MANUAL_DIR)) throw new Error(`invalid manual file name: ${this.file}`);
        return resolved;
    }

    async getCurrentJobs() {
        let contents;
        try {
            contents = fs.readFileSync(this.filePath, 'utf8');
        } catch {
            throw new Error(
                `No manual job file at ${this.filePath}. Create it with a JSON array — ` +
                    'see the format at the top of server/adapters/manualAdapter.js'
            );
        }

        const jobs = parseManualJobs(contents, path.basename(this.filePath));

        // An empty file is almost certainly mid-edit, not "this company has no
        // openings". Same rule as every other adapter: don't act on nothing.
        if (jobs.length === 0) {
            throw new Error(`${path.basename(this.filePath)} is an empty list — nothing to track.`);
        }

        return jobs;
    }
}

module.exports = { ManualAdapter, mapManualJob, parseManualJobs, MANUAL_DIR };
