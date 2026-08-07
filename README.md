# Job Tracker — Company Career Page Watcher

Watches company career pages directly (no LinkedIn, no delay), diffs against the
last known state, and serves a local web UI for filtering the results and
tracking which jobs you've applied to.

Nine adapters: **Amazon**, **Apple**, **Google**, **Mobileye**, **Elbit Systems**,
**IBM**, **NVIDIA** (Eightfold), **Dell** (Oracle HCM) and **Comeet**.

## Quick start

```bash
npm install
node server/seed.js                 # creates jobtracker.db with Amazon Israel
node server/main.js                 # one check cycle — collects jobs
node server/web/server.js           # then open http://localhost:3000
```

Add more companies without writing code:

```bash
node tools/add-company.js                                    # what's available
node tools/add-company.js --name "Mobileye" --type mobileye
node tools/add-company.js --name "Google Israel" --type google --location "Telavivhaifa Israel"
```

## Layout

```
server/          Node only — never reaches the browser
  adapters/      one file per career platform, self-registering
  domain/        pure rules: matcher, vocabularies, locations
  data/          SQL only, one file per table group (+ schema.sql)
  services/      business rules — the layer that combines things
  web/           HTTP: server, routes, middleware (static files, auth)
  main.js        run one check cycle
client/          browser only — never require()s anything
  index.html     job search     tracker.html   applications
  login.html     shown only when auth is configured
  css/ js/
tools/           developer scripts
tests/           node:test — no network, no DB
```

Dependencies point one way: `web -> services -> data -> domain`. `domain/`
imports nothing from the project; nothing imports `web/`. Server and client meet
at the JSON API and nowhere else.

## How it works

```
watched_companies → adapter.getCurrentJobs() → diff vs job_snapshots → matcher → UI
```

Each company row has an `adapter_type`. Nothing outside `server/adapters/` knows
how a given site is scraped — it calls `getCurrentJobs()` and gets a clean list
of `RawJob`. Supporting a new platform is one new file; nothing else changes.

Design decisions and their trade-offs: **ARCHITECTURE.md**.

The search page is paginated (20 jobs/page) — `GET /api/jobs` returns
`{ jobs, page, pageSize, totalMatching, totalPages }`, not a raw array. The
whole filter state, page included, lives in the URL, so a search result is
bookmarkable and survives a refresh.

## Adding a company whose platform has no adapter

```bash
node tools/probe.js "<url>"     # is there a JSON endpoint behind the page?
node tools/probe-all.js         # probe every pending company at once
node tools/sniff.js elbit       # for SPAs: real browser, captures the XHRs
```

`probe.js` prints the field names of the first job it finds, which is exactly
what a new adapter's mapping needs. `sniff.js` needs Playwright:

```bash
npm install --save-dev playwright && npx playwright install chromium
```

Still open: Microsoft, and Rafael — which sits behind Reblaze bot protection, so
use their email job alerts rather than scraping it.

## Running it beyond this machine

The server has no login on localhost, on purpose. To reach it from a phone:

```bash
node tools/set-password.js "a long password"   # prints two lines for .env
HOST=0.0.0.0 JT_BEHIND_HTTPS=1 node server/web/server.js
```

Put a TLS terminator in front (Fly, Railway, Caddy, or a Cloudflare Tunnel).
Don't do TLS inside Node. Details in `server/web/middleware/auth.js`.

## Not built yet

- Notifications — matches are printed to the console; the outbox design is in
  ARCHITECTURE.md §4.5
- Scheduling — one manual run, no cron yet
- The sanity gate (§4.2) and closure detection (§4.3)
- `ComeetAdapter` has never been checked against a live response
