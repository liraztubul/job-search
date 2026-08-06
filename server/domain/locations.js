/**
 * Location vocabulary — turns whatever a career site writes into a small set of
 * canonical place names.
 *
 * Elbit posts in Hebrew, everyone else in English, and each one spells the same
 * city differently. Without this, "תל אביב", "Tel Aviv" and "Tel Aviv-Yafo"
 * become three separate entries in the filter and picking one hides the others.
 *
 * Domain logic: pure functions, no database, no network.
 */

const LOCATION_SPLIT_RE = /[,/·\-–]|(?:\s+and\s+)|(?:\s*&\s*)|(?:\s+ו(?=[^\s]))/i;
// "הקריות" ("the Krayot") only ever shows up tacked onto a city ("חיפה והקריות" —
// "Haifa and the Krayot"), never as a filterable place of its own in this data,
// so it's treated the same as "and surroundings" rather than kept as a token.
const LOCATION_NOISE_RE =
    /(?:^|\s+)(?:area|region|district|אזור|מחוז|סביבה|הסביבה|העיר|(?:ה)?קריות|city|the\s+city|surroundings|and\s+surroundings|and\s+the\s+city)(?:\s+|$)/gi;

// Every location the "location" filter is allowed to offer. Two things live in
// one entry on purpose: the canonical value (also what gets stored in
// location_search and matched against) and the regex that recognizes it in
// either language — so a Hebrew-native source (Elbit) and an English one
// (everyone else) collapse into the same filter bucket instead of two.
// Hebrew display labels live in client/js/ui.js (HEBREW.location), same split
// as HEBREW.experience/employment/status: value here, label there.
const LOCATION_CANONICAL = [
    { pattern: /(?:תל\s*אביב|Tel\s*Aviv|TelAviv|Tel-Aviv)/i, value: 'Tel Aviv' },
    { pattern: /(?:חיפה|Haifa)/i, value: 'Haifa' },
    { pattern: /(?:ירושלים|Jerusalem)/i, value: 'Jerusalem' },
    { pattern: /(?:רמת\s*גן|Ramat\s*Gan)/i, value: 'Ramat Gan' },
    { pattern: /(?:נתניה|Netanya)/i, value: 'Netanya' },
    { pattern: /(?:הרצליה|Herzliya)/i, value: 'Herzliya' },
    { pattern: /(?:באר\s*שבע|Be[']?er\s*Sheva|Beer\s*Sheva)/i, value: 'Beer Sheva' },
    { pattern: /(?:פתח\s*תקווה|Petah\s*Tikva)/i, value: 'Petah Tikva' },
    { pattern: /(?:יקנעם|Yokneam)/i, value: 'Yokneam' },
    { pattern: /(?:רעננה|Ra['’]?anana)/i, value: 'Raanana' },
    { pattern: /(?:תל\s*חי|Tel\s*Hai)/i, value: 'Tel Hai' },
    { pattern: /(?:מודיעין|Modi['’]?in)/i, value: "Modi'in" },
    { pattern: /^(?:North|Northern|צפון)$/i, value: 'North' },
    { pattern: /^(?:South|Southern|דרום)$/i, value: 'South' },
    { pattern: /^(?:Center|Central|Merkaz|מרכז)$/i, value: 'Center' },
    { pattern: /^(?:Sharon|(?:ה)?שרון)$/i, value: 'Sharon' },
    { pattern: /^(?:Shfela|Shefela|(?:ה)?שפלה)$/i, value: 'Shfela' },
    { pattern: /^(?:Gush\s*Dan|גוש\s*דן)$/i, value: 'Gush Dan' },
    { pattern: /^(?:Israel|ISR|IL|ישראל)$/i, value: 'Israel' },
];

// Only a token that canonicalized to one of the values above counts as "in
// Israel" — everything else (Shanghai, Beijing, a stray parsing artifact) is
// real data on the job itself, but never offered as a location filter option.
const ISRAEL_LOCATIONS = new Set(LOCATION_CANONICAL.map((c) => c.value));
const isIsraeliLocation = (value) => ISRAEL_LOCATIONS.has(value);

function canonicalizeLocation(part) {
    const cleaned = part.replace(LOCATION_NOISE_RE, '').trim();
    if (!cleaned) return '';

    for (const { pattern, value } of LOCATION_CANONICAL) {
        if (pattern.test(cleaned)) return value;
    }

    return cleaned;
}

function locationTokens(rawLocation) {
    if (!rawLocation) return [];
    const normalized = String(rawLocation)
        .replace(/\r?\n/g, ' ')
        .replace(/[–—]/g, ' ')
        .replace(/\s*-\s*/g, ' ')
        .trim();
    if (!normalized) return [];

    const tokens = normalized
        .split(LOCATION_SPLIT_RE)
        .map((part) => canonicalizeLocation(part))
        .filter((part) => part && part.length > 1);

    return [...new Set(tokens)];
}

function locationSearchValue(rawLocation) {
    const tokens = locationTokens(rawLocation);
    return tokens.length ? tokens.join(' ') : rawLocation || '';
}

module.exports = {
    LOCATION_CANONICAL,
    isIsraeliLocation,
    canonicalizeLocation,
    locationTokens,
    locationSearchValue,
};
