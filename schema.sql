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
    UNIQUE(company_id, external_id)
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
