const test = require('node:test');
const assert = require('node:assert');
const { isTechJob } = require('../server/domain/techFilter');

/**
 * The "רק היי-טק" default filter — docs/ROADMAP.md. Generous, not aggressive:
 * a real engineering job wrongly hidden is the failure this exists to
 * prevent, so every test here that matters is really asking "does a real
 * tech title survive," not just "does obvious junk get excluded."
 */

// ---------------------------------------------------------------------------
// The exact junk this filter was written for — real titles observed live on
// the production site.
// ---------------------------------------------------------------------------

test('excludes the real junk observed on the live site', () => {
    for (const title of ['מוכר.ת לחנות עפולה', 'דפס.ית ראשי.ת', 'רכז.ת משאבי אנוש בכיר.ה', 'Salary Controller']) {
        assert.equal(isTechJob({ title }), false, `${title} should be excluded`);
    }
});

// ---------------------------------------------------------------------------
// The categories the work order names outright: engineering, hardware, data,
// QA, DevOps, IT, product, design.
// ---------------------------------------------------------------------------

test('includes every explicitly named category', () => {
    const titles = [
        'Backend Software Engineer', 'Hardware Design Engineer', 'Data Scientist',
        'QA Automation Engineer', 'DevOps Engineer', 'IT Support Specialist',
        'Senior Product Manager', 'UX/UI Designer', 'Machine Learning Researcher',
        'Firmware Engineer', 'Network Security Engineer',
    ];
    for (const title of titles) {
        assert.equal(isTechJob({ title }), true, `${title} should be included`);
    }
});

// ---------------------------------------------------------------------------
// Real false positives found while building this against the live database
// — each one is a genuine engineering title that a naive keyword blocklist
// would have hidden. Pinned so they can't regress.
// ---------------------------------------------------------------------------

test('a "drivers" job title is not caught by the Drivers department pattern', () => {
    assert.equal(isTechJob({ title: 'Embedded Software Engineer - Networking drivers, ENA team', department: 'Software Development' }), true);
    assert.equal(isTechJob({ title: 'Manager, Software Drivers', department: 'Mgmt, Sys SW' }), true);
});

test('the literal Drivers department (trucking/delivery) is still excluded', () => {
    assert.equal(isTechJob({ title: 'Regional Driver', department: 'Drivers' }), false);
});

test('title wins over a noisy department string', () => {
    // Real example: filed under "Mgmt, Product Marketing" despite being a
    // Product Management role — a marketing pattern must not override what
    // the title plainly says, since "product" is an explicitly included
    // category.
    assert.equal(isTechJob({ title: 'Director, Product Management – DOCA', department: 'Mgmt, Product Marketing' }), true);
});

// ---------------------------------------------------------------------------
// Explicit technical / non-technical markers some sources provide directly.
// ---------------------------------------------------------------------------

test('an explicit "Technical" department marker includes, even with an unrelated title', () => {
    assert.equal(isTechJob({ title: 'Program Mgr', department: 'Program Mgr, Technical' }), true);
});

test('an explicit "Non-Technical" department marker excludes', () => {
    assert.equal(isTechJob({ title: 'Program Mgr', department: 'Program Mgr, Non-Technical' }), false);
});

// ---------------------------------------------------------------------------
// Clearly non-technical functions, in both languages — the blocklist
// ---------------------------------------------------------------------------

test('excludes clearly non-technical functions in English', () => {
    const titles = [
        'Sales Manager', 'HR Business Partner', 'Financial Controller', 'Legal Counsel',
        'Marketing Manager', 'Warehouse Forklift Operator', 'Executive Assistant',
        'Talent Acquisition Partner', 'Procurement Specialist', 'Head Chef',
    ];
    for (const title of titles) {
        assert.equal(isTechJob({ title }), false, `${title} should be excluded`);
    }
});

test('excludes clearly non-technical functions in Hebrew', () => {
    const titles = ['מנהל.ת מכירות', 'רכז.ת גיוס', 'עו"ד', 'מלצר.ית', 'נהג.ת משאית'];
    for (const title of titles) {
        assert.equal(isTechJob({ title }), false, `${title} should be excluded`);
    }
});

// ---------------------------------------------------------------------------
// Generous defaults
// ---------------------------------------------------------------------------

test('a job with no title and no department defaults to included', () => {
    assert.equal(isTechJob({}), true);
    assert.equal(isTechJob({ title: '', department: null }), true);
});

test('an unrecognized title with no clear signal either way defaults to included', () => {
    assert.equal(isTechJob({ title: 'Special Projects Associate' }), true);
});
