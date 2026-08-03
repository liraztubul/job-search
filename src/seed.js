const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'jobtracker.db'));
db.exec(fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8'));

// Example only — replace companyUid with a real one once you find it (see README).
db.prepare(
    `INSERT INTO watched_companies (name, career_url, adapter_type, adapter_config)
     VALUES (?, ?, ?, ?)`
).run('Example Comeet Company', 'https://www.comeet.com/jobs/example', 'comeet', JSON.stringify({ companyUid: 'REPLACE_ME' }));

db.prepare(
    `INSERT INTO search_profiles (name, keywords, location_filter, experience_filter)
     VALUES (?, ?, ?, ?)`
).run('Backend roles in Haifa', 'backend,server,node,python', 'Haifa', 'student,junior');

console.log('Seeded 1 company + 1 search profile.');
