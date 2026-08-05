const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { availableTypes, getAdapterClass, validateConfig, buildAdapter } = require('../src/adapters');

const ADAPTER_DIR = path.join(__dirname, '..', 'src', 'adapters');

// ---------------------------------------------------------------------------
// Convention tests. These don't test a function — they test that the project's
// rules still hold. Drop in an adapter that breaks the convention and these
// fail, which is the point: the rule enforces itself instead of living in a
// README nobody reads.
// ---------------------------------------------------------------------------

test('every *Adapter.js file registers itself', () => {
    const files = fs.readdirSync(ADAPTER_DIR).filter((f) => f.endsWith('Adapter.js'));
    assert.ok(files.length > 0, 'no adapter files found at all');
    assert.equal(
        availableTypes().length,
        files.length,
        `${files.length} adapter files but ${availableTypes().length} registered types — ` +
            'one is missing a `static type`'
    );
});

test('every adapter declares what config it needs', () => {
    for (const type of availableTypes()) {
        const AdapterClass = getAdapterClass(type);
        assert.ok(AdapterClass.describe, `${type} has no static describe`);
        assert.ok(AdapterClass.describe.help, `${type} has no help text`);
        assert.equal(typeof AdapterClass.describe.required, 'object', `${type}.describe.required must be an object`);
    }
});

test('the adapters we expect are present', () => {
    assert.ok(availableTypes().includes('amazon'));
    assert.ok(availableTypes().includes('comeet'));
});

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

test('accepts a valid config', () => {
    assert.deepEqual(validateConfig(getAdapterClass('amazon'), { country: 'ISR' }), []);
});

test('accepts declared optional keys', () => {
    assert.deepEqual(validateConfig(getAdapterClass('amazon'), { country: 'ISR', query: 'engineer' }), []);
});

test('reports a missing required key', () => {
    const problems = validateConfig(getAdapterClass('amazon'), {});
    assert.equal(problems.length, 1);
    assert.match(problems[0], /missing required option "country"/);
});

test('catches a typo instead of silently ignoring it', () => {
    // The failure this prevents: --contry ISR gets accepted, the adapter falls
    // back to its default, and you quietly watch the wrong country for a week.
    const problems = validateConfig(getAdapterClass('amazon'), { contry: 'ISR' });
    assert.equal(problems.length, 2);
    assert.ok(problems.some((p) => /unknown option "contry"/.test(p)));
    assert.ok(problems.some((p) => /missing required option "country"/.test(p)));
});

// ---------------------------------------------------------------------------
// buildAdapter
// ---------------------------------------------------------------------------

test('builds an adapter from a company row', () => {
    const adapter = buildAdapter({
        name: 'Amazon Israel',
        adapter_type: 'amazon',
        adapter_config: '{"country":"ISR"}',
    });
    assert.equal(typeof adapter.getCurrentJobs, 'function');
    assert.equal(adapter.country, 'ISR');
});

test('an unknown type lists what IS available', () => {
    assert.throws(
        () => buildAdapter({ name: 'Rafael', adapter_type: 'rafael', adapter_config: '{}' }),
        (err) => /Unknown adapter_type "rafael"/.test(err.message) && /amazon/.test(err.message)
    );
});

test('malformed adapter_config names the company', () => {
    assert.throws(
        () => buildAdapter({ name: 'Broken Co', adapter_type: 'amazon', adapter_config: '{not json' }),
        /Broken Co.*not valid JSON/
    );
});

test('a bad config fails at build time, not mid-scrape', () => {
    assert.throws(
        () => buildAdapter({ name: 'Amazon Israel', adapter_type: 'amazon', adapter_config: '{}' }),
        /missing required option "country"/
    );
});
