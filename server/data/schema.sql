-- Accounts. Everything in this file is either shared by every account
-- (companies, job snapshots) or owned by exactly one (applications, profiles).
-- server/data/tenancy.js says which is which, and enforces it.
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,    -- stored lowercased, see data/users.js
    password_hash TEXT NOT NULL,   -- self-describing "scrypt$N$r$p$salt$hash" — see web/middleware/auth.js
    created_at TEXT NOT NULL,
    -- Bumped whenever a password is reset, so every session cookie signed
    -- before that moment stops verifying. See web/middleware/auth.js and
    -- data/passwordResets.js.
    session_epoch INTEGER NOT NULL DEFAULT 0,
    -- NULL until the registration confirmation link is clicked. Never blocks
    -- sign-in or use of the site — see data/emailConfirmations.js and
    -- docs/ROADMAP.md for why not (yet).
    email_verified_at TEXT
);

-- A password-reset request in progress. The raw token is never stored, only
-- a SHA-256 hash of it — a leaked row must not hand over a working reset
-- link the way a leaked password hash at least requires cracking first.
-- One hour, single use: see server/data/passwordResets.js.
CREATE TABLE IF NOT EXISTS password_resets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    token_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT,               -- NULL until used
    created_at TEXT NOT NULL
);

-- Same shape as password_resets, different intent: proving a registered
-- address is real rather than proving the account owner forgot a password.
-- Kept as its own table rather than a shared one with a "purpose" column so a
-- reset token can never be replayed to confirm an address or vice versa.
CREATE TABLE IF NOT EXISTS email_confirmations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    token_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT,
    created_at TEXT NOT NULL
);

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
    -- adapters (see server/domain/vocabulary.js) so "Full time" and "full-time"
    -- don't become two separate options in a dropdown.
    employment_type TEXT,          -- full-time | part-time | contract | temporary | internship
    experience_level TEXT,         -- intern | entry | mid | senior
    department TEXT,               -- source's own wording, e.g. "Algorithms"
    posted_at TEXT,                -- source's own wording, not parsed to a date
    UNIQUE(company_id, external_id)
);

-- An account's application pipeline. Absent means untouched. Deliberately
-- separate from job_snapshots: a scrape rewrites job rows, and someone's own
-- notes must never be collateral damage.
CREATE TABLE IF NOT EXISTS applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    job_snapshot_id INTEGER NOT NULL REFERENCES job_snapshots(id),
    status TEXT NOT NULL DEFAULT 'saved',  -- saved | applied | interviewing | offer | rejected
    notes TEXT,
    applied_at TEXT,
    updated_at TEXT NOT NULL,
    -- One row per (account, job): two people may track the same posting, and
    -- each keeps their own status and notes.
    UNIQUE(user_id, job_snapshot_id)
);

-- An account's saved search profiles (filters)
CREATE TABLE IF NOT EXISTS search_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
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
