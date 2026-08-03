const fetch = require('node-fetch');
const { JobSource } = require('./JobSource');

/**
 * Comeet exposes a public JSON endpoint per company (no auth needed).
 * NOTE: field names below follow Comeet's commonly documented public shape —
 * verify against a real response for your target company before relying on it,
 * since undocumented third-party APIs can drift. Print raw JSON once and check.
 */
class ComeetAdapter extends JobSource {
    /** @param {{ companyUid: string }} config */
    constructor(config) {
        super();
        this.companyUid = config.companyUid;
        this.endpoint = `https://www.comeet.com/careers-api/2.0/company/${this.companyUid}/positions`;
    }

    async getCurrentJobs() {
        const res = await fetch(this.endpoint);
        if (!res.ok) {
            throw new Error(`Comeet fetch failed: ${res.status} ${res.statusText}`);
        }
        const data = await res.json();

        return data.map((pos) => ({
            externalId: pos.uid,
            title: pos.name,
            location: pos.location ? `${pos.location.name}` : '',
            applyUrl: pos.url_comeet_hosted_page || pos.url,
        }));
    }
}

module.exports = { ComeetAdapter };
