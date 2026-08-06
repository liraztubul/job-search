/**
 * Entry point for one check cycle.
 *
 *   node server/main.js
 *
 * Orchestration only: it runs the cycle and prints what happened. The logic
 * lives in services/scrapeService.js so a scheduler could call it too.
 */

const { runCycle } = require('./services/scrapeService');

const report = {
    'company:start': (e) => `Checking ${e.company}...`,
    'company:fetched': (e) => `  ${e.count} jobs`,
    'company:failed': (e) => `  FAILED: ${e.error}`,
    'job:new': (e) => `  NEW: ${e.title} (${e.location || 'no location'})`,
    'job:matched': (e) => `    -> matches "${e.profile}": ${e.url}`,
};

runCycle((event) => {
    const line = report[event.type]?.(event);
    if (line) console.log(line);
})
    .then((summary) => {
        if (summary.companies === 0) {
            console.log('No watched companies yet — run `node tools/add-company.js` first.');
        } else {
            console.log(
                `\nDone. ${summary.companies} companies, ${summary.newJobs} new jobs, ` +
                    `${summary.matches} profile matches.`
            );
        }

        // A failure here means a career site changed and an adapter needs
        // looking at — say so loudly rather than exiting 0 as if all was well.
        if (summary.failures.length) {
            console.error(`\n${summary.failures.length} company(s) failed:`);
            for (const failure of summary.failures) {
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
