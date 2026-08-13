/**
 * sniff.js — the DevTools Network tab, automated.
 *
 *   node tools/sniff.js                 sniff every company still missing an adapter
 *   node tools/sniff.js elbit           just one
 *   node tools/sniff.js "https://..."   any URL
 *
 * Opens the page in a real Chromium, lets its JavaScript run, records every XHR
 * the page fires, and ranks the responses by how much they look like job data.
 * That is exactly the manual ritual — F12, Network, filter Fetch/XHR, hunt for
 * the request whose Response has job titles in it — minus the hunting.
 *
 * Needed because Microsoft, NVIDIA, IBM and Elbit are single-page apps: their
 * HTML arrives empty and the jobs are fetched afterwards. probe.js can't see
 * that, because probe.js doesn't execute JavaScript. A browser does.
 *
 * SETUP (one time, ~150MB):
 *   npm install --save-dev playwright
 *   npx playwright install chromium
 *
 * Output: tools/output/sniff-report.md  +  raw bodies in
 * tools/output/probe-bodies/ — same scratch directory probe-all.js writes
 * to, all gitignored.
 */

const fs = require('fs');
const path = require('path');

const BODIES = path.join(__dirname, 'output', 'probe-bodies');
const REPORT = path.join(__dirname, 'output', 'sniff-report.md');

/**
 * `solved: true` means the company already has a working adapter. Those are
 * skipped when you run with no arguments, but you can still sniff one by name
 * to re-check it after a site redesign.
 */
const TARGETS = {
    microsoft: { url: 'https://jobs.careers.microsoft.com/global/en/search?lc=Israel' },
    ibm: { url: 'https://www.ibm.com/careers/search' },
    dell: { url: 'https://enterpriseplatform.dell.com/hcmUI/CandidateExperience/en/sites/careers/jobs' },
    apple: { url: 'https://jobs.apple.com/en-il/search?location=israel-ISR' },
    nvidia: { url: 'https://jobs.nvidia.com/careers?start=0', solved: true },
    elbit: { url: 'https://elbitsystemscareer.com/jobs', solved: true },
};

// Words that suggest a response actually carries job postings.
const JOB_WORDS = /engineer|developer|software|position|requisition|vacancy|job|career|מהנדס|מפתח|משרה/i;

function loadPlaywright() {
    try {
        return require('playwright');
    } catch {
        console.error('\nPlaywright is not installed. It runs a real browser, which is what');
        console.error('these sites need — their HTML is empty until JavaScript fills it in.\n');
        console.error('Install it once (~150MB):\n');
        console.error('  npm install --save-dev playwright');
        console.error('  npx playwright install chromium\n');
        console.error('Then run this again.\n');
        process.exit(1);
    }
}

/** How strongly does this response look like a list of jobs? Higher is better. */
function scoreResponse({ contentType, body }) {
    if (!body) return { score: 0, why: 'empty body' };

    if (contentType.includes('json')) {
        let data;
        try {
            data = JSON.parse(body);
        } catch {
            return { score: 0, why: 'unparseable json' };
        }

        // Find the biggest array of objects anywhere in the payload.
        let biggest = { key: '', length: 0, sample: null };
        const walk = (node, depth = 0) => {
            if (depth > 6 || !node || typeof node !== 'object') return;
            for (const [key, value] of Object.entries(node)) {
                if (Array.isArray(value)) {
                    const objs = value.filter((v) => v && typeof v === 'object');
                    if (objs.length > biggest.length) biggest = { key, length: objs.length, sample: objs[0] };
                } else if (typeof value === 'object') {
                    walk(value, depth + 1);
                }
            }
        };
        Array.isArray(data) ? walk({ root: data }) : walk(data);

        if (biggest.length === 0) return { score: 1, why: 'json, but no array of objects' };

        const looksJobby = JOB_WORDS.test(JSON.stringify(biggest.sample).slice(0, 2000));
        return {
            score: looksJobby ? 100 + biggest.length : 10 + biggest.length,
            why: `json array "${biggest.key}" with ${biggest.length} objects${looksJobby ? ' — job-like' : ''}`,
            arrayKey: biggest.key,
            arrayLength: biggest.length,
            fields: biggest.sample ? Object.keys(biggest.sample) : [],
        };
    }

    const hits = (body.match(new RegExp(JOB_WORDS.source, 'gi')) || []).length;
    return { score: hits > 20 ? hits : 0, why: `${contentType || 'non-json'}, ${hits} job-ish words` };
}

async function sniff(name, url, playwright) {
    console.log(`\n=== ${name} ===`);
    console.log(`opening ${url}`);

    const browser = await playwright.chromium.launch({ headless: true });
    const context = await browser.newContext({
        locale: 'en-US',
        // Some of these geo-gate; the browser runs on your machine, so your IP
        // is already the Israeli one. Nothing to spoof.
        viewport: { width: 1400, height: 900 },
    });
    const page = await context.newPage();

    const captured = [];

    page.on('response', async (response) => {
        const request = response.request();
        const type = request.resourceType();
        if (type !== 'xhr' && type !== 'fetch') return;

        const contentType = (response.headers()['content-type'] || '').toLowerCase();
        if (/image|font|css|javascript/.test(contentType)) return;

        let body = '';
        try {
            body = await response.text();
        } catch {
            return; // body already discarded by the browser
        }

        captured.push({
            url: response.url(),
            method: request.method(),
            status: response.status(),
            contentType,
            size: body.length,
            body,
        });
    });

    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        // Job lists usually arrive a beat after the shell. Give them room.
        await page.waitForTimeout(6000);
        try {
            await page.waitForLoadState('networkidle', { timeout: 10000 });
        } catch {
            /* networkidle never settles on pages with polling — fine */
        }
    } catch (err) {
        console.log(`  navigation problem: ${err.message}`);
    }

    // The DOM after JavaScript has filled it in. This is the fallback that
    // matters: if a site fetches its jobs in a shape we can't reuse — GraphQL,
    // a signed URL, one request per job — the rendered markup is still there to
    // parse, exactly like the Mobileye and Google adapters do.
    let rendered = '';
    try {
        rendered = await page.content();
    } catch {
        /* page already closed */
    }

    await browser.close();

    fs.mkdirSync(BODIES, { recursive: true });
    let renderedPath = null;
    if (rendered) {
        renderedPath = path.join(BODIES, `sniff-${name}-rendered.html`);
        fs.writeFileSync(renderedPath, rendered, 'utf8');
        const hits = (rendered.match(new RegExp(JOB_WORDS.source, 'gi')) || []).length;
        console.log(`  rendered DOM: ${rendered.length} chars, ${hits} job-ish words -> ${renderedPath}`);
    }

    const scored = captured
        .map((r) => ({ ...r, ...scoreResponse(r) }))
        .sort((a, b) => b.score - a.score);

    console.log(`  captured ${captured.length} XHR/fetch responses`);

    const winners = scored.filter((r) => r.score >= 100).slice(0, 3);
    const shown = winners.length ? winners : scored.slice(0, 3);

    fs.mkdirSync(BODIES, { recursive: true });
    shown.forEach((r, i) => {
        r.savedTo = path.join(BODIES, `sniff-${name}-${i + 1}.txt`);
        fs.writeFileSync(r.savedTo, r.body, 'utf8');
        console.log(`  ${winners.length ? '>>' : '  '} ${r.status} ${r.url.slice(0, 90)}`);
        console.log(`       ${r.why}`);
    });

    if (!winners.length) console.log('  no clean job API — the rendered DOM above is the way in');

    return { name, url, total: captured.length, shown, renderedPath, found: winners.length > 0 };
}

function writeReport(results) {
    const lines = [
        '# Sniff report',
        '',
        `Generated ${new Date().toISOString()}`,
        '',
        'Paste this back to Claude to get the adapters written.',
        '',
        '| Company | XHRs seen | Best endpoint |',
        '|---|---|---|',
    ];

    for (const r of results) {
        const best = r.shown[0];
        lines.push(`| ${r.name} | ${r.total} | ${best ? `\`${best.url.slice(0, 80)}\`` : '—'} |`);
    }

    for (const r of results) {
        lines.push('', `## ${r.name}`, '', `Page: ${r.url}`, `XHR/fetch responses captured: ${r.total}`, '');
        if (r.renderedPath) {
            lines.push(`Rendered DOM (post-JavaScript): \`${path.relative(process.cwd(), r.renderedPath)}\``, '');
        }
        if (!r.shown.length) {
            lines.push('No XHR captured — parse the rendered DOM above instead.');
            continue;
        }
        for (const s of r.shown) {
            lines.push(`### \`${s.url}\``, '');
            lines.push(`- ${s.method} ${s.status} · ${s.contentType} · ${s.size} chars`);
            lines.push(`- ${s.why}`);
            lines.push(`- raw body: \`${path.relative(process.cwd(), s.savedTo)}\``);
            if (s.fields?.length) {
                lines.push('', 'Fields on the first item:', '', '```', s.fields.join('\n'), '```');
            }
            lines.push('');
        }
    }

    lines.push('');
    fs.writeFileSync(REPORT, lines.join('\n'), 'utf8');
}

async function main() {
    const playwright = loadPlaywright();
    const arg = process.argv[2];

    let jobs;
    if (!arg) {
        jobs = Object.entries(TARGETS)
            .filter(([, t]) => !t.solved)
            .map(([name, t]) => [name, t.url]);
        const skipped = Object.entries(TARGETS).filter(([, t]) => t.solved).map(([n]) => n);
        if (skipped.length) console.log(`Skipping companies that already have an adapter: ${skipped.join(', ')}`);
    } else if (TARGETS[arg.toLowerCase()]) {
        jobs = [[arg.toLowerCase(), TARGETS[arg.toLowerCase()].url]];
    } else if (arg.startsWith('http')) {
        jobs = [['custom', arg]];
    } else {
        console.error(`Unknown target "${arg}". Known: ${Object.keys(TARGETS).join(', ')}`);
        console.error('Or pass a full URL.');
        process.exit(1);
    }

    const results = [];
    for (const [name, url] of jobs) {
        results.push(await sniff(name, url, playwright));
    }

    writeReport(results);

    const found = results.filter((r) => r.found).length;
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Found job-shaped responses for ${found}/${results.length} companies.`);
    console.log(`Report: ${REPORT}\n`);
    console.log('Paste tools/output/sniff-report.md back to Claude to get the adapters written.\n');
}

main();
