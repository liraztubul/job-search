# Job Tracker

Watches company career pages, diffs against the last known state, matches new
postings against saved search profiles, notifies via Telegram + email.

Design, decisions and build phases: **ARCHITECTURE.md**. Read it before making
structural changes — it explains why things are split the way they are.

## Commands

```bash
npm install
npm test                          # node --test — fast, no network, no DB
node src/seed.js                  # one-time: creates jobtracker.db
node src/main.js                  # one full check cycle
node src/server.js                # web UI: / = search, /tracker.html = application tracker

node tools/add-company.js         # list adapters + watched companies
node tools/add-company.js --name "Amazon Israel" --type amazon --country ISR
node tools/probe.js "<url>"       # inspect an endpoint before writing an adapter
node tools/probe-all.js           # probe every company that has no adapter yet
node tools/probe-all.js elbit     # ...or just one
node tools/sniff.js elbit         # for SPAs: real browser, captures the XHRs
```

`sniff.js` needs Playwright (dev-only, not required to run the tracker):

```bash
npm install --save-dev playwright && npx playwright install chromium
```

Only dependency is `better-sqlite3`. `fetch` is Node's built-in (Node 18+).

## Verifying a change

`npm test` is the green light for anything in `matcher.js`.
For adapter work the green light is `node src/main.js` printing **real job
titles from a real company** — not "no errors thrown".

When an adapter is wrong, print the raw response before editing the mapping.
Guessing at field names is the main way this project wastes an hour.

## Architecture rules

- **Adapters** (`src/adapters/`) only fetch + normalize to `RawJob`.
  No DB access, no notifications, no filtering. One file per *platform* —
  not per company.
- **Adapters self-register.** A `*Adapter.js` file exporting a class with
  `static type` and `static describe` is picked up automatically by
  `src/adapters/index.js`. Never add a `switch` over adapter types, and never
  import a specific adapter in `main.js`.
- **Adding a company requires no code** when its platform already has an
  adapter — `node tools/add-company.js` writes the DB row.
- **All DB access goes through `src/db.js`.** No raw SQL anywhere else.
- **Never send a notification inline.** Insert a row into `notification_queue`
  and let a sender drain it. See ARCHITECTURE.md §4.5 for why.
- **Filterable fields are normalized at the adapter boundary** into the closed
  vocabularies in `src/adapters/normalize.js`. A value outside them makes the
  job invisible in the UI filter. Unknown input must become `null`, never a guess.
- **`server.js` has no auth and binds to 127.0.0.1.** Single user, local only.
  Don't add login; do reconsider if this is ever hosted.
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
