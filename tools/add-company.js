/**
 * add-company.js — add a watched company without editing any code.
 *
 *   node tools/add-company.js
 *       list the adapters available and the companies already watched
 *
 *   node tools/add-company.js --name "Amazon Israel" --type amazon --country ISR
 *       add a company; every extra --flag becomes part of the adapter config
 *
 * The config is validated against what the adapter declares it needs, so a typo
 * fails here with a readable message instead of at 3am in the middle of a scrape.
 */

const db = require('../src/db');
const { availableTypes, getAdapterClass, validateConfig } = require('../src/adapters');

const RESERVED = ['name', 'type', 'url'];

/** --name "Amazon Israel" --country ISR  ->  { name: 'Amazon Israel', country: 'ISR' } */
function parseArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i++) {
        if (!argv[i].startsWith('--')) continue;
        const key = argv[i].slice(2);
        const next = argv[i + 1];
        args[key] = next && !next.startsWith('--') ? next : true;
        if (args[key] !== true) i++;
    }
    return args;
}

function showUsage() {
    console.log('\nAvailable adapters:\n');
    for (const type of availableTypes()) {
        const { describe = {} } = getAdapterClass(type);
        console.log(`  ${type}`);
        if (describe.help) console.log(`      ${describe.help}`);
        for (const [key, desc] of Object.entries(describe.required || {})) {
            console.log(`      --${key.padEnd(14)} (required) ${desc}`);
        }
        for (const [key, desc] of Object.entries(describe.optional || {})) {
            console.log(`      --${key.padEnd(14)} (optional) ${desc}`);
        }
        console.log('');
    }

    const companies = db.listCompanies();
    console.log(`Currently watching (${companies.length}):\n`);
    if (companies.length === 0) {
        console.log('  none yet\n');
    } else {
        for (const c of companies) {
            const state = c.is_active ? '' : ' [inactive]';
            console.log(`  ${c.name}${state}  —  ${c.adapter_type}  ${c.adapter_config || '{}'}`);
        }
        console.log('');
    }

    console.log('Example:');
    console.log('  node tools/add-company.js --name "Amazon Israel" --type amazon --country ISR\n');
}

function main() {
    const args = parseArgs(process.argv.slice(2));

    if (!args.name || !args.type) {
        showUsage();
        process.exit(Object.keys(args).length ? 1 : 0);
    }

    const AdapterClass = getAdapterClass(args.type);
    if (!AdapterClass) {
        console.error(`\nUnknown adapter type "${args.type}".`);
        console.error(`Available: ${availableTypes().join(', ')}\n`);
        console.error('If the company runs on a platform with no adapter yet, probe it first:');
        console.error('  node tools/probe.js "<url>"\n');
        process.exit(1);
    }

    if (db.findCompanyByName(args.name)) {
        console.error(`\n"${args.name}" is already being watched. Pick another name or remove it first.\n`);
        process.exit(1);
    }

    // Everything that isn't a reserved flag is adapter config.
    const config = {};
    for (const [key, value] of Object.entries(args)) {
        if (!RESERVED.includes(key)) config[key] = value;
    }

    const problems = validateConfig(AdapterClass, config);
    if (problems.length) {
        console.error(`\nCannot add "${args.name}" — config problems:\n`);
        for (const p of problems) console.error(`  - ${p}`);
        console.error('');
        process.exit(1);
    }

    const id = db.addCompany({
        name: args.name,
        careerUrl: args.url || '',
        adapterType: args.type,
        config,
    });

    console.log(`\nAdded "${args.name}" (id ${id}) using the ${args.type} adapter.`);
    console.log(`Config: ${JSON.stringify(config)}`);
    console.log('\nNext: node src/main.js\n');
}

main();
