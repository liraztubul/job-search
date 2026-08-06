# Job Tracker

Watches company career pages, diffs against the last known state, matches new
postings against saved search profiles, and serves a local web UI for browsing
them and tracking applications.

Design, decisions and build phases: **ARCHITECTURE.md**. Read it before making
structural changes — it explains why things are split the way they are.

## Layout

```
server/                     everything Node — never shipped to the browser
  adapters/                 one file per career platform + self-registering index
  domain/                   pure rules: no database, no network, no HTTP
    matcher.js              does a job fit a saved profile?
    vocabulary.js           closed sets for employment type / experience level
    locations.js            canonical city names across Hebrew and English
    applicationStatus.js    saved | applied | interviewing | offer | rejected
  data/                     SQL and nothing else — one file per table group
    connection.js           the single db handle + column migrations
    companies.js  profiles.js  jobs.js  applications.js  notifications.js
    index.js                one import point for the whole layer
    schema.sql
  services/                 business rules; the only layer that combines things
    scrapeService.js        one check cycle
    jobSearchService.js     query string -> repository call
    applicationService.js   what a valid application update looks like
  web/                      HTTP only — no SQL, no rules
    server.js               wiring: /api/* -> routes, everything else -> client/
    http.js                 sendJson / readJson
    routes/index.js         the route table
    middleware/
      staticFiles.js        serves client/, refuses path traversal
      auth.js               single-user login, off unless configured
  main.js                   entry point for one cycle
  seed.js
client/                     everything the browser gets — never requires Node
  index.html                job search
  tracker.html              application dashboard
  login.html                only reachable when auth is configured
  css/styles.css            shared by all pages
  js/                       ui.js (shared) + search.js + tracker.js
tools/                      developer scripts, not part of the running system
tests/                      node:test — no network, no DB
```

Dependencies point one way and never back:

```
web  ->  services  ->  data  ->  domain
                   \->  domain
adapters  ->  domain
```

`domain/` imports nothing from the project. `data/` may import `domain/`. Nothing
imports `web/`. If a file needs to reach *up* a level, it's in the wrong layer.

The other rule: `server/` may never import from `client/`, and `client/` may
never `require()` anything. They meet at the JSON API and nowhere else.

## Protocols

Plain HTTP request/response. The scrape runs on a schedule and the page is read
rather than watched, so there is nothing to push — WebSockets would add a
persistent connection to deliver news a refresh already delivers. If live
updates are ever wanted, use Server-Sent Events before WebSockets.

No TLS in Node. Locally the server binds to 127.0.0.1 and never leaves the
machine. Hosted, terminate HTTPS at the platform (Fly, Railway, Caddy,
Cloudflare Tunnel) and set `JT_BEHIND_HTTPS=1` so the session cookie is Secure.

## Accounts

Off by default. Set `JT_SESSION_SECRET` and `/api/*` starts requiring a signed
cookie; registration and login open up. Accounts live in the `users` table,
`node:crypto` only (scrypt + HMAC), no dependency.

With no secret set, every request runs as account 1 — so localhost stays
login-free while still going through the same user-scoped queries as production,
rather than a second untested path.

**Personal data is scoped by `requireUser`, not by discipline.** Every repository
function touching `applications` / `search_profiles` takes `userId` first and
throws without it; `tests/tenancy.test.js` proves it. See ADR-007.

Missing before strangers use this: email verification, password reset, login
rate limiting, privacy policy.

## Commands

```bash
npm install
npm test                          # node --test — fast, no network, no DB
node server/seed.js               # one-time: creates jobtracker.db
node server/main.js               # one full check cycle
node server/web/server.js         # web UI at http://localhost:3000
node tools/set-password.js "…"    # prints JT_SESSION_SECRET for .env

node tools/add-company.js         # list adapters + watched companies
node tools/add-company.js --name "Amazon Israel" --type amazon --country ISR
node tools/doctor.js               # why is a job not showing up?
node tools/add-job.js --file rafael --title "…" --url "…"   # blocked companies
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

`npm test` is the green light for `matcher.js`, `normalize.js` and the parsers.
For adapter work the green light is `node server/main.js` printing **real job
titles from a real company** — not "no errors thrown".
For UI work, serve it and open the page; the tests don't touch the DOM.

When an adapter is wrong, print the raw response before editing the mapping.
Guessing at field names is the main way this project wastes an hour.

## Architecture rules

- **Adapters** (`server/adapters/`) only fetch + normalize to `RawJob`.
  No DB access, no notifications, no filtering. One file per *platform* —
  not per company.
- **Adapters self-register.** A `*Adapter.js` file exporting a class with
  `static type` and `static describe` is picked up automatically by
  `server/adapters/index.js`. Never add a `switch` over adapter types, and never
  import a specific adapter in `main.js`.
- **Adding a company requires no code** when its platform already has an
  adapter — `node tools/add-company.js` writes the DB row.
- **All SQL lives in `server/data/`.** Nowhere else — not in services, not in
  routes, not in tools.
- **`domain/` is pure.** No `require` of data, services or web from inside it.
- **Never send a notification inline.** Insert a row into `notification_queue`
  and let a sender drain it. See ARCHITECTURE.md §4.5 for why.
- **Filterable fields are normalized at the adapter boundary** into the closed
  vocabularies in `server/domain/vocabulary.js`. A value outside them makes the
  job invisible in the UI filter. Unknown input must become `null`, never a guess.
- **Never query personal data without a user id.** Repository functions for
  `applications` / `search_profiles` take `userId` first and call `requireUser`.
  A forgotten `WHERE user_id` is the one bug class that leaks between accounts.
- `main.js` orchestrates and holds no business logic.

## Gotchas

- `better-sqlite3` is **synchronous**. Don't `await` db calls.
- It's also a **native module** — `node_modules` is not portable between
  Windows and Linux. Install on the machine that runs it.
- Development is on **Windows**. Don't assume bash-only shell syntax.
- Never commit `.env` or `jobtracker.db` (it holds personal search profiles).
- A scrape returning `[]` usually means the scraper broke, not that the company
  closed every role. Never act on an empty result as if it were real.
- The pages must be opened **through the server**, not by double-clicking the
  HTML file — `file://` has no API to call.

## Current state

Working end to end for Amazon, Google, Mobileye, Elbit and NVIDIA. Notifications are still
console-only — `notification_queue` from ARCHITECTURE.md §4.5 is not built yet.
`ComeetAdapter` remains unverified against a live response.
Nine adapters registered: amazon, apple, comeet, eightfold, elbit, google, ibm,
mobileye, oracle-hcm.
Rafael is behind Reblaze bot protection, and AllJobs (checked as an indirect
route to the same postings) is behind hCaptcha. Both are security products
saying no. Rafael is tracked through the `manual` adapter instead —
`node tools/add-job.js`. Don't automate either site.
Checked AllJobs.co.il as an indirect route to Rafael's postings too: its guest
search is also bot-gated (hCaptcha + Reblaze-family bot management via
Perfdrive, loaded by its own `ShowSearchResultGuestBlocker.js`). Not a way in
either — don't re-try it hoping it's just a robots.txt courtesy block.
