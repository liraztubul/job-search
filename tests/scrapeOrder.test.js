const test = require('node:test');
const assert = require('node:assert');
const { interleaveByPlatform } = require('../server/domain/scrapeOrder');

const co = (name, adapter_type) => ({ name, adapter_type });

test('same-platform tenants are never adjacent when another platform is available', () => {
    const companies = [
        co('GH-1', 'greenhouse'), co('GH-2', 'greenhouse'), co('GH-3', 'greenhouse'),
        co('WD-1', 'workday'), co('WD-2', 'workday'),
        co('EF-1', 'eightfold'),
    ];

    const ordered = interleaveByPlatform(companies);
    for (let i = 1; i < ordered.length; i++) {
        assert.notEqual(
            ordered[i].adapter_type,
            ordered[i - 1].adapter_type,
            `${ordered[i - 1].name} (${ordered[i - 1].adapter_type}) immediately followed by ${ordered[i].name} (${ordered[i].adapter_type})`
        );
    }
});

test('no company is lost or duplicated by reordering', () => {
    const companies = [co('A', 'x'), co('B', 'x'), co('C', 'y'), co('D', 'z'), co('E', 'x')];
    const ordered = interleaveByPlatform(companies);
    assert.deepEqual(ordered.map((c) => c.name).sort(), ['A', 'B', 'C', 'D', 'E']);
});

test('a single company (or a single platform) passes through unchanged in relative order', () => {
    const companies = [co('Only', 'manual')];
    assert.deepEqual(interleaveByPlatform(companies), companies);

    const onePlatform = [co('A', 'greenhouse'), co('B', 'greenhouse'), co('C', 'greenhouse')];
    assert.deepEqual(interleaveByPlatform(onePlatform).map((c) => c.name), ['A', 'B', 'C']);
});

test('each platform keeps its own companies in their original relative order', () => {
    const companies = [
        co('GH-1', 'greenhouse'), co('WD-1', 'workday'), co('GH-2', 'greenhouse'), co('WD-2', 'workday'), co('GH-3', 'greenhouse'),
    ];
    const ordered = interleaveByPlatform(companies);
    const greenhouseOrder = ordered.filter((c) => c.adapter_type === 'greenhouse').map((c) => c.name);
    const workdayOrder = ordered.filter((c) => c.adapter_type === 'workday').map((c) => c.name);
    assert.deepEqual(greenhouseOrder, ['GH-1', 'GH-2', 'GH-3']);
    assert.deepEqual(workdayOrder, ['WD-1', 'WD-2']);
});

test('an empty list stays empty', () => {
    assert.deepEqual(interleaveByPlatform([]), []);
});

test('a platform with far more tenants than any other still spreads out, not clumping at the end', () => {
    const companies = [
        ...Array.from({ length: 6 }, (_, i) => co(`GH-${i}`, 'greenhouse')),
        co('Solo', 'manual'),
    ];
    const ordered = interleaveByPlatform(companies);
    // Solo (the only non-greenhouse company) should land right after the
    // first greenhouse tenant, not be forced to the very end.
    const soloIndex = ordered.findIndex((c) => c.name === 'Solo');
    assert.equal(soloIndex, 1);
});
