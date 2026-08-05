const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'jobtracker.db'));
db.exec(fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8'));

const insertCompany = db.prepare(
    `INSERT INTO watched_companies (name, career_url, adapter_type, adapter_config)
     VALUES (?, ?, ?, ?)`
);

const insertProfile = db.prepare(
    `INSERT INTO search_profiles (name, keywords, location_filter, experience_filter)
     VALUES (?, ?, ?, ?)`
);

// Amazon's endpoint was verified against a live response, so this row works now.
insertCompany.run(
    'Amazon Israel',
    'https://www.amazon.jobs/en/search?country=ISR',
    'amazon',
    JSON.stringify({ country: 'ISR' })
);

// Start wide. If you seed a narrow filter, an empty result tells you nothing —
// you can't tell "no matches yet" apart from "my keywords are wrong".
// Tighten this once you've seen what actually comes back.
insertProfile.run(
    'Software roles in Israel',
    'software,backend,frontend,full stack,developer,engineer,student',
    null,
    'student,junior'
);

const companies = db.prepare('SELECT COUNT(*) AS n FROM watched_companies').get().n;
const profiles = db.prepare('SELECT COUNT(*) AS n FROM search_profiles').get().n;
console.log(`Seeded. watched_companies: ${companies}, search_profiles: ${profiles}`);
console.log('Next: node src/main.js');
