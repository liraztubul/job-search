# Job Tracker

Watches company career pages, diffs against the last known state, matches new
postings against saved search profiles, notifies via Telegram + email.

Design, decisions and build phases: **ARCHITECTURE.md**. Read it before making
structural changes — it explains why things are split the way they are.

## Commands

```bash
npm install
npm test             # node --test — fast, no network, no DB
node src/seed.js     # one-time: creates jobtracker.db + example data
node src/main.js     # one full check cycle
```

## Verifying a change

`npm test` is the green light for anything in `matcher.js`.
For adapter work the green light is `node src/main.js` printing **real job
titles from a real company** — not "no errors thrown".

When an adapter is wrong, print the raw response before editing the mapping.
Guessing at field names is the main way this project wastes an hour.

## Architecture rules

- **Adapters** (`src/adapters/`) only fetch + normalize to `RawJob`.
  No DB access, no notifications, no filtering. One file per *platform*
  (Comeet, Greenhouse, Lever) — not per company.
- **All DB access goes through `src/db.js`.** No raw SQL anywhere else.
- **Never send a notification inline.** Insert a row into `notification_queue`
  and let a sender drain it. See ARCHITECTURE.md §4.5 for why.
- `main.js` orchestrates and holds no business logic.

## Gotchas

- `better-sqlite3` is **synchronous**. Don't `await` db calls.
- It's also a **native module** — `node_modules` is not portable between
  Windows and Linux. Install on the machine that runs it.
- Development is on **Windows**. Don't assume bash-only shell syntax.
- Never commit `.env` or `jobtracker.db` (it holds personal search profiles).
- A scrape returning `[]` usually means the scraper broke, not that the company
  closed every role. Never act on an empty result as if it were real.

## Current state

Phase 1 — not yet proven end-to-end. `ComeetAdapter`'s field mapping was written
against documentation, never against a live response. `seed.js` still contains
`companyUid: 'REPLACE_ME'`. Notifications log to console only.
