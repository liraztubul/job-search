/**
 * Is this a technology role? — the "רק היי-טק" (tech-only) filter, on by
 * default on a site titled "חיפוש משרות היי-טק בישראל" that otherwise also
 * serves whatever else a company's own feed happens to carry (Keter's
 * WordPress feed is the company's entire hiring, not just engineering —
 * a store salesperson and a head printer both showed up on page 1).
 *
 * GENEROUS, NOT AGGRESSIVE — read this before adding a pattern.
 *
 * A real engineering job wrongly hidden is the failure this filter exists to
 * prevent; a non-tech job wrongly left visible is a minor annoyance. Two
 * layers enforce that, in order:
 *
 *   1. TITLE_INCLUDE_RE — the categories the work order names outright
 *      ("engineering, hardware, data, QA, DevOps, IT, product, design").
 *      Checked against the TITLE ONLY, and wins outright. This exists
 *      because a source's own department taxonomy is noisy and can point
 *      the wrong way even when the title is unambiguous — a real example
 *      found while building this: "Director, Product Management" filed
 *      under department "Mgmt, Product Marketing" would be wrongly excluded
 *      by a marketing pattern if department were allowed to overrule what
 *      the title plainly says.
 *   2. NON_TECH_PATTERNS — a BLOCKLIST, not an allowlist, checked against
 *      title + department together only once step 1 found no clear tech
 *      signal. A job is excluded only when it clearly names a non-technical
 *      function; unrecognized or missing text is never a reason to exclude.
 *
 * Domain logic: pure, no database, no network.
 */

// A source's own department field sometimes says this outright (Workday
// splits "Program Mgr, Technical" from "Program Mgr, Non-Technical") —
// checked against title + department, independent of everything else.
const EXPLICIT_TECHNICAL_RE = /\btechnical\b/i;
const EXPLICIT_NON_TECHNICAL_RE = /non[\s-]?technical/i;

// The categories the work order names outright, checked against the TITLE
// only — see the module comment for why title wins over a noisy department
// string. "software" and "system(s)" are included as general nouns (not
// just "software engineer") because a management title over a technical
// function — "Manager, Software Drivers" — is still the kind of role this
// filter must not hide.
const TITLE_INCLUDE_RE =
    /engineer|developer|\barchitect\b|\bqa\b|quality\s*assurance|dev\s*-?ops|product\s*manage|product\s*owner|\bdesigner\b|\bux\b|\bui\b|data\s*scien|machine\s*learning|\balgorithm|information\s*technology|\binfrastructure\b|\bhardware\b|\bfirmware\b|\bsoftware\b|\bsystems?\b|network(?:ing)?|security|\bcyber\b|\bit\s*(?:admin|support)\b/i;

// Categories with no real engineering/data/product/design reading, in either
// language. Matched against title + department together; matching any
// excludes. Kept to unambiguous whole functions on purpose — see the module
// comment. Deliberately NOT included: a bare "driver(s)" pattern — real
// engineering titles ("Networking drivers", "Software Drivers") use the word
// for device/kernel drivers, not the trucking/delivery department; the
// literal "Drivers" department is matched as its own exact case below
// instead of a loose substring.
const NON_TECH_PATTERNS = [
    // Sales / retail / business development
    /\bsales\b|salesperson|store\s*manager|\bretail\b|\bcashier\b|strategic\s*account|business\s*development|merchant\s*development|\baccount\s*executive\b/i,
    /מוכר(?:\.|ת|ים)?|קופ[אה]י(?:ת)?|חנות|מכירות/i,
    // Marketing / PR / brand — but never a Product/Program *Management* title,
    // which is an explicitly included category (see TITLE_INCLUDE_RE above);
    // this only fires when "marketing" itself is the function.
    /\bmarketing\b|\bpr\b|branding|\badvertising\b/i,
    /שיווק|יחסי\s*ציבור/i,
    // Finance / accounting / procurement
    /\baccounting\b|\bfp&a\b|budget\s*control|procurement|purchasing|\bpayroll\b|bookkeeping|salary\s*controller|financial\s*controller/i,
    /הנהלת\s*חשבונות|\bרכש\b|בקר(?:ת)?\s*שכר|חשב(?:ת)?(?:\s|$)/i,
    // HR / recruiting / people / learning
    /human\s*resources|\bhr\b|recruit(?:er|ment|ing)?|\bsourcer\b|people\s*experience|total\s*rewards|learning\s*&?\s*training|talent\s*acquisition/i,
    /משאבי\s*אנוש|גיוס|רכז(?:\.|ת)?\s*(?:גיוס|משאבי)/i,
    // Legal
    /\blegal\b|attorney|\blawyer\b/i,
    /משפטי|עו"?ד/i,
    // Administrative / office support / executive support
    /administrative\s*(?:support|assistant)|executive\s*assistant|\breceptionist\b|\bsecretary\b|office\s*manager|\bceo\s*office\b/i,
    /מזכיר(?:ה|ת)?|פקיד(?:ה)?/i,
    // Logistics / supply chain (non-technical)
    /\blogistics\b(?!\s*(?:engineer|technician))|supply\s*chain\s*management|supply\s*chain\/transportation|\bshipping\b/i,
    /לוגיסטיקה|משאית/i,
    // Printing / press operation, warehouse / forklift
    /press\s*operator|printer\s*operator|\bforklift\b/i,
    /דפס(?:\.|ת|ים)?|מלגזה|מחסנ(?:אי|ות)/i,
    // Food service / catering
    /\bchef\b|\bcook\b|\bbarista\b|\bwaiter\b|\bcatering\b/i,
    /טבח(?:ית)?|בשלן|מלצר(?:ית)?/i,
];

// The literal department string, matched exactly (trimmed, case-insensitive)
// rather than as a substring — "Drivers" the department (trucking/delivery)
// is unambiguous; "driver" the word is not (see the module comment).
const NON_TECH_DEPARTMENTS = new Set(['drivers']);

/**
 * @param {{title?: string, department?: string|null}} job
 * @returns {boolean} true unless the job clearly names a non-technical
 *   function — see the module comment for why the default is "include".
 */
function isTechJob(job) {
    const title = job.title || '';
    const department = job.department || '';
    const combined = `${title} ${department}`;

    if (!combined.trim()) return true; // nothing to judge by — generous default

    if (TITLE_INCLUDE_RE.test(title)) return true;
    if (NON_TECH_DEPARTMENTS.has(department.trim().toLowerCase())) return false;
    if (EXPLICIT_NON_TECHNICAL_RE.test(combined)) return false;
    if (EXPLICIT_TECHNICAL_RE.test(combined)) return true;

    return !NON_TECH_PATTERNS.some((pattern) => pattern.test(combined));
}

module.exports = { isTechJob };
