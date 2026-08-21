/**
 * Entry point for one check cycle.
 *
 *   node server/main.js
 *
 * Orchestration only: it runs the cycle and prints what happened. The logic
 * lives in services/scrapeService.js so a scheduler could call it too.
 */

const { runCycle } = require('./services/scrapeService');
const { FAILURE_KIND } = require('./domain/scrapeOutcome');

const report = {
    'company:start': (e) => `Checking ${e.company}...`,
    'company:fetched': (e) => `  ${e.count} jobs`,
    'company:failed': (e) => `  FAILED (${e.kind}): ${e.error}`,
    'company:closed': (e) => `  CLOSED: ${e.count} job(s) no longer on the site`,
    'job:new': (e) => `  NEW: ${e.title} (${e.location || 'no location'})`,
    'job:matched': (e) => `    -> matches "${e.profile}": ${e.url}`,
};

const ORDINALS = ['0th', '1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th'];
const ordinal = (n) => ORDINALS[n] || `${n}th`;
const names = (failures) => failures.map((f) => f.company).join(', ');

/**
 * The whole point of Task 4: a person reading this log should know whether
 * to act without reading five error strings. Four kinds (server/domain/
 * scrapeOutcome.js), each on its own line, acknowledged failures called out
 * separately from ones nobody has looked at yet — those are the ones that
 * still need eyes even though the run may be green (see shouldGoRed).
 *
 * @param {object[]} failures summary.failures from runCycle
 * @returns {string[]} lines to print, empty-kind buckets omitted except `broken`
 */
function summarizeFailures(failures) {
    const byKind = (kind) => failures.filter((f) => f.kind === kind);
    const lines = [];

    const empty = byKind(FAILURE_KIND.EMPTY);
    if (empty.length) {
        lines.push(`  ${empty.length} compan${empty.length === 1 ? 'y' : 'ies'} with no matching jobs (expected): ${names(empty)}`);
    }

    const refused = byKind(FAILURE_KIND.REFUSED);
    if (refused.length) {
        const desc = refused.map((f) => `${f.company} (${ordinal(f.refusalStreak)} refusal)`).join(', ');
        lines.push(`  ${refused.length} held back by the sanity gate: ${desc}`);
    }

    const blocked = byKind(FAILURE_KIND.BLOCKED);
    const blockedAck = blocked.filter((f) => f.acknowledged);
    const blockedNew = blocked.filter((f) => !f.acknowledged);
    if (blockedAck.length) lines.push(`  ${blockedAck.length} blocked, already acknowledged: ${names(blockedAck)}`);
    if (blockedNew.length) {
        lines.push(`  ${blockedNew.length} blocked, NOT acknowledged (see tools/acknowledge-issue.js): ${names(blockedNew)}`);
    }

    const broken = byKind(FAILURE_KIND.BROKEN);
    const brokenAck = broken.filter((f) => f.acknowledged);
    const brokenNew = broken.filter((f) => !f.acknowledged);
    lines.push(`  ${brokenNew.length} broken${brokenNew.length ? ': ' + names(brokenNew) : ''}`);
    if (brokenAck.length) lines.push(`  ${brokenAck.length} broken but already acknowledged: ${names(brokenAck)}`);

    return lines;
}

// Red means "a person needs to look at this" — a company held back by the
// sanity gate for too long, or one blocked/broken and not yet acknowledged —
// not "something about this run was five characters different from usual".
// See server/domain/scrapeOutcome.js's shouldGoRed, decided per-failure in
// scrapeService.js where each one actually happened.
const needsAttention = (failures) => failures.filter((f) => f.loud);

/** Only runs the cycle when executed directly (`node server/main.js`), not
 * when required — see tests/main.test.js, which imports summarizeFailures/
 * needsAttention without wanting a real scrape cycle to fire as a side effect. */
if (require.main === module) {
    runCycle((event) => {
        const line = report[event.type]?.(event);
        if (line) console.log(line);
    })
        .then((summary) => {
            if (summary.companies === 0) {
                console.log('No watched companies yet — run `node tools/add-company.js` first.');
                process.exit(0);
            }

            console.log(`\nDone. ${summary.companies} companies, ${summary.newJobs} new jobs, ${summary.closedJobs} closed.`);
            for (const line of summarizeFailures(summary.failures)) console.log(line);

            const attention = needsAttention(summary.failures);
            if (attention.length) {
                console.error(`\n${attention.length} company(s) need attention:`);
                for (const failure of attention) {
                    console.error(`  ${failure.company}: ${failure.error}`);
                }
                process.exit(1);
            }

            process.exit(0);
        })
        .catch((err) => {
            console.error('Cycle crashed:', err.message);
            process.exit(1);
        });
}

module.exports = { summarizeFailures, needsAttention };
