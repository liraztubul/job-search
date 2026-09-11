/**
 * What order runCycle visits companies in — see server/services/scrapeService.js.
 *
 * WHY REORDER INSTEAD OF SLEEPING
 *
 * The alternative (keep the natural order, sleep between two consecutive
 * companies that share an adapter_type) works too, but sleeping is dead
 * time: eleven Greenhouse tenants back to back would mean ten waits nobody
 * needed, since a Greenhouse fetch's own network round trip has already
 * moved the clock forward before the next one starts. Round-robining across
 * platforms first means the same platform's tenants land seconds apart
 * *because other companies' real fetches happened in between* — no
 * `runCycle` code has to know or care that time passed, and nothing sleeps
 * unless Task 2's retry logic decides a wait is actually owed.
 */

/**
 * Round-robins companies across `adapter_type` so two tenants of the same
 * platform are never adjacent, without changing which companies are in the
 * list or losing any of them. Each platform's own tenants keep their
 * relative order (Greenhouse company A before Greenhouse company B stays
 * true), only interleaved with everyone else's.
 *
 * @param {{adapter_type: string}[]} companies
 * @returns {object[]} the same companies, reordered
 */
function interleaveByPlatform(companies) {
    const queues = new Map(); // adapter_type -> companies, in original order
    const platformOrder = []; // first-seen order of adapter_types, for a stable pass order

    for (const company of companies) {
        if (!queues.has(company.adapter_type)) {
            queues.set(company.adapter_type, []);
            platformOrder.push(company.adapter_type);
        }
        queues.get(company.adapter_type).push(company);
    }

    const result = [];
    let remaining = companies.length;
    while (remaining > 0) {
        for (const type of platformOrder) {
            const queue = queues.get(type);
            if (queue.length === 0) continue;
            result.push(queue.shift());
            remaining--;
        }
    }
    return result;
}

module.exports = { interleaveByPlatform };
