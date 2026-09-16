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
    // \bTLV\b: the colloquial shorthand for Tel Aviv in Israeli tech job posts
    // (Lemonade's Ashby board labels every Tel Aviv job just "TLV" — see
    // docs/ROADMAP.md's location audit). Word-boundaried since it's a bare
    // three-letter token, unlike the longer names below that are safe as a
    // plain substring match.
    { pattern: /(?:תל\s*אביב|Tel\s*Aviv|TelAviv|Tel-Aviv|\bTLV\b)/i, value: 'Tel Aviv' },
    { pattern: /(?:חיפה|Haifa)/i, value: 'Haifa' },
    { pattern: /(?:ירושלים|Jerusalem)/i, value: 'Jerusalem' },
    { pattern: /(?:רמת\s*גן|Ramat\s*Gan)/i, value: 'Ramat Gan' },
    { pattern: /(?:נתניה|Netanya)/i, value: 'Netanya' },
    { pattern: /(?:הרצליה|Herzliya)/i, value: 'Herzliya' },
    { pattern: /(?:באר\s*שבע|Be[']?er\s*Sheva|Beer\s*Sheva)/i, value: 'Beer Sheva' },
    // Petach (with a 'c') is a real, common alternate transliteration — PANW's
    // own Workday feed spells it that way ("Office - Israel - CyberArk Petach
    // Tikva"), and the old pattern (Petah only) silently dropped all 134 of
    // those jobs from the location filter. See docs/ROADMAP.md.
    { pattern: /(?:פתח\s*תקווה|Peta(?:h|ch)\s*Tikva)/i, value: 'Petah Tikva' },
    // Yoqneam (with a 'q') is another real alternate spelling, same reasoning.
    { pattern: /(?:יקנעם|Yo[kq]neam)/i, value: 'Yokneam' },
    { pattern: /(?:רעננה|Ra['’]?anana)/i, value: 'Raanana' },
    { pattern: /(?:תל\s*חי|Tel\s*Hai)/i, value: 'Tel Hai' },
    { pattern: /(?:מודיעין|Modi['’]?in)/i, value: "Modi'in" },
    // Northern towns added together (docs/ROADMAP.md's location audit) — none
    // were previously recognized at all, so any job listed under one of these
    // was invisible to every location filter. "אלון תבור" (Alon Tabor) is the
    // industrial park adjoining Migdal Ha'emek, not a separate town of its
    // own — 74 real jobs used exactly that spelling with no other city name
    // present, confirmed against job_snapshots.
    { pattern: /(?:מגדל\s*העמק|אלון\s*תבור|Migdal\s*Ha['’]?[Ee]mek|Alon\s*Tabor)/i, value: "Migdal Ha'emek" },
    { pattern: /(?:כרמיאל|Karmiel|Carmiel)/i, value: 'Karmiel' },
    { pattern: /(?:נשר|Nesher)/i, value: 'Nesher' },
    { pattern: /(?:טירת\s*כרמל|Tirat\s*(?:Ha)?Carmel)/i, value: 'Tirat Carmel' },
    { pattern: /(?:קרית\s*אתא|קריית\s*אתא|Kir?yat\s*Ata)/i, value: 'Kiryat Ata' },
    { pattern: /(?:קרית\s*ביאליק|קריית\s*ביאליק|Kir?yat\s*Bialik)/i, value: 'Kiryat Bialik' },
    { pattern: /(?:קרית\s*מוצקין|קריית\s*מוצקין|Kir?yat\s*Motzkin)/i, value: 'Kiryat Motzkin' },
    { pattern: /(?:נהריה|Nahariy?a)/i, value: 'Nahariya' },
    // "Akko" only, not "Acre" — Acre is also an ordinary English word (a unit
    // of land), and guessing it in would risk matching something that isn't
    // this city at all. See docs/ROADMAP.md's "do not guess" note.
    { pattern: /(?:עכו|\bAkko\b)/i, value: 'Akko' },
    { pattern: /(?:עפולה|Afula)/i, value: 'Afula' },
    { pattern: /(?:קיסריה|Caesarea)/i, value: 'Caesarea' },
    { pattern: /(?:זכרון\s*יעקב|זיכרון\s*יעקב|Zi[kc]hron\s*Ya['’]?akov)/i, value: "Zikhron Ya'akov" },
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

// The generic-region tail of LOCATION_CANONICAL — "Israel" or "North" alone
// names no specific place, and filterOptions() (server/data/jobs.js) already
// excludes bare "Israel" from the location facet for the same reason.
// primaryCanonicalLocation uses this to prefer an actual city/town whenever
// one is also present, regardless of which order the source writes them in —
// Eightfold specifically writes "Israel, Yokneam" (country BEFORE city), so
// picking the first Israeli token unconditionally would prefer the least
// specific one exactly when a more specific one is sitting right next to it.
const GENERIC_LOCATION_VALUES = new Set(['North', 'South', 'Center', 'Sharon', 'Shfela', 'Gush Dan', 'Israel']);

/**
 * The one canonical city/region a job's raw location string most likely
 * means, for DISPLAY — e.g. so the client can render "Haifa, Israel" as חיפה
 * instead of the raw English text. `null` when nothing in the raw string
 * resolves (a foreign-only location, or a spelling this vocabulary doesn't
 * recognize yet — see the location audit in docs/ROADMAP.md); the caller
 * falls back to the raw string in that case, same as it always did.
 *
 * Prefers a specific city/town over a generic region/country bucket when a
 * raw string names both, no matter which order they appear in; falls back
 * to the generic bucket only when that's the only Israeli token found.
 *
 * This is the one place that decision gets made — GET /api/jobs sends the
 * result alongside the raw `location` (see jobSearchService.js) and the
 * client just looks it up in its own Hebrew label map (client/js/ui.js).
 * Copying these regexes into the client instead would create a second list
 * that can drift from this one, the exact thing buildJobFilters() (server/
 * data/jobs.js) already exists to prevent on the query side.
 */
function primaryCanonicalLocation(rawLocation) {
    const israeliTokens = locationTokens(rawLocation).filter((token) => isIsraeliLocation(token));
    if (israeliTokens.length === 0) return null;
    return israeliTokens.find((token) => !GENERIC_LOCATION_VALUES.has(token)) ?? israeliTokens[0];
}

module.exports = {
    LOCATION_CANONICAL,
    isIsraeliLocation,
    canonicalizeLocation,
    locationTokens,
    locationSearchValue,
    primaryCanonicalLocation,
};
