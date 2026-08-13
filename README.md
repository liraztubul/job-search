# JobTrail — Company Career Page Watcher

**Live:** [jobtrail.fly.dev](https://jobtrail.fly.dev)

Watches company career pages directly (no LinkedIn, no delay), diffs against the
last known state, matches new postings against saved search profiles, and
serves a web UI for filtering the results and tracking which jobs you've
applied to.

Fifteen adapters covering Amazon, Apple, Google, Mobileye, Elbit Systems, IBM,
NVIDIA, Check Point and more — see [Layout](#layout) for how a new one gets
added.

## What this demonstrates

- **The adapter registry** (`server/adapters/`): a new career-site platform is
  one self-registering file, and `tools/add-company.js` can then add any
  company on that platform with no code at all — see ADR-003.
- **The tenancy guard** (`server/data/tenancy.js`): every query touching a
  personal table takes a user id first and throws without one, so a forgotten
  `WHERE user_id` is a crash in development, not a leak in production — see
  ADR-007.
- **The pagination fix and the bug it uncovered**: adding real paging to the
  job search surfaced a `LEFT JOIN` missing its own tenancy clause — one
  account's application status was rendering on another account's screen. Both
  are covered by `tests/jobs.test.js`.
- **Dead ends are written down, not hidden** — see `CLAUDE.md`'s running log of
  companies that turned out to be bot-protected, tokenless, or simply not
  worth automating, and why.

## Screenshots

![Job search page showing filterable results for open positions](docs/search.png)
![Application tracker dashboard showing saved jobs by status](docs/tracker.png)

*(Not yet in the repo — see "Adding the screenshots" below.)*

## Quick start

```bash
npm install
node server/seed.js                 # creates jobtrail.db with Amazon Israel
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

Still open: Microsoft, Meta, SAP and a handful of others documented as
in-progress or dead ends in `CLAUDE.md`. Rafael sits behind Reblaze bot
protection and is tracked through the `manual` adapter instead
(`tools/add-job.js`) rather than scraped.

## Accounts, and running it beyond this machine

The server has no login on localhost, on purpose — see
`server/web/middleware/auth.js`. To reach it from a phone:

```bash
node tools/set-password.js "a long password"   # prints two lines for .env
HOST=0.0.0.0 JT_BEHIND_HTTPS=1 node server/web/server.js
```

Put a TLS terminator in front (Fly, Railway, Caddy, or a Cloudflare Tunnel).
Don't do TLS inside Node.

Once accounts are on, two more things matter for a deployment strangers can
reach:

- **Login and registration are rate-limited** per IP and per submitted
  account, independently — `server/web/middleware/rateLimit.js`. On Fly, set
  `JT_TRUST_PROXY=1` (already in `fly.toml`) so the limiter reads the real
  visitor address from `Fly-Client-IP` instead of Fly's own proxy address.
- **Passwords are hashed with `crypto.scrypt`, asynchronously**, so hashing
  doesn't freeze the event loop for every other visitor while it runs — see
  `server/web/middleware/auth.js`. Measured with `node tools/bench-auth.js`
  (developer machine: Windows, 13th Gen Intel Core i7-1355U, 12 logical CPUs —
  not the 512MB Fly VM this deploys to):

  | | single hash | max event-loop delay, 10 concurrent logins |
  |---|---|---|
  | before (sync, N=2^14) | ~30ms | ~290ms |
  | after (async, N=2^16) | ~110ms | ~19ms |

  Re-run the benchmark on the actual deployed machine size before trusting
  these numbers in production.

## Not built yet

- Notifications — matches are printed to the console; the outbox design is in
  ARCHITECTURE.md §4.5
- Scheduling — one manual run, no cron yet
- The sanity gate (§4.2) and closure detection (§4.3)
- `ComeetAdapter` has never been checked against a live response
- Email verification, password reset — see ARCHITECTURE.md's ADRs on why SMS
  codes were rejected and why email codes are waiting on a custom domain

See `ROADMAP.md` for the fuller list of known limitations and their intended
fixes.

## Adding the screenshots

The two images above aren't in the repo yet. To add them:

1. Run the app locally (`node server/web/server.js`) with some real job data
   (`node server/main.js` first) and an application or two tracked.
2. Save a screenshot of the job search page (`index.html`) as `docs/search.png`.
3. Save a screenshot of the application tracker (`tracker.html`) as
   `docs/tracker.png`.

The `docs/` folder and the `![...]` references above are already in place —
dropping the two files in is the only step left.
