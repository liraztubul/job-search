/**
 * probe.js — look at a career-site endpoint before writing an adapter for it.
 *
 *   node tools/probe.js "<url>"
 *
 * Prints the status, the response shape, and (for JSON) the field names of the
 * first job object — which is exactly what you need to fill in a RawJob mapping.
 * The full RAW body is saved so you can inspect the real HTML/JSON.
 *
 * Also exported as a module so tools/probe-all.js can drive it in batch.
 *
 * Zero dependencies. Requires Node 18+ (uses the built-in fetch).
 *
 * Why this exists: ComeetAdapter was written against documentation instead of a
 * real response, and it has never been proven to work. Run this first, always.
 */

const fs = require('fs');
const path = require('path');

// A default Node User-Agent is the most common reason a career site returns
// nothing. Look like a browser first, conclude "they block bots" second.
const HEADERS = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    Accept: 'application/json, text/html;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9,he;q=0.8',
};

/** Recursively find the biggest array-of-objects — usually the job list. */
function findJobArray(node, depth = 0, best = { path: '', arr: [] }) {
    if (depth > 6 || node === null || typeof node !== 'object') return best;

    for (const [key, value] of Object.entries(node)) {
        if (Array.isArray(value)) {
            const objects = value.filter((v) => v && typeof v === 'object');
            if (objects.length > best.arr.length) best = { path: key, arr: objects };
        } else if (typeof value === 'object') {
            best = findJobArray(value, depth + 1, best);
        }
    }
    return best;
}

function preview(value) {
    if (value === null || value === undefined) return String(value);
    if (typeof value === 'object') return Array.isArray(value) ? `[${value.length} items]` : '{object}';
    const s = String(value).replace(/\s+/g, ' ');
    return s.length > 70 ? `${s.slice(0, 70)}...` : s;
}

/** Rough signal that an HTML body actually contains job listings. */
function looksLikeJobHtml(body) {
    const hits = (body.match(/engineer|developer|software|מהנדס|מפתח/gi) || []).length;
    return { hits, likely: hits >= 5 };
}

/**
 * Fetch a URL and describe what came back. Never throws.
 * @returns {Promise<object>} a structured result
 */
async function probeUrl(url, { saveTo } = {}) {
    const result = { url, ok: false, status: null, contentType: null, size: 0, kind: 'error', notes: [] };

    let res;
    try {
        res = await fetch(url, { headers: HEADERS, redirect: 'follow' });
    } catch (err) {
        result.notes.push(`network error: ${err.message}`);
        return result;
    }

    const body = await res.text();
    result.status = res.status;
    result.contentType = res.headers.get('content-type') || 'unknown';
    result.size = body.length;
    result.finalUrl = res.url;

    if (saveTo) {
        fs.mkdirSync(path.dirname(saveTo), { recursive: true });
        fs.writeFileSync(saveTo, body, 'utf8');
        result.savedTo = saveTo;
    }

    if (!res.ok) {
        result.kind = 'http-error';
        result.notes.push(`HTTP ${res.status} ${res.statusText}`);
        return result;
    }

    if (body.length === 0) {
        result.kind = 'empty';
        result.notes.push('empty body — the endpoint rejected the request silently');
        return result;
    }

    if (result.contentType.includes('json')) {
        let data;
        try {
            data = JSON.parse(body);
        } catch (err) {
            result.kind = 'bad-json';
            result.notes.push(`claimed JSON but did not parse: ${err.message}`);
            return result;
        }

        const { path: key, arr } = Array.isArray(data)
            ? { path: '(root)', arr: data.filter((v) => v && typeof v === 'object') }
            : findJobArray(data);

        result.kind = 'json';
        result.ok = arr.length > 0;
        result.topLevelKeys = Array.isArray(data) ? ['(array)'] : Object.keys(data);
        result.jobArrayKey = key;
        result.jobCount = arr.length;
        result.fields = arr.length ? Object.entries(arr[0]).map(([k, v]) => [k, preview(v)]) : [];
        if (!arr.length) result.notes.push('parsed, but found no array of objects');
        return result;
    }

    const { hits, likely } = looksLikeJobHtml(body);
    result.kind = 'html';
    result.ok = likely;
    result.jobWordHits = hits;
    result.notes.push(
        likely
            ? `server-rendered: ${hits} job-ish words in the HTML — scrapeable with cheerio`
            : `client-rendered: only ${hits} job-ish words — open DevTools > Network > Fetch/XHR`
    );
    return result;
}

/** Human-readable single-URL output for the CLI. */
function printResult(r) {
    console.log(`Status:       ${r.status ?? 'no response'}`);
    console.log(`Content-Type: ${r.contentType ?? '-'}`);
    console.log(`Body size:    ${r.size} chars`);
    if (r.savedTo) console.log(`Raw body:     ${r.savedTo}`);
    for (const note of r.notes) console.log(`Note:         ${note}`);

    if (r.kind === 'json') {
        console.log(`\nTop-level keys: ${r.topLevelKeys.join(', ')}`);
        if (r.jobCount) {
            console.log(`Likely job array: "${r.jobArrayKey}" (${r.jobCount} items)\n`);
            console.log('Fields on the first item — map these into RawJob:');
            console.log('-'.repeat(72));
            for (const [field, value] of r.fields) console.log(`  ${field.padEnd(28)} ${value}`);
            console.log('-'.repeat(72));
            console.log('\nRawJob needs: externalId, title, location, applyUrl');
            console.log('Pick a STABLE id (requisition number or uuid), not an array index.\n');
        }
    }
}

async function main() {
    const url = process.argv[2];
    if (!url) {
        console.log('Usage: node tools/probe.js "<url>"');
        console.log('       node tools/probe-all.js        (probes every pending company)');
        process.exit(1);
    }
    console.log(`\nGET ${url}\n`);
    const result = await probeUrl(url, { saveTo: path.join(__dirname, 'probe-output.txt') });
    printResult(result);
}

if (require.main === module) main();

module.exports = { probeUrl, printResult, HEADERS };
