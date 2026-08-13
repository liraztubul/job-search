/**
 * One-time setup: create jobtrail.db and put one working company in it.
 *
 * Goes through server/db like everything else. It used to open its own
 * connection and run schema.sql by hand, which meant it skipped the column
 * migrations — a second copy of the bootstrap that could quietly drift from
 * the real one.
 */

const db = require('./data');

if (db.listCompanies().length > 0) {
    console.log('Already seeded. Use tools/add-company.js to add more companies.');
    process.exit(0);
}

// Amazon's endpoint was verified against a live response, so this row works now.
db.addCompany({
    name: 'Amazon Israel',
    careerUrl: 'https://www.amazon.jobs/en/search?country=ISR',
    adapterType: 'amazon',
    config: { country: 'ISR' },
});

// Start wide. A narrow filter makes an empty result meaningless — you can't
// tell "no matches yet" apart from "my keywords are wrong".
db.addSearchProfile({
    name: 'Software roles in Israel',
    keywords: 'software,backend,frontend,full stack,developer,engineer,student',
    locationFilter: null,
    experienceFilter: 'student,junior',
});

console.log(`Seeded ${db.listCompanies().length} company, ${db.getActiveProfiles().length} search profile.`);
console.log('Next: node server/main.js');
