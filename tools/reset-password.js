/**
 * reset-password.js — the owner's escape hatch when mail can't be sent.
 *
 *   node tools/reset-password.js --email someone@example.com --password "a new one"
 *
 * Password reset by email exists (server/services/verificationService.js),
 * but sending is switched off — see client/login.html and
 * server/services/emailService.js. This is the other way in: whoever has
 * database credentials can already do anything to that database, so this is
 * not a backdoor, just that same access wrapped to go through the real
 * `hashPassword` the login path verifies against, instead of a second
 * implementation that could quietly disagree with it.
 *
 * Works against whichever database the environment points at — the local
 * file by default, or Turso when TURSO_DATABASE_URL/TURSO_AUTH_TOKEN are set
 * (server/data/connection.js resolves this already; nothing here re-implements
 * it).
 */

const { hashPassword } = require('../server/web/middleware/auth');
const data = require('../server/data');
const { MIN_PASSWORD_LENGTH } = require('../server/services/userService');

function parseArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i++) {
        if (!argv[i].startsWith('--')) continue;
        args[argv[i].slice(2)] = argv[i + 1];
        i++;
    }
    return args;
}

async function main() {
    const { email, password } = parseArgs(process.argv.slice(2));

    if (!email || !password) {
        console.log('\nUsage: node tools/reset-password.js --email someone@example.com --password "a new one"\n');
        process.exit(1);
    }

    if (password.length < MIN_PASSWORD_LENGTH) {
        console.error(`\nUse at least ${MIN_PASSWORD_LENGTH} characters — the same minimum registration enforces.\n`);
        process.exit(1);
    }

    const user = data.findUserByEmail(email);
    if (!user) {
        console.error(`\nNo account with that email.\n`);
        process.exit(1);
    }

    const passwordHash = await hashPassword(password);
    // Bumps session_epoch in the same statement — exactly what the emailed
    // reset flow does, and for the same reason: a password just changed, so
    // any session anyone else is holding for this account must stop working
    // at this moment.
    data.setPasswordAndBumpEpoch(user.id, passwordHash);

    console.log(`\nPassword updated for ${data.normalizeEmail(email)}.`);
    console.log('Every existing session for this account has been signed out.\n');
}

main().catch((err) => {
    console.error('\nFailed:', err.message, '\n');
    process.exit(1);
});
