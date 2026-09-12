/**
 * What order runCycle visits companies in — see server/services/scrapeService.js.
 *
 * WHY REORDER INSTEAD OF SLEEPING
 *
 * The alternative (keep the natural order, sleep between two consecutive
 * companies that share an adapter_type) works too, but sleeping is dead
 * time: eleven Greenhouse tenants back to back would mean ten waits nobody
 * needed, since a Greenhouse fetch's own network round trip has already
 * moved the clock forward before the next one starts. Spreading each
 * platform's tenants across the run means they land seconds apart *because
 * other companies' real fetches happened in between* — no `runCycle` code
 * has to know or care that time passed, and nothing sleeps unless the retry
 * logic in `retryPolicy.js` decides a wait is actually owed.
 */

/**
 * Spreads each platform's tenants evenly across the whole run, so two tenants
 * of the same platform are as far apart as the list allows.
 *
 * WHY NOT ROUND-ROBIN — THIS IS THE FIX FOR A REAL FAILURE
 *
 * The first version of this function was a greedy round-robin: take one
 * company from each platform, repeat. That reads as obviously fair and is
 * not, because **platforms run out at different times**. Early rounds deal
 * from sixteen platforms, so the gap between two Eightfold tenants is wide;
 * by the last rounds only Greenhouse and Workday still have tenants left, so
 * everything else is already spent and the remaining big-platform tenants
 * land nearly back to back. The spacing decays exactly as the run goes on.
 *
 * Measured against the real 38-company list, Eightfold's four tenants came
 * out at positions 5, 15, 20, 23 — gaps of 10, then 5, then 3. NVIDIA and
 * Microsoft (the two widest gaps) both succeeded from a datacenter address
 * on 2026-09-12, the run that was meant to test this. **Qualcomm, five
 * positions behind Microsoft, came back `429 TOO MANY REQUESTS`** — after
 * `fetchWithRetry` had already spent its three attempts, so Eightfold's
 * limit window is longer than the 60s cap that policy allows itself.
 *
 * Giving each company a position of `(indexWithinPlatform + 0.5) / tenantCount`
 * and sorting by it spreads every platform evenly over the *entire* run
 * regardless of how many other platforms exist or when they run dry. The same
 * four Eightfold tenants become positions 3, 12, 27, 36 — a worst gap of 9
 * instead of 3.
 *
 * **What this cannot fix, honestly:** with ten Workday and eleven Greenhouse
 * tenants in a 38-company run, no ordering can put more than ~3 companies
 * between two of them — that is the pigeonhole principle, not a bug here.
 * Those two platforms come out roughly as dense as before. This helps the
 * platforms that were actually complaining (Eightfold's four tenants, and the
 * two-tenant platforms, whose gap goes from 6 to 23); if Workday starts
 * refusing on density again, the answer is a real delay for that platform,
 * not a cleverer sort.
 *
 * Each platform's own tenants keep their relative order (Greenhouse company A
 * before Greenhouse company B stays true), and the result is deterministic:
 * ties break by the platform's first appearance, then by tenant index.
 *
 * @param {{adapter_type: string}[]} companies
 * @returns {object[]} the same companies, reordered
 */
function interleaveByPlatform(companies) {
    const tenantCount = new Map();
    for (const company of companies) {
        tenantCount.set(company.adapter_type, (tenantCount.get(company.adapter_type) || 0) + 1);
    }

    const platformRank = new Map(); // adapter_type -> first-seen index, for deterministic ties
    const nextIndex = new Map(); // adapter_type -> how many of its tenants we've numbered

    const keyed = companies.map((company) => {
        const type = company.adapter_type;
        if (!platformRank.has(type)) platformRank.set(type, platformRank.size);

        const index = nextIndex.get(type) || 0;
        nextIndex.set(type, index + 1);

        return {
            company,
            // The +0.5 centres each tenant in its own slice instead of pinning
            // the first one to position 0 — otherwise every platform's first
            // tenant collides at the very start of the run, which is the exact
            // clustering this function exists to prevent.
            position: (index + 0.5) / tenantCount.get(type),
            rank: platformRank.get(type),
            index,
        };
    });

    keyed.sort((a, b) => a.position - b.position || a.rank - b.rank || a.index - b.index);

    return keyed.map((entry) => entry.company);
}

module.exports = { interleaveByPlatform };
