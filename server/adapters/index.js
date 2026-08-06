const fs = require('fs');
const path = require('path');

/**
 * Adapter registry.
 *
 * Every `*Adapter.js` file in this folder that exports a class with a static
 * `type` registers itself here automatically. Adding support for a new platform
 * is exactly one new file — nothing else in the project changes.
 *
 * The alternative (a `switch` in main.js) means every new adapter forces an edit
 * to a file that has nothing to do with it. That's the coupling this removes.
 */

const registry = new Map();

for (const file of fs.readdirSync(__dirname)) {
    if (!file.endsWith('Adapter.js')) continue;

    let mod;
    try {
        mod = require(path.join(__dirname, file));
    } catch (err) {
        // Name the file. A bare stack trace from inside a dynamic require is
        // one of the least helpful errors a project can produce.
        throw new Error(`Failed to load adapter file "${file}": ${err.message}`);
    }

    for (const exported of Object.values(mod)) {
        if (typeof exported !== 'function' || !exported.type) continue;

        if (registry.has(exported.type)) {
            throw new Error(
                `Duplicate adapter type "${exported.type}" — declared by both ` +
                    `${registry.get(exported.type).name} and ${exported.name}.`
            );
        }
        registry.set(exported.type, exported);
    }
}

/** @returns {string[]} e.g. ['amazon', 'comeet'] */
function availableTypes() {
    return [...registry.keys()].sort();
}

/** @returns {Function|undefined} the adapter class for a type */
function getAdapterClass(type) {
    return registry.get(type);
}

/**
 * Check a config against what the adapter says it needs, and say so clearly.
 * Catching this when a company is ADDED beats catching it at 3am mid-scrape.
 * @returns {string[]} human-readable problems; empty means valid
 */
function validateConfig(AdapterClass, config) {
    const required = Object.keys(AdapterClass.describe?.required || {});
    const optional = Object.keys(AdapterClass.describe?.optional || {});
    const problems = [];

    for (const key of required) {
        if (config[key] === undefined || config[key] === '') {
            problems.push(`missing required option "${key}" — ${AdapterClass.describe.required[key]}`);
        }
    }

    for (const key of Object.keys(config)) {
        if (!required.includes(key) && !optional.includes(key)) {
            problems.push(`unknown option "${key}" (accepted: ${[...required, ...optional].join(', ') || 'none'})`);
        }
    }

    return problems;
}

/**
 * Turn a watched_companies row into a ready-to-use adapter instance.
 * @param {{name:string, adapter_type:string, adapter_config:string|null}} company
 */
function buildAdapter(company) {
    const AdapterClass = getAdapterClass(company.adapter_type);
    if (!AdapterClass) {
        throw new Error(
            `Unknown adapter_type "${company.adapter_type}" for ${company.name}. ` +
                `Available: ${availableTypes().join(', ')}`
        );
    }

    let config;
    try {
        config = company.adapter_config ? JSON.parse(company.adapter_config) : {};
    } catch (err) {
        throw new Error(`adapter_config for ${company.name} is not valid JSON: ${err.message}`);
    }

    const problems = validateConfig(AdapterClass, config);
    if (problems.length) {
        throw new Error(`Bad config for ${company.name} (${company.adapter_type}): ${problems.join('; ')}`);
    }

    return new AdapterClass(config);
}

module.exports = { availableTypes, getAdapterClass, validateConfig, buildAdapter };
