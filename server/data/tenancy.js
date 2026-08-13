/**
 * The guard that makes a cross-account leak a crash instead of a feature.
 *
 * THE BUG THIS EXISTS FOR
 *
 * In any app with more than one account, the same bug keeps happening: one
 * query somewhere forgets `WHERE user_id = ?`, and a stranger's data renders on
 * someone else's screen. It is not exotic. It is a missing clause in one of
 * dozens of statements, it produces no error, and the tests pass because a test
 * database usually has one user in it.
 *
 * Like a mail room where every letter needs an apartment number: nothing goes
 * wrong until one letter goes out without one, and then it lands somewhere.
 *
 * WHY A HELPER AND NOT A RULE
 *
 * "Always remember the user_id" is a rule, and rules lose. This makes the
 * computer check instead: every repository function that touches a personal
 * table takes `userId` as its first argument and calls `requireUser` before it
 * builds a statement. Forget it and the call throws immediately, in
 * development, on the first request — instead of leaking quietly in production.
 *
 * tests/tenancy.test.js enumerates the exported functions and asserts each one
 * refuses to run without a user, so a new repository function cannot skip this
 * without turning the suite red.
 */

/**
 * @param {unknown} userId
 * @returns {number} the validated id
 * @throws {Error} when it is missing or not a positive integer
 */
function requireUser(userId) {
    const id = Number(userId);
    if (!Number.isInteger(id) || id <= 0) {
        throw new Error(
            'requireUser: this query touches per-account data and was called without a user id. ' +
                'Pass the id of the logged-in user as the first argument.'
        );
    }
    return id;
}

/**
 * The one caller that is legitimately nobody: a logged-out visitor reading the
 * public job list.
 *
 * `job_snapshots` is a shared table, but the search query LEFT JOINs
 * `applications` onto it to show "you already applied to this" — so it takes a
 * user id even though the jobs themselves belong to everyone.
 *
 * A guest has no applications, and the honest answer is a row with no status.
 * The tempting shortcut is a second SQL statement without the join. That would
 * mean two WHERE clauses that must stay identical forever, and the one nobody
 * runs in development is the one that rots — the same drift `buildJobFilters`
 * exists to prevent between queryJobs and countJobs.
 *
 * So a guest is instead given an id that is real enough for SQL and can never
 * match a row: account ids are positive, this one isn't. Same statement, same
 * join, every application row fails `a.user_id = @owner`, and the columns come
 * back NULL because they are genuinely empty — not because a branch skipped them.
 *
 * Deliberately NOT accepted by `requireUser`. Writing to a personal table as
 * GUEST stays a crash; only reads that already tolerate an empty join may opt
 * in, and only by naming GUEST explicitly. `undefined` still throws.
 */
const GUEST = Symbol('guest');
const GUEST_OWNER_ID = -1;

/**
 * @param {unknown|typeof GUEST} userId
 * @returns {number} a real account id, or a sentinel that matches no row
 */
function resolveViewer(userId) {
    return userId === GUEST ? GUEST_OWNER_ID : requireUser(userId);
}

/** Tables whose every row belongs to exactly one account. */
const PERSONAL_TABLES = ['applications', 'search_profiles', 'notifications_sent'];

/** Tables shared by everyone: the job market is the same for all accounts. */
const SHARED_TABLES = ['watched_companies', 'job_snapshots', 'users'];

module.exports = { requireUser, resolveViewer, GUEST, GUEST_OWNER_ID, PERSONAL_TABLES, SHARED_TABLES };
