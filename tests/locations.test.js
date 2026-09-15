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
        "Migdal Ha'emek", 'Karmiel', 'Nesher', 'Tirat Carmel', 'Kiryat Ata',
        'Kiryat Bialik', 'Kiryat Motzkin', 'Nahariya', 'Akko', 'Afula', 'Caesarea',
        "Zikhron Ya'akov",
        'North', 'South', 'Center', 'Sharon', 'Shfela', 'Gush Dan', 'Israel',
    ]) {
        assert.ok(isIsraeliLocation(value), `${value} should be a recognized Israeli location`);
    }
});

// ---------------------------------------------------------------------------
// Location audit (docs/ROADMAP.md) — every one of these was checked against
// the real job_snapshots table (or, for towns not yet in the data, listed
// explicitly in the work order) and previously resolved to nothing, meaning
// none of these jobs could ever be found through the location filter.
// ---------------------------------------------------------------------------

test('TLV resolves to Tel Aviv — Lemonade\'s Ashby board labels every Tel Aviv job just "TLV"', () => {
    assert.deepEqual(locationTokens('TLV'), ['Tel Aviv']);
});

test('Petach Tikva (with a c) resolves the same as Petah Tikva', () => {
    assert.deepEqual(locationTokens('Petach Tikva'), ['Petah Tikva']);
});

test('the real CyberArk/PANW location string resolves, 134 real jobs\' worth', () => {
    // Found in the audit exactly as-is: job_snapshots had 134 rows with this
    // literal location and zero Israeli tokens before the Petach spelling
    // and the TLV/other additions landed.
    const tokens = locationTokens('Office - Israel - CyberArk Petach Tikva');
    assert.ok(tokens.includes('Petah Tikva'), `expected Petah Tikva in ${JSON.stringify(tokens)}`);
});

test('Yoqneam (with a q) resolves the same as Yokneam', () => {
    assert.deepEqual(locationTokens('Yoqneam'), ['Yokneam']);
});

test('אלון תבור (Alon Tabor) resolves to Migdal Ha\'emek — 74 real jobs used exactly this string', () => {
    assert.deepEqual(locationTokens('אלון תבור'), ["Migdal Ha'emek"]);
});

test('כרמיאל resolves to Karmiel — 65 real jobs used exactly this string', () => {
    assert.deepEqual(locationTokens('כרמיאל'), ['Karmiel']);
});

test('the remaining northern towns resolve in both languages', () => {
    const cases = [
        ['Migdal Ha\'emek', "Migdal Ha'emek"], ['מגדל העמק', "Migdal Ha'emek"],
        ['Nesher', 'Nesher'], ['נשר', 'Nesher'],
        ['Tirat Carmel', 'Tirat Carmel'], ['טירת כרמל', 'Tirat Carmel'],
        ['Kiryat Ata', 'Kiryat Ata'], ['קרית אתא', 'Kiryat Ata'],
        ['Kiryat Bialik', 'Kiryat Bialik'], ['קרית ביאליק', 'Kiryat Bialik'],
        ['Kiryat Motzkin', 'Kiryat Motzkin'], ['קרית מוצקין', 'Kiryat Motzkin'],
        ['Nahariya', 'Nahariya'], ['נהריה', 'Nahariya'],
        ['Akko', 'Akko'], ['עכו', 'Akko'],
        ['Afula', 'Afula'], ['עפולה', 'Afula'],
        ['Caesarea', 'Caesarea'], ['קיסריה', 'Caesarea'],
        ["Zikhron Ya'akov", "Zikhron Ya'akov"], ['זכרון יעקב', "Zikhron Ya'akov"],
    ];
    for (const [input, expected] of cases) {
        assert.deepEqual(locationTokens(input), [expected], `${input} should resolve to ${expected}`);
    }
});

test('Acre is deliberately NOT recognized — it is also an ordinary English word', () => {
    // Only "Akko" is supported for this city — see the comment on its entry
    // in locations.js. Guessing "Acre" in would risk matching text that has
    // nothing to do with this city (a unit of land, "50-acre campus", etc.).
    assert.equal(isIsraeliLocation('Acre'), false);
});

test('Haifa District and a compound Tel Aviv-Yafo listing already worked, and still do', () => {
    assert.deepEqual(locationTokens('Haifa District'), ['Haifa']);
    assert.deepEqual(locationTokens('Tel Aviv-Yafo, Gush Dan, Israel'), ['Tel Aviv', 'Gush Dan', 'Israel']);
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
