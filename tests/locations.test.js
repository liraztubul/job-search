const test = require('node:test');
const assert = require('node:assert');
const { locationTokens, isIsraeliLocation } = require('../server/data');

/**
 * The "location" filter dropdown is Israel-only (server/db/index.js
 * filterOptions) and its values get a Hebrew label on the client
 * (client/js/ui.js HEBREW.location). This is the seam between the two: every
 * value isIsraeliLocation() accepts must have a Hebrew label, and every real
 * location string that shows up in the data must canonicalize to a value
 * this whitelist recognizes when it's actually in Israel.
 */

test('recognizes real Israeli places, in either language', () => {
    for (const value of [
        'Tel Aviv', 'Haifa', 'Jerusalem', 'Ramat Gan', 'Netanya', 'Herzliya',
        'Beer Sheva', 'Petah Tikva', 'Yokneam', 'Raanana', 'Tel Hai', "Modi'in",
        'North', 'South', 'Center', 'Sharon', 'Shfela', 'Gush Dan', 'Israel',
    ]) {
        assert.ok(isIsraeliLocation(value), `${value} should be a recognized Israeli location`);
    }
});

test('rejects places outside Israel and parsing noise', () => {
    for (const value of ['Shanghai', 'Beijing', 'Koblenz Neuwied', 'Multiple Locations', 'DataMigration', 'HA', 'TA']) {
        assert.ok(!isIsraeliLocation(value), `${value} should not be offered as an Israeli location`);
    }
});

test('an English and a Hebrew region name collapse into the same token', () => {
    // Elbit's own data uses English area names ("North", "Sharon"); another
    // source might use the Hebrew ones. Both have to land in one filter bucket
    // or picking "North" silently misses the Hebrew-tagged postings.
    assert.deepEqual(locationTokens('North'), ['North']);
    assert.deepEqual(locationTokens('צפון'), ['North']);
    assert.deepEqual(locationTokens('Sharon'), ['Sharon']);
    assert.deepEqual(locationTokens('שרון'), ['Sharon']);
});

test('ISR and IL merge into Israel, not three separate filter options', () => {
    assert.deepEqual(locationTokens('ISR'), ['Israel']);
    assert.deepEqual(locationTokens('IL'), ['Israel']);
    assert.deepEqual(locationTokens('Israel'), ['Israel']);
});

test('a real multi-site location keeps its Israeli office and drops the rest from the whitelist check', () => {
    // Eightfold jobs join every open office into one string; a job open in
    // both Israel and China must still surface "Yokneam" as a filter option
    // without also offering "Shanghai".
    const tokens = locationTokens('Israel, Yokneam · China, Shanghai');
    assert.ok(tokens.includes('Yokneam'));
    assert.ok(tokens.includes('Shanghai')); // still a real token — just not an Israeli one
    assert.equal(isIsraeliLocation('Yokneam'), true);
    assert.equal(isIsraeliLocation('Shanghai'), false);
});
