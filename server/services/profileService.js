/**
 * Rules for creating and editing a search profile, kept away from both HTTP
 * and SQL — same split as applicationService.js.
 *
 * Every *_filter value the client can send must come from a closed
 * vocabulary (server/domain/vocabulary.js's EMPLOYMENT_TYPES/EXPERIENCE_LEVELS,
 * server/domain/locations.js's LOCATION_CANONICAL) rather than free text: a
 * value outside those sets would make a saved profile silently match nothing
 * in matcher.js, which looks identical to "no jobs fit you right now".
 */

const data = require('../data');
const { EMPLOYMENT_TYPES, EXPERIENCE_LEVELS } = require('../domain/vocabulary');
const { LOCATION_CANONICAL } = require('../domain/locations');

const VALID_LOCATIONS = new Set(LOCATION_CANONICAL.map((c) => c.value));

/** Everything the profile form's dropdowns/checkboxes are built from. */
const VOCABULARY = {
    employmentTypes: EMPLOYMENT_TYPES,
    experienceLevels: EXPERIENCE_LEVELS,
    locations: [...VALID_LOCATIONS],
};

/** A single value, or a comma/array list, reduced to a validated comma-string or null. */
function normalizeFilter(raw, allowed, fieldName) {
    if (raw == null || raw === '') return { ok: true, value: null };

    const values = (Array.isArray(raw) ? raw : String(raw).split(','))
        .map((v) => String(v).trim())
        .filter(Boolean);

    if (values.length === 0) return { ok: true, value: null };

    for (const v of values) {
        if (!allowed.has(v)) return { ok: false, error: `${fieldName}: unrecognized value "${v}"` };
    }

    return { ok: true, value: [...new Set(values)].join(',') };
}

/**
 * @returns {{ok: true, value: object} | {ok: false, error: string}}
 */
function validatePayload(payload = {}, { partial = false } = {}) {
    const value = {};

    if ('name' in payload || !partial) {
        const name = String(payload.name ?? '').trim();
        if (!name) return { ok: false, error: 'name is required' };
        value.name = name;
    }

    if ('keywords' in payload || !partial) {
        const keywords = (Array.isArray(payload.keywords) ? payload.keywords : String(payload.keywords ?? '').split(','))
            .map((k) => String(k).trim())
            .filter(Boolean);
        if (keywords.length === 0) return { ok: false, error: 'at least one keyword is required' };
        value.keywords = [...new Set(keywords)].join(',');
    }

    if ('locations' in payload || 'locationFilter' in payload || !partial) {
        const raw = 'locations' in payload ? payload.locations : payload.locationFilter;
        const result = normalizeFilter(raw, VALID_LOCATIONS, 'location');
        if (!result.ok) return result;
        value.locationFilter = result.value;
    }

    if ('experienceLevel' in payload || 'experienceFilter' in payload || !partial) {
        const raw = 'experienceLevel' in payload ? payload.experienceLevel : payload.experienceFilter;
        const result = normalizeFilter(raw, new Set(EXPERIENCE_LEVELS), 'experience level');
        if (!result.ok) return result;
        value.experienceFilter = result.value;
    }

    if ('employmentType' in payload || 'employmentFilter' in payload || !partial) {
        const raw = 'employmentType' in payload ? payload.employmentType : payload.employmentFilter;
        const result = normalizeFilter(raw, new Set(EMPLOYMENT_TYPES), 'employment type');
        if (!result.ok) return result;
        value.employmentFilter = result.value;
    }

    if ('isActive' in payload) value.isActive = Boolean(payload.isActive);

    return { ok: true, value };
}

function listProfiles(userId) {
    return { profiles: data.listProfiles(userId), vocabulary: VOCABULARY };
}

/** @returns {{ok: true, profile: object} | {ok: false, error: string}} */
function createProfile(userId, payload) {
    const validated = validatePayload(payload, { partial: false });
    if (!validated.ok) return validated;

    const id = data.addSearchProfile({ userId, ...validated.value });
    return { ok: true, profile: data.getProfile(userId, id) };
}

/** @returns {{ok: true, profile: object|null} | {ok: false, error: string}} */
function updateProfile(userId, id, payload) {
    const profileId = Number(id);
    if (!Number.isInteger(profileId) || profileId <= 0) return { ok: false, error: 'invalid profile id' };

    const validated = validatePayload(payload, { partial: true });
    if (!validated.ok) return validated;

    const profile = data.updateProfile(userId, profileId, validated.value);
    if (!profile) return { ok: false, error: 'no such profile' };
    return { ok: true, profile };
}

/** @returns {{ok: true} | {ok: false, error: string}} */
function deleteProfile(userId, id) {
    const profileId = Number(id);
    if (!Number.isInteger(profileId) || profileId <= 0) return { ok: false, error: 'invalid profile id' };

    const deleted = data.deleteProfile(userId, profileId);
    if (!deleted) return { ok: false, error: 'no such profile' };
    return { ok: true };
}

module.exports = { VOCABULARY, listProfiles, createProfile, updateProfile, deleteProfile };
