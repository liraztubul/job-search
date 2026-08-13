/**
 * set-password.js — turn a password into the two lines your .env needs.
 *
 *   node tools/set-password.js "my password"
 *
 * Prints a scrypt hash and a random session secret. Nothing is written for you:
 * you paste them into .env, which is already in .gitignore.
 *
 * Only needed if you host this somewhere your phone can reach. On localhost the
 * server has no login and doesn't want one — see server/web/middleware/auth.js.
 */

const crypto = require('crypto');
const { hashPassword } = require('../server/web/middleware/auth');

const password = process.argv[2];

if (!password) {
    console.log('\nUsage: node tools/set-password.js "your password"\n');
    console.log('Prints the two lines to add to .env.\n');
    process.exit(1);
}

if (password.length < 12) {
    console.error('\nUse at least 12 characters. This is the only thing between');
    console.error('the internet and your application history.\n');
    process.exit(1);
}

async function main() {
    console.log('\nAdd these to .env (never commit it):\n');
    console.log(`JT_PASSWORD_HASH=${await hashPassword(password)}`);
    console.log(`JT_SESSION_SECRET=${crypto.randomBytes(32).toString('hex')}`);
    console.log('\nAnd when the server sits behind HTTPS, add:\n');
    console.log('JT_BEHIND_HTTPS=1');
    console.log('\nThe server picks these up on start. Without them there is no login.\n');
}

main();
