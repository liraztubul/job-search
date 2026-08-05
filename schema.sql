-- Companies we monitor directly (the "VIP list")
CREATE TABLE IF NOT EXISTS watched_companies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    career_url TEXT NOT NULL,
    adapter_type TEXT NOT NULL,   -- e.g. 'comeet', 'greenhouse', 'custom_elbit'
    adapter_config TEXT,          -- JSON string with adapter-specific params (e.g. company slug)
    is_active INTEGER DEFAULT 1
);

-- Every job we've ever seen, per company, per scrape cycle
CREATE TABLE IF NOT EXISTS job_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL REFERENCES watched_companies(id),
    external_id TEXT NOT NULL,     -- the job's own ID on the source site
    title TEXT NOT NULL,
    location TEXT,
    apply_url TEXT NOT NULL,
    first_seen_at TEXT NOT NULL,   -- ISO timestamp
    last_seen_at TEXT NOT NULL,
    is_still_open INTEGER DEFAULT 1,
    -- Fields the UI filters on. Normalized to closed vocabularies by the
    -- adapters (see src/adapters/normalize.js) so "Full time" and "full-time"
    -- don't become two separate options in a dropdown.
    employment_type TEXT,          -- full-time | part-time | contract | temporary | internship
    experience_level TEXT,         -- intern | entry | mid | senior
    department TEXT,               -- source's own wording, e.g. "Algorithms"
    posted_at TEXT,                -- source's own wording, not parsed to a date
    UNIQUE(company_id, external_id)
);

-- Your application pipeline. One row per job you've engaged with — absent means
-- untouched. Deliberately separate from job_snapshots: a scrape rewrites job
-- rows, and your own notes must never be collateral damage.
CREATE TABLE IF NOT EXISTS applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_snapshot_id INTEGER NOT NULL UNIQUE REFERENCES job_snapshots(id),
    status TEXT NOT NULL DEFAULT 'saved',  -- saved | applied | interviewing | offer | rejected
    notes TEXT,
    applied_at TEXT,
    updated_at TEXT NOT NULL
);

-- Your saved search profiles (filters)
CREATE TABLE IF NOT EXISTS search_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    keywords TEXT NOT NULL,        -- comma-separated, e.g. "backend,python,node"
    location_filter TEXT,          -- e.g. "Haifa" or NULL for any
    experience_filter TEXT,        -- e.g. "student,junior"
    is_active INTEGER DEFAULT 1
);

-- Which (job, profile) matches already triggered a notification — avoids duplicate alerts
CREATE TABLE IF NOT EXISTS notifications_sent (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_snapshot_id INTEGER NOT NULL REFERENCES job_snapshots(id),
    profile_id INTEGER NOT NULL REFERENCES search_profiles(id),
    sent_at TEXT NOT NULL,
    UNIQUE(job_snapshot_id, profile_id)
);
