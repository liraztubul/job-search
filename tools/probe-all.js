/**
 * probe-all.js — find the real data source for every company we can't reach yet.
 *
 *   node tools/probe-all.js              probe all pending companies
 *   node tools/probe-all.js microsoft    probe just one
 *
 * For each company it tries the candidate URLs in order and stops at the first
 * one that actually returns jobs. Raw bodies are saved under
 * tools/output/probe-bodies/ and a summary is written to
 * tools/output/probe-report.md — all scratch output, gitignored.
 *
 * Run this on YOUR machine. Two things differ from a sandbox and both matter:
 * your IP is Israeli (several of these geo-block) and this sends a real browser
 * User-Agent.
 *
 * Zero dependencies. Node 18+.
 */

const fs = require('fs');
const path = require('path');
const { probeUrl } = require('./probe');

const BODIES = path.join(__dirname, 'output', 'probe-bodies');
const REPORT = path.join(__dirname, 'output', 'probe-report.md');
const POLITE_DELAY_MS = 1500;

/**
 * Candidates are ordered best-guess first. A JSON endpoint beats HTML: it is
 * stabler and cheaper. HTML entries are here as the fallback when no XHR exists.
 */
const TARGETS = [
    {
        key: 'microsoft',
        name: 'Microsoft',
        guess: 'custom (gcsservices API behind jobs.careers.microsoft.com)',
        candidates: [
            'https://gcsservices.careers.microsoft.com/search/api/v1/search?lc=Israel&l=en_us&pg=1&pgSz=20&o=Recent&flt=true',
            'https://gcsservices.careers.microsoft.com/search/api/v1/search?q=&lc=Israel&pg=1&pgSz=20',
            'https://jobs.careers.microsoft.com/global/en/search?lc=Israel',
        ],
    },
    {
        key: 'nvidia',
        name: 'NVIDIA',
        guess: 'Eightfold AI',
        candidates: [
            'https://jobs.nvidia.com/api/apply/v2/jobs?domain=nvidia.com&start=0&num=20&location=Israel',
            'https://jobs.nvidia.com/api/apply/v2/jobs?domain=nvidia.com&start=0&num=20',
            'https://jobs.nvidia.com/careers?start=0',
        ],
    },
    {
        key: 'dell',
        name: 'Dell',
        // Round 1 confirmed siteNumber=CX_1 is right (TotalJobsCount: 345) but
        // returned facets only. Oracle HCM hides the job list behind `expand`.
        guess: 'Oracle HCM Cloud — CX_1 confirmed, needs expand=requisitionList',
        candidates: [
            'https://enterpriseplatform.dell.com/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList.secondaryLocations,flexFieldsFacet.values&finder=findReqs;siteNumber=CX_1,limit=20,sortBy=POSTING_DATES_DESC',
            'https://enterpriseplatform.dell.com/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList&finder=findReqs;siteNumber=CX_1,limit=20',
        ],
    },
    {
        key: 'ibm',
        name: 'IBM',
        guess: 'custom, client-rendered',
        candidates: [
            'https://www-api.ibm.com/search/v1/search?q=&fq=category:jobs&sort=date',
            'https://www.ibm.com/careers/search?field_keyword_05[0]=Israel',
            'https://www.ibm.com/careers/search',
        ],
    },
    {
        key: 'elbit',
        name: 'Elbit Systems',
        guess: 'custom, client-rendered — there IS an XHR behind it',
        candidates: [
            'https://elbitsystemscareer.com/api/jobs',
            'https://elbitsystemscareer.com/jobs',
            'https://elbitsystemscareer.com/',
        ],
    },
    {
        key: 'rafael',
        name: 'Rafael',
        // Round 1 returned a 577-byte Reblaze JS challenge (`window.rbzns`,
        // `winsocks()`) on every path. That is a bot-protection product actively
        // refusing automation, not an accident. See the report notes.
        guess: 'Reblaze bot protection — automation is being refused on purpose',
        candidates: ['https://career.rafael.co.il/'],
    },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function verdict(r) {
    if (!r) return 'not reached';
    if (r.kind === 'json' && r.ok) return `JSON — ${r.jobCount} items in "${r.jobArrayKey}"`;
    if (r.kind === 'json') return 'JSON but no job array found';
    if (r.kind === 'html' && r.ok) return `HTML, server-rendered (${r.jobWordHits} hits)`;
    if (r.kind === 'html') return 'HTML, client-rendered — needs DevTools';
    if (r.kind === 'http-error') return `HTTP ${r.status}`;
    if (r.kind === 'empty') return 'empty body — likely blocked';
    return r.notes[0] || 'failed';
}

async function probeTarget(target) {
    console.log(`\n=== ${target.name} ===`);
    console.log(`guess: ${target.guess}`);

    const attempts = [];
    for (const url of target.candidates) {
        process.stdout.write(`  trying ${url.slice(0, 78)}${url.length > 78 ? '...' : ''}\n`);
        const saveTo = path.join(BODIES, `${target.key}-${attempts.length + 1}.txt`);
        const result = await probeUrl(url, { saveTo });
        attempts.push(result);
        console.log(`    -> ${verdict(result)}`);

        if (result.ok) break; // found something real, stop hammering
        await sleep(POLITE_DELAY_MS);
    }

    return { target, attempts, winner: attempts.find((a) => a.ok) || null };
}

function writeReport(results) {
    const lines = [
        '# Probe report',
        '',
        `Generated ${new Date().toISOString()}`,
        '',
        'Paste this whole file back to Claude to get the adapters written.',
        '',
        '| Company | Result | Working URL |',
        '|---|---|---|',
    ];

    for (const { target, winner, attempts } of results) {
        const best = winner || attempts[attempts.length - 1];
        const url = winner ? `\`${winner.url}\`` : '—';
        lines.push(`| ${target.name} | ${verdict(best)} | ${url} |`);
    }

    for (const { target, attempts, winner } of results) {
        lines.push('', `## ${target.name}`, '', `Guess: ${target.guess}`, '');

        for (const a of attempts) {
            lines.push(`- \`${a.url}\``);
            lines.push(`  - ${verdict(a)} · ${a.size} chars · ${a.contentType || '-'}`);
            if (a.savedTo) lines.push(`  - raw body: \`${path.relative(process.cwd(), a.savedTo)}\``);
        }

        if (winner && winner.kind === 'json' && winner.fields?.length) {
            lines.push('', 'Fields on the first job:', '', '```');
            for (const [field, value] of winner.fields) lines.push(`${field.padEnd(28)} ${value}`);
            lines.push('```');
        }

        if (!winner) {
            lines.push(
                '',
                '**Nothing worked.** Open the careers page in Chrome, press F12, go to the',
                'Network tab, filter by Fetch/XHR, reload, and find the request whose Response',
                'contains job titles. Then run:',
                '',
                '```bash',
                'node tools/probe.js "<that url>"',
                '```'
            );
        }
    }

    lines.push('');
    fs.writeFileSync(REPORT, lines.join('\n'), 'utf8');
}

async function main() {
    const only = process.argv[2];
    const targets = only ? TARGETS.filter((t) => t.key === only.toLowerCase()) : TARGETS;

    if (targets.length === 0) {
        console.error(`Unknown company "${only}". Known: ${TARGETS.map((t) => t.key).join(', ')}`);
        process.exit(1);
    }

    fs.mkdirSync(BODIES, { recursive: true });

    const results = [];
    for (const target of targets) {
        results.push(await probeTarget(target));
        await sleep(POLITE_DELAY_MS);
    }

    writeReport(results);

    const found = results.filter((r) => r.winner).length;
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Found a usable source for ${found}/${results.length} companies.`);
    console.log(`Report:     ${REPORT}`);
    console.log(`Raw bodies: ${BODIES}`);
    console.log('\nPaste tools/output/probe-report.md back to Claude to get the adapters written.\n');
}

main();
