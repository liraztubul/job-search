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

/** Tables whose every row belongs to exactly one account. */
const PERSONAL_TABLES = ['applications', 'search_profiles', 'notifications_sent'];

/** Tables shared by everyone: the job market is the same for all accounts. */
const SHARED_TABLES = ['watched_companies', 'job_snapshots', 'users'];

module.exports = { requireUser, PERSONAL_TABLES, SHARED_TABLES };
