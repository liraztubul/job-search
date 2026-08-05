const { JobSource } = require('./JobSource');

/**
 * Comeet exposes a public JSON endpoint per company (no auth needed).
 *
 * WARNING: this mapping was written against Comeet's documented shape and has
 * NEVER been checked against a live response. Before trusting it, run:
 *   node tools/probe.js "https://www.comeet.com/careers-api/2.0/company/<uid>/positions"
 */
class ComeetAdapter extends JobSource {
    static type = 'comeet';
    static describe = {
        help: 'Any company hosted on the Comeet platform. UNVERIFIED — probe before use.',
        required: { companyUid: "the company's Comeet uid, found in its careers page URL" },
        optional: {},
    };

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

        if (!Array.isArray(data)) {
            throw new Error(`Comeet response shape changed: expected an array, got ${typeof data}`);
        }

        return data.map((pos) => ({
            externalId: String(pos.uid),
            title: pos.name,
            location: pos.location ? `${pos.location.name}` : '',
            applyUrl: pos.url_comeet_hosted_page || pos.url,
        }));
    }
}

module.exports = { ComeetAdapter };
