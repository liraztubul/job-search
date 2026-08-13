# JobTrail

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
node server/seed.js               # one-time: creates jobtrail.db
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
- Never commit `.env` or `jobtrail.db` (it holds personal search profiles).
- A scrape returning `[]` usually means the scraper broke, not that the company
  closed every role. Never act on an empty result as if it were real.
- The pages must be opened **through the server**, not by double-clicking the
  HTML file — `file://` has no API to call.

## Current state

Working end to end for Amazon, Google, Mobileye, Elbit and NVIDIA. Notifications are still
console-only — `notification_queue` from ARCHITECTURE.md §4.5 is not built yet.
Fifteen adapters registered: amazon, apple, ashby, checkpoint, comeet, eightfold,
elbit, google, greenhouse, ibm, mobileye, oracle-hcm, smartrecruiters, workday,
wp-careers.
Ashby and Workday are real third-party platforms (Ashby's public posting API
needs no auth at all; Workday needs a two-step facet lookup to filter by
country — see workdayAdapter.js). checkpoint is bespoke to Check Point's own
Solr-backed PHP site.
Qualcomm is another Eightfold tenant (careers.qualcomm.com, same shape as
Microsoft/NVIDIA). Intel is on Workday (intel.wd1.myworkdayjobs.com).
monday.com is on Ashby (board name is "monday.com", not the shorter "monday"
their own jobs.ashbyhq.com page uses — probe before assuming).
Rafael is behind Reblaze bot protection, and AllJobs (checked as an indirect
route to the same postings) is behind hCaptcha. Both are security products
saying no. Rafael is tracked through the `manual` adapter instead —
`node tools/add-job.js`. Don't automate either site.
Wix is a dead end too, but not from bot protection: careers.wix.com's job
data only exists behind a per-page-load signed session token (Wix's own
"wixcode-pub" instance JWT), with no postings in the server-rendered HTML and
no public API. Getting it would mean running a real browser at scrape time,
which breaks the project's "only dependency is better-sqlite3" rule. Not
added.
CyberArk was acquired by Palo Alto Networks since this file was last
updated — cyberark.com/careers now redirects straight to a PANW marketing
page. Tracked as "Palo Alto Networks Israel" (Workday, same tenant as
everyone else at PANW) — there's no way to isolate just the former-CyberArk
roles, but their titles/locations still say "CyberArk" (e.g. "(EPM-Idira)",
"Office - Israel - CyberArk Petach Tikva"), so they're easy to spot in the feed.
Checked AllJobs.co.il as an indirect route to Rafael's postings too: its guest
search is also bot-gated (hCaptcha + Reblaze-family bot management via
Perfdrive, loaded by its own `ShowSearchResultGuestBlocker.js`). Not a way in
either — don't re-try it hoping it's just a robots.txt courtesy block.

**Pagination (see ROADMAP.md) is done.** `queryJobs`/`countJobs`
in `server/data/jobs.js` share one `buildJobFilters()` so they can't drift
apart, both take `userId` first, and `ORDER BY` always ends in `, j.id DESC` —
`first_seen_at` alone isn't unique (673 Elbit rows share one timestamp) and
without the tiebreaker a job can land on two pages or none. `GET /api/jobs`
now returns `{ jobs, page, pageSize, totalMatching, totalPages }`; the old
silent 500-row cap is gone. The client keeps the full filter state (including
page) in the URL via `history.replaceState`, so a result set is bookmarkable
and survives a refresh; changing a filter resets to page 1, paging does not.
`page` is sanitized (a real integer, minimum 1) but never *substituted* — a
page past the end of the real result set answers honestly with `jobs: []`
and the true `totalMatching`/`totalPages`, not with a different page's rows
wearing the requested page's number. The client shows a distinct "nothing on
this page — N total matches, here's page 1" state for that case, separate
from "nothing matches this filter at all".

**Found and fixed while touching this:** `queryJobs`'s `LEFT JOIN applications`
had no `a.user_id = @owner` clause — every account's job list was joining in
*whichever* account's application status happened to match, a real cross-
account leak of exactly the kind ADR-007 exists to prevent. `tests/jobs.test.js`
now covers it directly, and `tests/tenancy.test.js` still only checks
`server/data/applications.js`'s own exports — it does not (yet) catch a future
function elsewhere joining a personal table without scoping it.

**New for tests that need real rows:** `server/data/connection.js` reads
`JT_DB_PATH` and opens that instead of `jobtrail.db` when it's set. Set it
to `:memory:` at the very top of a test file, before requiring anything in
`server/data/` — `node --test` runs each file in its own process, so this
never touches your real data or another test file's connection. See
`tests/jobs.test.js`.

**Fixed a real data-loss bug (2026-08-07):** with `JT_SESSION_SECRET` unset
and zero registered users, `backfillOwnership()` had nowhere to adopt
pre-existing `applications`/`search_profiles` rows into (`user_id` stayed
NULL), and — since registration itself is blocked while auth is off — there
was no way to create an account to adopt them into either. Saved application
statuses would silently vanish from the tracker with no error anywhere. Fixed
by having `backfillOwnership()` create a local placeholder account
(`local@localhost`, an unguessable non-`salt:hash` password that can never be
used to log in) when orphans exist and no user does, so "every request runs
as account 1" refers to a real row. Self-heals on next server start; no
manual step needed.

**Location filter is multi-select (2026-08-07):** `?location=` is now
repeatable (`?location=Tel+Aviv&location=Haifa`), OR'd together — see
`buildJobFilters` in `server/data/jobs.js`. The client renders it as
checkboxes in a `<details>` disclosure (`fillLocationMultiselect` in
search.js), not a `<select multiple>` — nobody knows ctrl/cmd-click selects
more than one, and it can't show a per-option count either.

**Greenhouse adapter added (2026-08-11).** Public, unauthenticated, genuinely
meant for outside use: `GET https://boards-api.greenhouse.io/v1/boards/{token}/jobs`.
The board token is often but not always the company's lowercased name — Wiz's
is `wizinc`, Playtika's is `playtikaltd`. Found by noticing a company's own
"custom" careers page proxies Greenhouse underneath: its job URLs carry a
`?gh_jid=` param (see Riskified, Wiz). With no `location` configured it
filters using the same Israeli-location whitelist as the rest of the site
(`server/domain/locations.js`) rather than requiring per-company guessing.

**Workday's facet shape is not standard across tenants — confirmed a third
variant (2026-08-11).** Intel/Palo Alto Networks nest it under
`locationMainGroup.locations` with no country of its own (pattern-match the
city descriptor). Marvell exposes a flat top-level `Country` facet with exact
country names. HP's version of the same idea is named `Location_Country`.
`resolveLocationFacet()` in `workdayAdapter.js` tries a facet matching
`/(^|_)country$/i` first and falls back to the nested shape — test each new
tenant against both before assuming a location filter that returns nothing
means the tenant has no Israel jobs (Marvell's *did* exist, just outside the
old code's only-checked shape).

**Two dead ends found while adding this batch of companies:**
- **Israel Aerospace Industries** is behind Reblaze too (same signature as
  Rafael — `kramericaindustries.ac_v2.lib.js`, `window.rbzns`). Not added.
- Guessing Greenhouse board tokens is not proof of identity: `iai` returns
  200 with 5 real jobs, but they're a small unrelated UK company, not Israel
  Aerospace Industries — always check `job.location`/titles look plausible
  for the actual company before trusting a token guess that happens to 200.

**Snyk and Broadcom are both registered but genuinely at 0 Israel jobs right
now** — verified two ways each (facet lookup finds no Israel entry among
their real location lists, and a free-text "Israel" search independently
turns up ~nothing). The adapter's own `getCurrentJobs()` throws on a
configured-country-but-zero-matches result on purpose, as a signal to check
the facet logic before trusting it — already checked here; a future scrape
failure for these two isn't a new bug unless the facet lists themselves
change shape again.

**Mellanox needs no separate entry** — `mellanox.com/careers` redirects
straight to `nvidia.com/.../careers`; it's fully folded into NVIDIA's own
Workday... no, Eightfold tenant, already covered by "NVIDIA Israel".

**Still unresolved from the 2026-08-11 batch** (each needs more individual
digging than a quick probe gave): Meta (career site runs on an internal,
session-bound GraphQL API — CSRF-shaped tokens in every request, not a
public endpoint to reverse-engineer), Zoom, Fiverr, Deel, Cisco (has a
`/widgets` endpoint, 404s on the params tried so far), Verint, SAP (its
`jobs.sap.com/services/jobs/...` endpoints exist but need a request shape
not yet found — SuccessFactors, not Workday), Outbrain (now merged with
Teads — `outbrain.com/careers` redirects to `teads.com/teads-careers/`),
ironSource (merged into Unity — `is.com/careers` redirects to
`unity.com/careers`, no Israel/ironSource-specific filter found yet).

**Two new platform adapters added for the 2026-08-11 second batch (Medtronic,
Syneron/Candela, Panasonic Avionics, Biosense Webster, Lumenis, EZchip, Opgal,
Matas Systems, Keter Plastic, Strauss-Elite Group, Klil, Plus500):**

- **`smartrecruiters`** — SmartRecruiters' public postings API
  (`api.smartrecruiters.com/v1/companies/{id}/postings`), genuinely open, no
  auth. Verified against Syneron-Candela. The list payload has no clickable
  apply link of its own (`ref` is the API resource, not a page) but
  `jobs.smartrecruiters.com/{company}/{id}` resolves with no slug needed, so
  building it doesn't cost a second request per job.
- **`wp-careers`** — WordPress sites that publish jobs as a custom post type
  with a location taxonomy, fetched via `_embed=true` so the taxonomy term
  name comes back inline instead of a bare numeric id. Verified against
  Keter's dedicated Israel careers subdomain (`careers.ketergroup.com`, post
  type `careers`, location taxonomy `job_locall`). This is a generic REST
  shape, not a named platform — expect the next WP-based company to spell
  its own post type and taxonomy slug differently; check
  `/wp-json/wp/v2/types` and `/wp-json/wp/v2/taxonomies` first. Keter's own
  feed includes one evergreen "no open role fits? send us your CV anyway"
  post mixed in with real openings — harmless noise, not worth a heuristic
  to filter out since it still carries a real location term.

**`ComeetAdapter` is now verified — and was actually broken as first written.**
Confirmed live against Lumenis and Plus500 on 2026-08-11. Two real bugs fixed:
the endpoint 400s ("Token is missing") without a per-company `?token=` query
param that isn't the company uid — it's a second value that has to be dug out
of the careers page's own bundled JS (next to `company_uid` in Lumenis's
inline page config; inside a `getCareers()` function in Plus500's
`js/general.js` as `comeetToken`). And `location` is a structured object
(`city`, `country` as an ISO-2 code, no single display string worth reading)
not the flat string the original mapping assumed. A multi-office posting also
comes back as one array entry per office, uid suffixed per location
(`"C5.F67-51.308"`), not one job with a location list — each entry is treated
as its own RawJob, same as Greenhouse's multi-office shape.

**Biosense Webster is tracked as "Johnson & Johnson Israel"**, same pattern as
CyberArk under Palo Alto Networks: J&J is on Workday (`jj.wd5.myworkdayjobs.com`,
tenant `jj`, site `JJ`), and there's no facet to isolate just the Biosense
Webster brand within J&J's combined feed — but the Yokneam location alone is
the tell (Biosense Webster Israel's real R&D site), same trick as CyberArk's
"(EPM-Idira)" titles under PANW.

**Medtronic is on Workday** too (`medtronic.wd1.myworkdayjobs.com`, tenant
`medtronic`, site `MedtronicCareers`) — nested `locationMainGroup` facet shape
like Intel, except the descriptor order is reversed ("Herzliya, Tel Aviv,
Israel", country last instead of first). `descriptorMatchesCountry()` already
handles this since it checks every segment, not just the first — no code
change needed, just a config that happened to prove the reversed-order case.

**EZchip needs no separate entry** — acquired by Mellanox in 2016, and Mellanox
is itself folded into NVIDIA's own careers site (see the existing Mellanox
note above). Following that chain twice over still lands on "NVIDIA Israel".

**Syneron-Candela is registered but shows 0 jobs right now** — same
"adapter throws on purpose" pattern as Snyk/Broadcom (see above): the company
has exactly one open posting worldwide at verification time, in the US, none
in Israel. Not a bug; will populate automatically if that changes.

**Four dead ends found in this batch, each for a different reason:**
- **Opgal** (an Elbit Systems company, Karmiel) — its `/about/careers` page
  renders to almost no content and sniffing found no XHR job API at all.
  Either genuinely zero open positions right now or the real listing lives
  somewhere not linked from that page. Not added; worth a fresh probe later
  rather than assuming it's permanently empty.
- **Klil** (Karmiel, aluminum window/door systems) — its `/קריירה/` page is
  pure culture-and-testimonials marketing content; no ATS embed, no XHR job
  API, no job-shaped markup anywhere in the rendered DOM. Not added.
- **Strauss-Elite Group** — has no self-hosted careers page at all; every
  Israeli job board (Drushim, JobMaster, AllJobs) lists Strauss postings
  independently, but the company itself doesn't run a feed to read from.
  AllJobs specifically is already the known hCaptcha+Reblaze dead end from
  the Rafael investigation — not re-tried here. Not added.
- **Panasonic Avionics** — its careers site (iCIMS-based) never mentions
  Israel anywhere, and its listed global offices are Toulouse, Hamburg,
  London, Dallas, Dubai and Singapore — no Israel R&D/engineering presence to
  filter for in the first place, unlike Snyk/Broadcom which are large
  companies plausibly one posting away from showing up. Not added.

**"Matas Systems" could not be identified.** No company by that name turned
up in web search, Hebrew or English — closest matches were an unrelated
Danish retail chain (Matas A/S) and an unrelated Dutch electronics company
(Matas Electronics B.V.). Needs the user to confirm what company this refers
to before it can be investigated.
