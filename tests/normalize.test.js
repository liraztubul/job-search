const test = require('node:test');
const assert = require('node:assert');
const {
    EMPLOYMENT_TYPES,
    EXPERIENCE_LEVELS,
    normalizeEmploymentType,
    normalizeExperienceLevel,
} = require('../server/domain/vocabulary');

/**
 * These vocabularies are what the UI dropdowns are built from. If an adapter
 * ever emits a value outside them, the filter silently matches nothing — the
 * job is in the database and invisible. Hence the closed-set assertions.
 */

// ---------------------------------------------------------------------------
// Employment type — real wordings seen in live data
// ---------------------------------------------------------------------------

test('maps the wordings each site actually uses', () => {
    assert.equal(normalizeEmploymentType('Full time'), 'full-time'); // Mobileye
    assert.equal(normalizeEmploymentType('full-time'), 'full-time'); // Amazon
    assert.equal(normalizeEmploymentType('FULL_TIME'), 'full-time');
    assert.equal(normalizeEmploymentType('Contractor'), 'contract'); // Mobileye
    assert.equal(normalizeEmploymentType('Part Time'), 'part-time');
});

test('temporary full-time is temporary, not full-time', () => {
    // A real Mobileye value, and the reason the checks are ordered the way
    // they are: it contains "full-time" as a substring.
    assert.equal(normalizeEmploymentType('Temporary Full-time'), 'temporary');
});

test('internship beats every other signal', () => {
    assert.equal(normalizeEmploymentType('Student - Full time'), 'internship');
    assert.equal(normalizeEmploymentType('Internship'), 'internship');
});

test('unknown wording becomes null, never a wrong guess', () => {
    assert.equal(normalizeEmploymentType('Hybrid'), null);
    assert.equal(normalizeEmploymentType(''), null);
    assert.equal(normalizeEmploymentType(null), null);
    assert.equal(normalizeEmploymentType(undefined), null);
});

test('never emits a value outside the vocabulary', () => {
    const inputs = ['Full time', 'Contractor', 'Temporary Full-time', 'Student', 'Part Time', 'Nonsense', ''];
    for (const input of inputs) {
        const result = normalizeEmploymentType(input);
        assert.ok(result === null || EMPLOYMENT_TYPES.includes(result), `"${input}" -> "${result}"`);
    }
});

// ---------------------------------------------------------------------------
// Experience level
// ---------------------------------------------------------------------------

test("maps Google's grading", () => {
    assert.equal(normalizeExperienceLevel('Early'), 'entry');
    assert.equal(normalizeExperienceLevel('Mid'), 'mid');
    assert.equal(normalizeExperienceLevel('Advanced'), 'senior');
});

test('reads seniority out of a job title', () => {
    assert.equal(normalizeExperienceLevel('Senior Backend Engineer'), 'senior');
    assert.equal(normalizeExperienceLevel('Staff Software Engineer'), 'senior');
    assert.equal(normalizeExperienceLevel('Junior Developer'), 'entry');
    assert.equal(normalizeExperienceLevel('Student Position - Algorithms'), 'intern');
});

test('a manager is senior, not mid', () => {
    assert.equal(normalizeExperienceLevel('Engineering Manager'), 'senior');
    assert.equal(normalizeExperienceLevel('Team Lead'), 'senior');
});

test('intern wins over senior when a title contains both', () => {
    // "Senior Student Program" is rare but real; the safer read for someone
    // job-hunting as a student is intern.
    assert.equal(normalizeExperienceLevel('Senior Student Program'), 'intern');
});

test('a plain title yields null rather than a fabricated level', () => {
    assert.equal(normalizeExperienceLevel('Software Engineer'), null);
    assert.equal(normalizeExperienceLevel('Algorithm Developer'), null);
    assert.equal(normalizeExperienceLevel(null), null);
});

test('never emits a value outside the vocabulary', () => {
    const inputs = ['Early', 'Mid', 'Advanced', 'Senior X', 'Student', 'Software Engineer', '', null];
    for (const input of inputs) {
        const result = normalizeExperienceLevel(input);
        assert.ok(result === null || EXPERIENCE_LEVELS.includes(result), `"${input}" -> "${result}"`);
    }
});
