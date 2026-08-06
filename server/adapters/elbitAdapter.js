const { JobSource } = require('./JobSource');
const { decodeEntities, HTML_HEADERS } = require('./htmlUtils');
const { normalizeEmploymentType, guessExperienceFromTitle } = require('../domain/vocabulary');

/**
 * Elbit Systems publishes its whole vacancy list as one static JSON file:
 *
 *   https://elbitsystemscareer.com/cron/jobs.json?t=<timestamp>
 *
 * Their careers site is a Next.js app that renders nothing without JavaScript,
 * so the file was found by running a real browser and recording its XHR —
 * `node tools/sniff.js elbit`. It was the only request the page made.
 *
 * Verified against a live capture on 2026-08-05: a flat array of 670 objects,
 * every one carrying a unique jobId and jobCode. Fields the mapper reads are in
 * tests/fixtures/elbit-jobs.json, copied verbatim.
 *
 * The `t=` parameter is a cache-buster, not auth. We send one for the same
 * reason their own site does: this is a static file behind a CDN.
 */

const ENDPOINT = 'https://elbitsystemscareer.com/cron/jobs.json';
const LISTING_URL = 'https://elbitsystemscareer.com/jobs';

/**
 * Pure mapping: one raw Elbit job -> RawJob. Exported for testing without
 * touching the network.
 *
 * @param {object} raw
 * @param {string|null} jobUrlTemplate  e.g. 'https://.../jobs/{jobId}'. Left
 *   null by default: the site opens jobs through its client-side router and
 *   publishes no per-job URL we could verify, so we link to the listing rather
 *   than invent an address that might 404.
 */
function mapElbitJob(raw, jobUrlTemplate = null) {
    const externalId = String(raw.jobId ?? '');
    if (!externalId) {
        throw new Error(`Elbit job has no jobId: ${JSON.stringify(raw).slice(0, 120)}`);
    }

    const title = decodeEntities(raw.jobTitle || '');

    const applyUrl = jobUrlTemplate
        ? jobUrlTemplate.replace('{jobId}', externalId).replace('{jobCode}', String(raw.jobCode ?? ''))
        : LISTING_URL;

    const location = decodeEntities(raw.locationAddress || raw.area || '');

    return {
        externalId,
        title,
        // Prefer the city/address field when available, because Elbit's `area`
        // values are broad regions like "North" and don't match city filters
        // such as Haifa. Fall back to `area` when the address is absent.
        location,
        applyUrl,
        // The requisition number the site shows as "זיהוי דרישה" — the one you
        // quote to a recruiter.
        department: raw.employerName || null,
        employmentType: normalizeEmploymentType(raw.employmentType),
        experienceLevel: guessExperienceFromTitle(title),
        postedAt: raw.openDate ? String(raw.openDate).slice(0, 10) : null,
        jobCode: raw.jobCode != null ? String(raw.jobCode) : null,
    };
}

class ElbitAdapter extends JobSource {
    static type = 'elbit';
    static describe = {
        help: 'Elbit Systems. Static JSON behind their Next.js site. Verified 2026-08-05.',
        required: {},
        optional: {
            jobUrlTemplate:
                "per-job link pattern once you know it, e.g. 'https://elbitsystemscareer.com/jobs/{jobId}'",
        },
    };

    constructor(config = {}) {
        super();
        this.jobUrlTemplate = config.jobUrlTemplate ?? null;
    }

    async getCurrentJobs() {
        const res = await fetch(`${ENDPOINT}?t=${Date.now()}`, { headers: HTML_HEADERS });
        if (!res.ok) {
            throw new Error(`Elbit fetch failed: ${res.status} ${res.statusText}`);
        }

        const data = await res.json();
        if (!Array.isArray(data)) {
            throw new Error(`Elbit response shape changed: expected an array, got ${typeof data}`);
        }

        // Every job in the capture had status 1. Filter anyway — a closed
        // vacancy appearing here later shouldn't quietly become a new alert.
        const open = data.filter((job) => job.status === 1 || job.status === undefined);

        const jobs = open.map((job) => mapElbitJob(job, this.jobUrlTemplate));

        if (jobs.length === 0) {
            throw new Error(
                `Elbit returned ${data.length} rows but none were open — that looks like a shape ` +
                    'change, not an empty company. Re-run: node tools/sniff.js elbit'
            );
        }

        return jobs;
    }
}

module.exports = { ElbitAdapter, mapElbitJob };
