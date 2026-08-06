/**
 * @typedef {Object} RawJob
 * @property {string} externalId  - unique ID of the job on the source site
 * @property {string} title
 * @property {string} location
 * @property {string} applyUrl
 */

/**
 * Every adapter (Comeet, Greenhouse, custom company site...) must expose this method.
 * The rest of the system never needs to know HOW the jobs were fetched.
 * @interface
 */
class JobSource {
    /** @returns {Promise<RawJob[]>} */
    async getCurrentJobs() {
        throw new Error('getCurrentJobs() not implemented');
    }
}

module.exports = { JobSource };
