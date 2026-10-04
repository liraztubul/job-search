const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/**
 * The header greeting's name derivation (client/js/ui.js). client/ can't be
 * require()d — it's plain browser script — so the file is evaluated in a bare
 * vm context instead. Nothing at ui.js's top level touches the DOM, which is
 * what makes this possible; the rendering itself is checked in a browser.
 */
const source = fs.readFileSync(path.join(__dirname, '..', 'client', 'js', 'ui.js'), 'utf8');
const { greetingName, greetingText } =
    vm.runInNewContext(source + '\n;({ greetingName, greetingText })', {});

test('greetingName: the part before the @, never the full address', () => {
    assert.strictEqual(greetingName('liraz.t41@gmail.com'), 'liraz.t41');
    assert.strictEqual(greetingName('a.b+c@x.com'), 'a.b+c');
    assert.strictEqual(greetingName('  someone@example.com  '), 'someone');
});

test('greetingName: keeps the case it was given', () => {
    assert.strictEqual(greetingName('Liraz.T41@Gmail.COM'), 'Liraz.T41');
});

test('greetingName: cuts at the last @, so the domain can never leak', () => {
    assert.strictEqual(greetingName('"a@b"@example.com'), '"a@b"');
});

test('greetingName: nothing usable -> null', () => {
    for (const value of [null, undefined, '', '   ', '@example.com', 42, {}]) {
        assert.strictEqual(greetingName(value), null, JSON.stringify(value));
    }
});

test('greetingName: no @ at all -> the string itself', () => {
    assert.strictEqual(greetingName('liraz'), 'liraz');
});

test('greetingName: markup stays plain text (rendering uses textContent)', () => {
    assert.strictEqual(greetingName('<b>x</b>@example.com'), '<b>x</b>');
});

test('greetingText: signed in -> Hello, <local part>', () => {
    assert.strictEqual(
        greetingText({ authRequired: true, authenticated: true, email: 'liraz.t41@gmail.com' }),
        'Hello, liraz.t41');
});

test('greetingText: every other state is a guest', () => {
    for (const session of [
        null,                                                              // session fetch failed
        { authRequired: true, authenticated: false, email: null },         // signed out
        { authRequired: false, authenticated: true, email: 'local@localhost' }, // accounts off
        { authRequired: false },
        { authRequired: true, authenticated: true, email: null },          // no usable email
        { authRequired: true, authenticated: true, email: '@x.com' },
    ]) {
        assert.strictEqual(greetingText(session), 'Hello, Guest', JSON.stringify(session));
    }
});
