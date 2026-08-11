// Isolated in-memory DB — see tests/jobs.test.js for why this has to be set
// before anything in server/data/ is required.
process.env.JT_DB_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert');
const { addCompany } = require('../server/data/companies');
const { upsertJobSnapshot } = require('../server/data/jobs');
const { createUser } = require('../server/data/users');
const { searchJobs } = require('../server/services/jobSearchService');

let userId;

test.before(() => {
    userId = createUser({ email: 'search-service-test@example.com', passwordHash: 'x' });
});

function seedCompanyWithJobs(count, location) {
    const companyId = addCompany({ name: `SearchService Co ${Math.random()}`, careerUrl: '', adapterType: 'manual', config: {} });
    for (let i = 0; i < count; i++) {
        upsertJobSnapshot(companyId, {
            externalId: `job-${companyId}-${i}`,
            title: `Job ${i}`,
            location,
            applyUrl: 'https://example.com',
        });
    }
    return companyId;
}

test('a page beyond the last real page returns an empty jobs array, not another page\'s rows', () => {
    const companyId = seedCompanyWithJobs(5, 'Tel Aviv');

    const params = new URLSearchParams({ company: String(companyId), pageSize: '20', page: '99999' });
    const result = searchJobs(userId, params);

    assert.equal(result.page, 99999, 'the requested page is echoed back, not silently substituted');
    assert.deepEqual(result.jobs, []);
    // The count is still honest about what the filter actually matches — an
    // empty `jobs` array here means "nothing on THIS page", not "no matches".
    assert.equal(result.totalMatching, 5);
    assert.equal(result.totalPages, 1);
});

test('page=0 and negative pages sanitize to page 1 — that is invalid input, not "beyond totalPages"', () => {
    const companyId = seedCompanyWithJobs(3, 'Haifa');

    for (const page of ['0', '-1', 'not-a-number', '']) {
        const params = new URLSearchParams({ company: String(companyId), page });
        const result = searchJobs(userId, params);
        assert.equal(result.page, 1, `page=${JSON.stringify(page)} should sanitize to 1`);
        assert.equal(result.jobs.length, 3);
    }
});

test('pageSize is still capped at 100 regardless of how far out of range the page is', () => {
    const companyId = seedCompanyWithJobs(2, 'Jerusalem');
    const params = new URLSearchParams({ company: String(companyId), page: '5000', pageSize: '9999' });
    const result = searchJobs(userId, params);

    assert.equal(result.pageSize, 100);
    assert.deepEqual(result.jobs, []);
});
