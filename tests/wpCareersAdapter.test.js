const test = require('node:test');
const assert = require('node:assert');
const { WpCareersAdapter, mapWpCareersPost, embeddedTermName } = require('../server/adapters/wpCareersAdapter');
const { matches } = require('../server/domain/matcher');

/**
 * One posting cut verbatim (trimmed) out of a real response captured
 * 2026-08-11 (GET https://careers.ketergroup.com/wp-json/wp/v2/careers
 * ?per_page=100&_embed=true).
 */
const PRINT_OPERATOR_JOB = {
    id: 76303,
    date: '2026-08-05T09:12:00',
    link: 'https://careers.ketergroup.com/careers/%d7%9e%d7%a4%d7%a2%d7%99%d7%9c-%d7%9e%d7%9b%d7%95%d7%a0%d7%aa-%d7%94%d7%93%d7%a4%d7%a1%d7%94/',
    title: { rendered: 'מפעיל.ת מכונת הדפסה' },
    _embedded: {
        'wp:term': [
            [{ id: 26564, name: 'כרמיאל', slug: '74', taxonomy: 'job_locall' }],
            [{ id: 26530, name: 'מכונות', slug: '3200', taxonomy: 'job_proff' }],
        ],
    },
};

const ENGLISH_JOB = {
    id: 76296,
    date: '2026-08-01T00:00:00',
    link: 'https://careers.ketergroup.com/careers/social-media-manager/',
    title: { rendered: 'Global social media &amp; Digital content manager' },
    _embedded: {
        'wp:term': [[{ id: 1, name: 'הרצליה', slug: '1', taxonomy: 'job_locall' }]],
    },
};

test('maps a real posting into RawJob', () => {
    const job = mapWpCareersPost(PRINT_OPERATOR_JOB, 'job_locall');

    assert.equal(job.externalId, '76303');
    assert.equal(job.title, 'מפעיל.ת מכונת הדפסה');
    assert.equal(job.location, 'כרמיאל');
    assert.equal(job.applyUrl, PRINT_OPERATOR_JOB.link);
    assert.equal(job.postedAt, '2026-08-05');
});

test('decodes HTML entities in the title', () => {
    const job = mapWpCareersPost(ENGLISH_JOB, 'job_locall');
    assert.equal(job.title, 'Global social media & Digital content manager');
});

test('throws rather than inventing an id', () => {
    const { id, ...noId } = PRINT_OPERATOR_JOB;
    assert.throws(() => mapWpCareersPost(noId, 'job_locall'), /no id/);
});

test('every job emits the keys the schema stores', () => {
    const required = ['externalId', 'title', 'location', 'applyUrl', 'employmentType', 'experienceLevel'];
    for (const job of [mapWpCareersPost(PRINT_OPERATOR_JOB, 'job_locall'), mapWpCareersPost(ENGLISH_JOB, 'job_locall')]) {
        for (const key of required) assert.ok(key in job, `${job.title} is missing "${key}"`);
    }
});

// ---------------------------------------------------------------------------
// Taxonomy resolution — the whole reason _embed is required
// ---------------------------------------------------------------------------

test('embeddedTermName resolves the configured taxonomy, ignoring the others', () => {
    assert.equal(embeddedTermName(PRINT_OPERATOR_JOB, 'job_locall'), 'כרמיאל');
    assert.equal(embeddedTermName(PRINT_OPERATOR_JOB, 'job_proff'), 'מכונות');
});

test('no location taxonomy configured leaves location blank rather than guessing', () => {
    assert.equal(embeddedTermName(PRINT_OPERATOR_JOB, ''), '');
    const job = mapWpCareersPost(PRINT_OPERATOR_JOB, '');
    assert.equal(job.location, '');
});

// ---------------------------------------------------------------------------
// URL building — this is a generic WP shape, not a branded platform
// ---------------------------------------------------------------------------

test('builds the postings URL from config, not a constant', () => {
    const adapter = new WpCareersAdapter({ host: 'careers.ketergroup.com', postType: 'careers', locationTaxonomy: 'job_locall' });
    assert.equal(adapter.postingsUrl, 'https://careers.ketergroup.com/wp-json/wp/v2/careers?per_page=100&_embed=true');
});

test('another WordPress careers site is configuration, not a new file', () => {
    const adapter = new WpCareersAdapter({ host: 'jobs.example.com', postType: 'openings' });
    assert.equal(adapter.postingsUrl, 'https://jobs.example.com/wp-json/wp/v2/openings?per_page=100&_embed=true');
});

// ---------------------------------------------------------------------------
// The seam with the matcher
// ---------------------------------------------------------------------------

test('a parsed job survives a Karmiel profile', () => {
    const job = mapWpCareersPost(PRINT_OPERATOR_JOB, 'job_locall');
    assert.equal(matches(job, { keywords: 'מכונת,הדפסה', location_filter: 'כרמיאל' }), true);
    assert.equal(matches(job, { keywords: 'מכונת,הדפסה', location_filter: 'הרצליה' }), false);
});
