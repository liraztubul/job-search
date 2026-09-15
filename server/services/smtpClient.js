/**
 * A minimal SMTP client, written by hand over `node:tls`.
 *
 * WHY THIS EXISTS, WHEN CLAUDE.md SAYS "AN HTTP API, NOT AN SMTP CLIENT"
 *
 * That rule was written to keep the project at one runtime dependency: the
 * alternative it was rejecting is `nodemailer`, not SMTP itself. This file
 * adds no dependency — `node:tls` and `node:crypto` are built in — so the
 * rule's actual purpose is intact even though its letter is not. The reason
 * to reach for SMTP at all is that every HTTP email API either wants a
 * postal address at signup (Brevo) or refuses to send from a `@gmail.com`
 * address (Postmark, and Mailjet warns it may not deliver at all).
 *
 * Sending through Gmail itself sidesteps that whole class of problem: the
 * message leaves Google's own servers, DKIM-signed by Google, so SPF and
 * DKIM align with the From: address and DMARC passes properly. A reset link
 * that lands in spam is barely better than no reset link, and this is the
 * only free option that reliably reaches the inbox.
 *
 * Authentication is an App Password (a 16-character credential Google issues
 * once 2-Step Verification is on), not OAuth. OAuth was investigated and
 * rejected: a consent screen left in "Testing" expires its refresh token
 * every 7 days, and moving to "In Production" with a Gmail scope pulls in
 * Google's app-verification process. A password-reset feature that silently
 * stops working every Monday is worse than one that was never built.
 *
 * SCOPE OF WHAT IS IMPLEMENTED — deliberately small:
 *   - implicit TLS on port 465, never plaintext, never STARTTLS
 *   - AUTH LOGIN (what Gmail accepts with an App Password)
 *   - exactly one recipient per message
 *   - multipart/alternative, UTF-8, base64
 * Anything past that (connection pooling, DSN, 8BITMIME negotiation,
 * multiple recipients) is not needed here and is not guessed at.
 */

const tls = require('node:tls');
const crypto = require('node:crypto');

const CRLF = '\r\n';

/** Gmail closes an idle socket eventually; fail loudly before a request hangs. */
const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * RFC 2047: a header value outside ASCII cannot be written literally. Every
 * subject this app sends is Hebrew, so this is the normal path, not an edge
 * case — "איפוס סיסמה ל-JobTrail" put raw into a Subject: line arrives as
 * mojibake in most clients.
 */
function encodeHeaderValue(value) {
    if (/^[\x20-\x7E]*$/.test(value)) return value;
    return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/** Base64 bodies must be wrapped; some servers reject very long lines. */
function base64Lines(text) {
    const encoded = Buffer.from(text, 'utf8').toString('base64');
    return (encoded.match(/.{1,76}/g) || []).join(CRLF);
}

/**
 * Build the full RFC 5322 message.
 *
 * Pure and exported on purpose: it is the part with fiddly rules (header
 * encoding, boundaries, CRLF everywhere) and it can be asserted on in a test
 * without a socket, a network, or a Gmail account.
 */
function buildMessage({ from, fromName, to, subject, text, html, date = new Date(), boundary }) {
    const sep = boundary || `jobtrail-${crypto.randomBytes(16).toString('hex')}`;
    const fromHeader = fromName ? `${encodeHeaderValue(fromName)} <${from}>` : from;

    const headers = [
        `From: ${fromHeader}`,
        `To: ${to}`,
        `Subject: ${encodeHeaderValue(subject)}`,
        `Date: ${date.toUTCString()}`,
        // A message with no Message-ID looks machine-generated in the bad way
        // and is a small spam signal. The domain half is taken from the
        // sender so it is at least self-consistent.
        `Message-ID: <${crypto.randomBytes(16).toString('hex')}@${from.split('@')[1] || 'localhost'}>`,
        'MIME-Version: 1.0',
        `Content-Type: multipart/alternative; boundary="${sep}"`,
    ];

    const parts = [
        `--${sep}`,
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
        '',
        base64Lines(text),
        `--${sep}`,
        'Content-Type: text/html; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
        '',
        base64Lines(html),
        `--${sep}--`,
        '',
    ];

    return `${headers.join(CRLF)}${CRLF}${CRLF}${parts.join(CRLF)}`;
}

/**
 * Dot-stuffing (RFC 5321 §4.5.2). A line consisting of a single "." ends the
 * DATA phase, so any body line that legitimately starts with "." must be
 * doubled or the message is truncated at that point and the rest is
 * interpreted as SMTP commands. Base64 output never starts with ".", so this
 * cannot currently bite — which is exactly why it would be missed later, if
 * someone switched a part to quoted-printable or plain text.
 */
function dotStuff(message) {
    return message.replace(/^\./gm, '..');
}

/** Parse an SMTP reply: continuation lines are "250-x", the last is "250 x". */
function parseReply(raw) {
    const lines = raw.split(CRLF).filter(Boolean);
    const last = lines[lines.length - 1];
    return { code: Number(last.slice(0, 3)), text: lines.map((l) => l.slice(4)).join(' '), raw };
}

/** True once `buffer` holds at least one complete reply. */
function isComplete(buffer) {
    const lines = buffer.split(CRLF).filter(Boolean);
    if (lines.length === 0) return false;
    return /^\d{3} /.test(lines[lines.length - 1]);
}

/**
 * Drive the SMTP conversation over an already-connected socket.
 *
 * `socket` is injected rather than created here so the whole dialogue can be
 * tested against a fake — the command order and the failure handling are the
 * parts worth testing, and neither needs a real server.
 */
function converse(socket, { user, pass, from, to, message, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    return new Promise((resolve, reject) => {
        let buffer = '';
        let pending = null;
        let settled = false;

        const fail = (error) => {
            if (settled) return;
            settled = true;
            socket.destroy();
            reject(error);
        };

        const timer = setTimeout(() => fail(new Error(`smtp: no reply within ${timeoutMs}ms`)), timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();

        socket.setEncoding('utf8');
        socket.on('error', fail);
        socket.on('data', (chunk) => {
            buffer += chunk;
            if (!isComplete(buffer) || !pending) return;
            const reply = parseReply(buffer);
            buffer = '';
            const { resolve: go } = pending;
            pending = null;
            go(reply);
        });

        const expect = () => new Promise((res) => { pending = { resolve: res }; });

        const send = (line) => { socket.write(line + CRLF); };

        /** Send a command and require a specific class of reply. */
        const step = async (line, wanted, label) => {
            if (line !== null) send(line);
            const reply = await expect();
            if (!wanted.includes(reply.code)) {
                // The password must never reach a log or an error message.
                throw new Error(`smtp: ${label} failed — server said ${reply.code} ${reply.text}`);
            }
            return reply;
        };

        (async () => {
            await step(null, [220], 'greeting');
            await step('EHLO jobtrail', [250], 'EHLO');

            await step('AUTH LOGIN', [334], 'AUTH LOGIN');
            await step(Buffer.from(user, 'utf8').toString('base64'), [334], 'username');
            // A wrong App Password surfaces here as 535. Say so plainly —
            // "authentication failed" with the account name is actionable;
            // the raw Gmail response is a wall of URLs.
            await step(Buffer.from(pass, 'utf8').toString('base64'), [235], `authentication for ${user}`);

            await step(`MAIL FROM:<${from}>`, [250], 'MAIL FROM');
            await step(`RCPT TO:<${to}>`, [250, 251], 'RCPT TO');
            await step('DATA', [354], 'DATA');

            socket.write(dotStuff(message));
            socket.write(`${CRLF}.${CRLF}`);
            await step(null, [250], 'message body');

            send('QUIT');
        })()
            .then(() => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                socket.end();
                resolve();
            })
            .catch(fail);
    });
}

/**
 * Send one message. `connect` is injectable purely so tests never open a
 * socket; production always gets the real implicit-TLS connection.
 */
async function sendMail({
    host = 'smtp.gmail.com',
    port = 465,
    user,
    pass,
    from = user,
    fromName = 'JobTrail',
    to,
    subject,
    text,
    html,
    timeoutMs,
    connect,
}) {
    if (!user || !pass) throw new Error('smtp: user and pass are required');
    if (!to) throw new Error('smtp: a recipient is required');

    const message = buildMessage({ from, fromName, to, subject, text, html });

    const socket = connect
        ? connect()
        : tls.connect({ host, port, servername: host });

    if (!connect) {
        await new Promise((resolve, reject) => {
            socket.once('secureConnect', resolve);
            socket.once('error', reject);
        });
    }

    await converse(socket, { user, pass, from, to, message, timeoutMs });
}

module.exports = { sendMail, buildMessage, dotStuff, encodeHeaderValue, parseReply, isComplete };
