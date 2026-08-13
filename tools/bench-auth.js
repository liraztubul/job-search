/**
 * bench-auth.js — the measurement behind Task 2's work-factor choice.
 *
 * Password hashing blocks the event loop when it's synchronous, and Node's
 * event loop is what serves every other request (job search, static files,
 * every other visitor's login) while it's blocked. This prints the maximum
 * event-loop delay while N password hashes run concurrently:
 *
 *   BEFORE — crypto.scryptSync, N=2^14 (the old default, main thread)
 *   AFTER  — crypto.scrypt async, N=2^16 (server/web/middleware/auth.js, threadpool)
 *
 *   node tools/bench-auth.js [concurrency]     default concurrency: 10
 *
 * Uses perf_hooks.monitorEventLoopDelay, which runs its own timer independent
 * of the code under test — exactly what's needed to detect "something else
 * blocked the loop" rather than timing the hash calls themselves.
 */

const crypto = require('crypto');
const os = require('os');
const { monitorEventLoopDelay } = require('perf_hooks');
const auth = require('../server/web/middleware/auth');

const CONCURRENCY = Number(process.argv[2]) || 10;

/** The exact call this codebase used before Task 2: scryptSync with Node's
 * implicit defaults (N=2^14, r=8, p=1), on the main thread. */
function legacyHashSync(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    return `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function measure(label, run) {
    const histogram = monitorEventLoopDelay({ resolution: 5 });
    histogram.enable();

    // The histogram only measures the *gap* between its own internal sampling
    // ticks — its first tick after enable() has nothing prior to compare
    // against, so a block that starts immediately has no baseline to be
    // measured relative to and silently produces zero samples. A short warm-up
    // lets a few ticks land on a normal, idle loop first so the tick the block
    // delays has something real to be late relative to.
    await settle(30);

    const startNs = process.hrtime.bigint();
    await run();
    const wallMs = Number(process.hrtime.bigint() - startNs) / 1e6;

    // Same reasoning in reverse: give the loop a moment to actually process
    // the sampling tick that came due during the work, before disable()
    // freezes the histogram.
    await settle(30);
    histogram.disable();
    // monitorEventLoopDelay reports in nanoseconds.
    const maxMs = histogram.max / 1e6;
    const meanMs = histogram.mean / 1e6;

    console.log(`${label}`);
    console.log(`  wall time for ${CONCURRENCY} hashes: ${wallMs.toFixed(1)}ms`);
    console.log(`  max event-loop delay:                ${maxMs.toFixed(1)}ms`);
    console.log(`  mean event-loop delay:                ${meanMs.toFixed(1)}ms\n`);
    return { wallMs, maxMs };
}

async function main() {
    console.log(
        `Machine: ${os.cpus().length} logical CPUs (${os.cpus()[0]?.model || 'unknown'}), ` +
            `${Math.round(os.totalmem() / 1024 / 1024)}MB RAM, ${os.platform()}\n`
    );
    console.log(`Concurrency: ${CONCURRENCY} simultaneous hashes\n`);

    const before = await measure('BEFORE — scryptSync, N=2^14, main thread (blocking)', async () => {
        for (let i = 0; i < CONCURRENCY; i++) legacyHashSync(`password-${i}`);
    });

    const after = await measure('AFTER  — scrypt async, N=2^16, threadpool (non-blocking)', async () => {
        await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => auth.hashPassword(`password-${i}`)));
    });

    console.log(
        `Max event-loop delay dropped from ${before.maxMs.toFixed(1)}ms to ${after.maxMs.toFixed(1)}ms ` +
            `for ${CONCURRENCY} concurrent logins, at roughly 2x the cost per hash.`
    );
}

main();
