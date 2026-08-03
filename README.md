# Job Tracker — Company Career Page Watcher

Monitors specific company career pages directly (no LinkedIn, no delay), diffs
against the last known state, matches new postings against saved search
profiles, and (eventually) sends a notification.

## How it works

```
watched_companies --> adapter.getCurrentJobs() --> diff vs job_snapshots --> matcher --> notify
```

Each company has an `adapter_type` (e.g. `comeet`). The rest of the code never
needs to know how a specific site is scraped — it just calls
`adapter.getCurrentJobs()` and gets back a clean list. Adding a new company
platform later = adding one new file in `src/adapters/`, nothing else changes.

## Structure

```
schema.sql              SQLite schema (companies, job snapshots, profiles, notifications)
src/adapters/JobSource.js    the interface every adapter implements
src/adapters/comeetAdapter.js   works for any company using Comeet's career platform
src/db.js               all DB reads/writes
src/matcher.js           does a job fit a saved search profile?
src/main.js              one full check cycle — run this on a schedule (cron)
src/seed.js              inserts one example company + one search profile
```

## Running it

```bash
npm install
node src/seed.js     # one-time: creates the DB + inserts example data
node src/main.js     # runs one check cycle
```

Right now `seed.js` inserts a placeholder company with `companyUid: 'REPLACE_ME'`
— `main.js` will fail on it until you swap in a real one.

## Your next step (this is the part I can't do without you)

I don't have a browser, so I can't inspect Rafael/Elbit's actual career page
myself. To find out what platform they run on and get real data flowing:

1. Open the company's career page in Chrome.
2. Press F12 → **Network** tab.
3. Refresh the page, then filter by `job` or `position` or `career`.
4. Click any request of type **Fetch/XHR** (not JS/CSS/image) and check the
   **Response** tab for JSON with job titles in it.
5. Send me that URL (and a snippet of the JSON shape) — I'll write the adapter
   for whatever platform it turns out to be (Comeet, Greenhouse, SuccessFactors,
   or fully custom).

If it turns out to be a fully custom system (common for large Israeli
companies like Rafael/Elbit), the adapter will do real HTML parsing instead of
calling a clean JSON endpoint — more fragile, but still very doable; we'll
just need to look at the actual page structure together.

## Not built yet (on purpose — MVP first)

- Real notification channel (Telegram bot / email) — currently just logs to console
- Scheduling (cron / node-cron) — currently one manual run
- Frontend to manage companies/profiles — currently seeded directly in DB
- Fuzzy/embedding-based matching — currently plain keyword substring match
