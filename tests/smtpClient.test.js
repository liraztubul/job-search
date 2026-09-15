const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

const { sendMail, buildMessage, dotStuff, encodeHeaderValue, parseReply, isComplete } = require('../server/services/smtpClient');

const CRLF = '\r\n';

/**
 * A stand-in for a TLS socket that plays the server side of the dialogue.
 *
 * The point of testing against this rather than a real server: the things
 * most likely to be wrong here are the *order* of commands and the handling
 * of a refusal, and neither needs a network — but both are invisible without
 * something recording what was written.
 */
function fakeSocket(script) {
    const socket = new EventEmitter();
    socket.written = [];
    socket.destroyed = false;
    socket.setEncoding = () => {};
    socket.destroy = () => { socket.destroyed = true; };
    socket.end = () => { socket.ended = true; };

    let step = 0;
    let inData = false;
    const reply = () => {
        const next = script[step++];
        if (next !== undefined) setImmediate(() => socket.emit('data', next + CRLF));
    };

    socket.write = (chunk) => {
        socket.written.push(chunk);

        // Inside DATA the server stays silent until the lone "." — writing
        // the body must NOT consume a scripted reply, or every reply after
        // it is off by one and the test passes or fails for the wrong reason.
        if (inData) {
            if (chunk === `${CRLF}.${CRLF}`) {
                inData = false;
                reply();
            }
            return;
        }

        const command = chunk.trim();
        if (command === 'DATA') { inData = true; reply(); return; }
        // QUIT is fire-and-forget: sendMail resolves without waiting, so a
        // reply here would be left unconsumed.
        if (command === 'QUIT') return;
        reply();
    };

    // The server speaks first.
    setImmediate(() => socket.emit('data', script[step++] + CRLF));
    return socket;
}

const OK_SCRIPT = [
    '220 smtp.gmail.com ESMTP ready',
    '250-smtp.gmail.com at your service' + CRLF + '250 AUTH LOGIN PLAIN', // multi-line EHLO
    '334 VXNlcm5hbWU6',
    '334 UGFzc3dvcmQ6',
    '235 2.7.0 Accepted',
    '250 2.1.0 OK',
    '250 2.1.5 OK',
    '354 Go ahead',
    '250 2.0.0 OK queued',
];

test('the commands go out in the order SMTP requires', async () => {
    const socket = fakeSocket([...OK_SCRIPT]);

    await sendMail({
        user: 'jobtrail.mailer@gmail.com',
        pass: 'abcd efgh ijkl mnop',
        to: 'someone@example.org',
        subject: 'איפוס סיסמה',
        text: 'שלום',
        html: '<p>שלום</p>',
        connect: () => socket,
    });

    const commands = socket.written.map((w) => w.trim().split(CRLF)[0]);
    assert.equal(commands[0], 'EHLO jobtrail');
    assert.equal(commands[1], 'AUTH LOGIN');
    assert.equal(commands[2], Buffer.from('jobtrail.mailer@gmail.com').toString('base64'));
    assert.equal(commands[3], Buffer.from('abcd efgh ijkl mnop').toString('base64'));
    assert.equal(commands[4], 'MAIL FROM:<jobtrail.mailer@gmail.com>');
    assert.equal(commands[5], 'RCPT TO:<someone@example.org>');
    assert.equal(commands[6], 'DATA');
    assert.equal(commands[commands.length - 1], 'QUIT');
});

test('a wrong App Password fails with a message that names the account, not the password', async () => {
    const socket = fakeSocket([
        '220 ready',
        '250 ok',
        '334 VXNlcm5hbWU6',
        '334 UGFzc3dvcmQ6',
        // A space after the code, not a hyphen: "535-" would be a
        // continuation line and the client would correctly keep waiting.
        '535 5.7.8 Username and Password not accepted',
    ]);

    await assert.rejects(
        sendMail({
            user: 'jobtrail.mailer@gmail.com',
            pass: 'wrong-password-value',
            to: 'someone@example.org',
            subject: 's',
            text: 't',
            html: '<p>t</p>',
            connect: () => socket,
        }),
        (err) => {
            assert.match(err.message, /authentication for jobtrail\.mailer@gmail\.com/);
            // The credential must never travel in an error string — this is
            // the one that would quietly end up in a Render log.
            assert.ok(!err.message.includes('wrong-password-value'), 'the password leaked into the error');
            return true;
        }
    );
});

test('a Hebrew subject is RFC 2047 encoded, not written raw', () => {
    const encoded = encodeHeaderValue('איפוס סיסמה ל-JobTrail');
    assert.match(encoded, /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    assert.equal(Buffer.from(encoded.slice(10, -2), 'base64').toString('utf8'), 'איפוס סיסמה ל-JobTrail');

    // ASCII stays legible rather than being needlessly encoded.
    assert.equal(encodeHeaderValue('Reset your password'), 'Reset your password');
});

test('the message is a well-formed multipart/alternative with both parts', () => {
    const message = buildMessage({
        from: 'a@gmail.com',
        fromName: 'JobTrail',
        to: 'b@example.org',
        subject: 'נושא',
        text: 'טקסט',
        html: '<p>טקסט</p>',
        boundary: 'BOUND',
    });

    assert.match(message, /^From: JobTrail <a@gmail\.com>/m);
    assert.match(message, /^To: b@example\.org$/m);
    assert.match(message, /^Content-Type: multipart\/alternative; boundary="BOUND"$/m);
    assert.match(message, /^--BOUND$/m);
    assert.match(message, /^--BOUND--$/m);
    assert.match(message, /Content-Type: text\/plain; charset=UTF-8/);
    assert.match(message, /Content-Type: text\/html; charset=UTF-8/);

    // Headers end with a blank line, and every line break is CRLF — a bare
    // \n here is the classic way a message silently becomes malformed.
    assert.ok(message.includes(`${CRLF}${CRLF}--BOUND`));
    assert.ok(!/[^\r]\n/.test(message), 'found a bare LF not preceded by CR');

    // The Hebrew survives the round trip.
    const plain = message.split('--BOUND')[1].split(`${CRLF}${CRLF}`)[1].split(CRLF).join('');
    assert.equal(Buffer.from(plain, 'base64').toString('utf8'), 'טקסט');
});

test('a body line starting with a dot is stuffed, so it cannot end DATA early', () => {
    assert.equal(dotStuff('hello\r\n.\r\nworld'), 'hello\r\n..\r\nworld');
    assert.equal(dotStuff('.hidden'), '..hidden');
    assert.equal(dotStuff('no dots here'), 'no dots here');
    // A dot mid-line is untouched — only a leading one is dangerous.
    assert.equal(dotStuff('a.b'), 'a.b');
});

test('a multi-line reply is only complete once its final line has a space', () => {
    assert.equal(isComplete('250-first' + CRLF), false);
    assert.equal(isComplete('250-first' + CRLF + '250 last' + CRLF), true);
    assert.equal(parseReply('250-a' + CRLF + '250 b' + CRLF).code, 250);
});

test('user and recipient are required before any socket is opened', async () => {
    let opened = false;
    const connect = () => { opened = true; return fakeSocket([...OK_SCRIPT]); };

    await assert.rejects(sendMail({ pass: 'x', to: 'a@b.c', connect }), /user and pass are required/);
    await assert.rejects(sendMail({ user: 'a@b.c', pass: 'x', connect }), /recipient is required/);
    assert.equal(opened, false, 'a socket was opened before the arguments were checked');
});
