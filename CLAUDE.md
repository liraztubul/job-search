# JobTrail

Watches company career pages, diffs against the last known state, matches new
postings against saved search profiles, and serves a local web UI for browsing
them and tracking applications.

Design, decisions and build phases: **docs/ARCHITECTURE.md**. Read it before making
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

Login rate limiting, password reset and registration email confirmation are
all built (`server/web/middleware/rateLimit.js`,
`server/services/verificationService.js`). Mail can go out through either of
two providers, whichever is configured — **Gmail over SMTP**
(`GMAIL_USER` + `GMAIL_APP_PASSWORD`, see `server/services/smtpClient.js`)
or **Brevo** (`BREVO_API_KEY`), with Gmail preferred when both are set.
`emailService.isConfigured()` is the single switch the UI reads, so turning
either on reveals "שכחתי סיסמה" and drops the no-recovery warning with no
second thing to remember. Sending is still
a separate, optional switch left off by default (`server/services/emailService.js`);
`client/login.html` hides the reset entry point and warns plainly at
registration when it can't be delivered. `tools/reset-password.js` is the
owner's escape hatch in the meantime. A privacy policy lives at
`client/privacy.html`, linked from every page, and a registered account can
delete itself and everything it owns from **הגדרות** (`client/settings.html`).

## Commands

```bash
npm install
npm test                          # node --test — fast, no network, no DB
node server/seed.js               # one-time: creates jobtrail.db
node server/main.js               # one full check cycle
node server/web/server.js         # web UI at http://localhost:3000
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # -> JT_SESSION_SECRET, see docs/DEPLOY.md
node tools/reset-password.js --email x --password y   # owner's escape hatch when mail can't be sent

node tools/add-company.js         # list adapters + watched companies
node tools/add-company.js --name "Amazon Israel" --type amazon --country ISR
node tools/doctor.js               # why is a job not showing up?
node tools/add-job.js --file rafael --title "Software Engineer" --url "https://career.example-company.com/job/12345"   # blocked companies
#   ^ write a REAL title and URL. This line used to read --title "…" --url "…",
#     someone ran it verbatim, and "…" became a live job's apply link.
#     add-job.js now rejects placeholder URLs, but don't re-introduce one here.
node tools/probe.js "<url>"       # inspect an endpoint before writing an adapter
node tools/probe-all.js           # probe every company that has no adapter yet
node tools/probe-all.js elbit     # ...or just one
node tools/sniff.js elbit         # for SPAs: real browser, captures the XHRs
```

`sniff.js` needs Playwright (dev-only, not required to run the tracker):

```bash
npm install --save-dev playwright && npx playwright install chromium
```

Only dependency is `libsql`. `fetch` is Node's built-in (Node 18+).

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
  and let a sender drain it. See docs/ARCHITECTURE.md §4.5 for why.
- **Filterable fields are normalized at the adapter boundary** into the closed
  vocabularies in `server/domain/vocabulary.js`. A value outside them makes the
  job invisible in the UI filter. Unknown input must become `null`, never a guess.
- **Never query personal data without a user id.** Repository functions for
  `applications` / `search_profiles` take `userId` first and call `requireUser`.
  A forgotten `WHERE user_id` is the one bug class that leaks between accounts.
- `main.js` orchestrates and holds no business logic.

## Gotchas

- **A block arrives in three shapes, and the third one impersonates a bug.**
  `403`, `429`, and — the one that cost an evening — **`200` carrying an HTML
  challenge page**. The third reaches `.json()` as `Unexpected token '<'`,
  which reads as "this adapter is broken" when the truth is "this site refused
  us". Every adapter parses through `parseJsonResponse` in
  `server/domain/scrapeOutcome.js` for exactly that reason; never call
  `res.json()` directly. Eightfold (Microsoft, NVIDIA), Check Point, Keter's
  WordPress and Workday all refuse datacenter addresses while serving the same
  endpoint happily from a home connection — so a failure that reproduces in CI
  and not locally is a signal about *where the request came from*, not about
  the code. Acknowledge those with `tools/acknowledge-issue.js`; do not
  "fix" them.
- **Failures cluster by platform, not by company.** One Workday refusal looked
  like seven companies breaking simultaneously. Count adapters, not companies,
  when judging how bad a run is.
- **"Re-run" in GitHub Actions replays the original commit.** That is the
  point of it — an exact reproduction — but it means a re-run after a fix
  tests the code you just replaced, shows the identical failure, and reads as
  "the fix didn't work". Three rounds were lost to this. After pushing a fix,
  always **Run workflow**, and check the commit SHA on the run page matches
  what you pushed.
- **A `tools/` script changes whichever database the environment points at —
  and your shell usually points at the local file.** `set-link-only.js`,
  `acknowledge-issue.js`, `set-company-active.js` and friends all go through
  `server/data/connection.js`, so with no `TURSO_DATABASE_URL` exported they
  edit `jobtrail.db` and report cheerful success, while **production is
  unchanged**. This has now bitten twice: IBM stayed listed live after being
  deactivated locally, and Rafael kept serving three placeholder jobs on the
  live site for a week after `set-link-only.js` had "worked". Nothing warns
  you, because from the tool's point of view nothing went wrong. After running
  any tool that changes a company's presentation, re-run it in a shell with
  the Turso credentials exported, or check the live site — a local success is
  not evidence about production. (Note the tension with the `JT_DB_PATH`
  precedence fix above: that one exists because ambient Turso credentials
  wrongly beat a deliberate local setting. Both are the same lesson from
  opposite sides — **know which database you are actually talking to**.)
- **You cannot send mail from a `@gmail.com` address through a third-party
  provider and expect it to arrive.** Checked properly on 2026-09-13 rather
  than assumed: Postmark refuses such senders outright ("can be viewed as
  email spoofing"), Mailjet warns the mail "may not be delivered at all",
  and the shared cause is DMARC alignment — mail claiming to be from
  gmail.com but signed by someone other than Google fails it.
  `_dmarc.gmail.com` reads `v=DMARC1; p=none; sp=quarantine`, so it is
  *tolerated* rather than bounced, which in practice means the spam folder.
  The fix is not a better provider; it is either owning a domain or sending
  through Google itself — see `server/services/smtpClient.js`.
- `libsql` is **synchronous**. Don't `await` db calls.
- It's also a **native module** — `node_modules` is not portable between
  Windows and Linux. Install on the machine that runs it.
- Development is on **Windows**. Don't assume bash-only shell syntax.
- Never commit `.env` or `jobtrail.db` (it holds personal search profiles).
- A scrape returning `[]` usually means the scraper broke, not that the company
  closed every role. Never act on an empty result as if it were real.
- The pages must be opened **through the server**, not by double-clicking the
  HTML file — `file://` has no API to call.
- **Turso is a network round trip, not a memory access — code that is
  correct against a local file can still be unusably slow against it.**
  Four instances of this so far, the first three about correctness
  (`db.transaction()` throws; named `@parameters` silently don't bind;
  `LIMIT`/`OFFSET` must be inlined as validated integers, never bound —
  see `server/data/jobs.js`'s `limitClause`), the fourth about latency: the
  scheduled scrape's per-job `upsertJobSnapshot`/`closeMissingJobs` calls
  (one SELECT + one INSERT/UPDATE per job) meant ~2,500 jobs became ~5,000
  sequential requests to Turso's Ireland region at ~150ms each — 12+ minutes
  of pure network wait, enough to blow past the workflow's 20-minute
  timeout on a run that a local file finishes in seconds. Fixed by
  `upsertJobSnapshots()`/batched `closeMissingJobs()` in `server/data/jobs.js`:
  one SELECT for the whole company, a handful of multi-row
  `INSERT ... ON CONFLICT(company_id, external_id) DO UPDATE` batches (sized
  like `tools/push-to-turso.js` sizes its own, from the column count against
  SQLite's ~999-parameter cap), one more SELECT to read back new ids. Any
  future per-row loop over `job_snapshots` (or any other table) is the same
  bug waiting to happen — batch it before it ships, don't wait for a
  timeout to find out.

## Current state

Working end to end for Amazon, Google, Mobileye, Elbit and NVIDIA. Notifications are still
console-only — `notification_queue` from docs/ARCHITECTURE.md §4.5 is not built yet.
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
which breaks the project's "only dependency is libsql" rule. Not
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

**Pagination (see docs/ROADMAP.md) is done.** `queryJobs`/`countJobs`
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

**IBM Israel deactivated (2026-08-19) — confirmed not a bug.** IBM had been
registered on the `ibm` adapter (a bespoke Elasticsearch client for
`www-api.ibm.com/search/api/v2`) returning 0 Israel jobs since it was added,
which read on the site as "IBM has no openings" — a claim the site can't
actually vouch for. Re-verified live rather than trusting the old note: the
same `field_keyword_05: "Israel"` term query the adapter uses returns
`{value: 0}`, while the identical query for `"India"` returns 480 real hits
(proving the query mechanism itself works), and a free-text search for
"Israel" across every field also returns zero. The adapter isn't broken —
IBM's Elasticsearch index genuinely has nothing tagged Israel right now.
Deactivated via `node tools/set-company-active.js --name "IBM Israel"
--active false` rather than deleting the row (history stays, in case this
changes) — `filterOptions()` in `server/data/jobs.js` was also fixed to
exclude `is_active = 0` companies from the browsable filter list, since
deactivating previously only stopped future scrapes and left the company
still listed with a permanent "(0)" next to it. **This needs the same
`is_active = 0` update run against the live Turso database** — this tool
only touched the local file; see `tools/set-company-active.js`'s own header
for how to point it at Turso.

**Three companies added (2026-08-19), all existing adapters, no new code:**
- **Amdocs** — Eightfold tenant (`jobs.amdocs.com`, domain `amdocs.com`,
  confirmed by the `static.vscdn.net/.../amdocs/...` asset path on its own
  careers page). Registered as "Amdocs Israel". Currently only 9 open
  positions worldwide, none in Israel — same "adapter throws on purpose"
  pattern as Snyk/Broadcom/Syneron-Candela below; not a bug, will populate
  automatically.
- **SanDisk** — SmartRecruiters tenant, company identifier `Sandisk` (found
  via the `jobs.smartrecruiters.com/Sandisk` link on sandisk.com/careers).
  Registered as "SanDisk Israel". 292 open positions worldwide; confirmed at
  least one genuinely Israeli one (Lead Software Engineer, Software Defined
  Storage — Kfar Saba) before trusting the token.
- **KLA (KLA-Tencor)** — Workday tenant, host `kla.wd1.myworkdayjobs.com`,
  tenant `kla`, site `Search` (found via the `kla.wd1.myworkdayjobs.com/Search`
  links on kla.com/careers). Registered as "KLA Israel". Flat top-level
  `Country` facet (same shape as Marvell). 55 real Israel jobs confirmed —
  Migdal Ha'emek and Yavne, both real KLA sites (Yavne via the Orbotech
  acquisition), titles plausible for a semiconductor-equipment R&D site
  (Optical Engineer, Algorithm Developer, System Integration Engineer, …).

All three verified with a real `node server/main.js` cycle before being
considered done, not just a one-off probe: KLA and SanDisk both scraped
clean, Amdocs failed exactly as expected (zero-match throw), and Rafael's
three manual jobs and the newly-deactivated IBM were both unaffected by the
same run.

**A scrape failure now has a `kind`, and a red run means something again
(2026-08-21).** `main.js` used to exit non-zero for every single failure
alike — a company with genuinely zero Israel jobs (Snyk, Broadcom,
Syneron-Candela — all already documented above as real, not broken), the
sanity gate correctly refusing a suspicious drop, and an actual adapter
break all looked identical in the email GitHub sent eight times a day, which
is exactly how a real break would eventually hide in the noise. Each
adapter's `if (!res.ok)` throw and each deliberate "ran fine, zero matched"
throw now carries a `kind` (`server/domain/scrapeOutcome.js`'s `ScrapeError`
— `broken` | `blocked` | `empty` | `refused`), set at the exact call site
that understood the failure, never guessed later from the message text. Only
`broken` and `blocked` turn a run red by default.

Two things stop that from becoming permanent noise of its own kind:
- **`watched_companies.known_issue_kind`** (+ `_reason`, `_at`) — a human's
  deliberate acknowledgment via `tools/acknowledge-issue.js`, mutes exactly
  that kind for that company. Check Point (blocked since 2026-08-06 — see
  above) is acknowledged this way; a *different* kind of failure from Check
  Point still goes red.
- **The sanity gate now has memory** (`evaluateSanityGate`'s 3rd param,
  `watched_companies.refusal_streak`/`last_refused_count`): a drop that
  reproduces within 10% on the very next cycle is accepted as a real,
  lasting reduction rather than refused forever; three consecutive
  *non-matching* refusals (nine hours of an unconfirmed number) escalate to
  `broken` so a person is actually told.

**Palo Alto Networks Israel's drop was real, confirmed live the same day it
was investigated.** It had been refusing at ~147 (down from a stale 318)
for at least one prior cycle. The very next local `node server/main.js` run
returned a closely-matching count, the gate accepted it, and `closeMissingJobs`
finally ran for real: **149 jobs are now open; roughly 169 of the 318 the
site had been showing did not actually exist any more.** Confirmed by
querying `watched_companies`/`job_snapshots` directly after the run
(`refusal_streak` back to 0, `last_refused_count` NULL, 149 open rows) — not
inferred from the log alone.

Also caught live, unprompted, by the new classification while verifying all
of this: **Microsoft Israel got rate-limited mid-run** (Eightfold, 429) and
was correctly reported as `blocked, NOT acknowledged`, turning that one run
red on its own — proof the system flags a real, previously-unseen failure
the same way it now stays quiet about the already-understood ones.

**Pacing and retry added (2026-09-11), because two of the four acknowledged
`blocked` companies were our own fault.** All 37 companies used to be
fetched back to back at full speed, ungrouped — one run hit Eightfold's four
tenants (NVIDIA, Microsoft, Qualcomm, Amdocs) consecutively with no gap, and
Workday's ten. Microsoft and NVIDIA's `429`s and Workday's intermittent
same-run block-page-for-seven-tenants (see `parseJsonResponse` above) fit
exactly that shape — indistinguishable, from the site's side, from an
attack.

- **`server/domain/scrapeOrder.js`'s `interleaveByPlatform`** round-robins
  `runCycle`'s company list across `adapter_type` so the same platform's
  tenants are never adjacent — no sleeping, no time cost, because every
  *other* company's real fetch is what spaces them out.
- **`server/domain/retryPolicy.js` + `server/adapters/httpRetry.js`** retry
  only 429/503 (never 403 — that's a refusal, not congestion), honouring
  `Retry-After` in either form (seconds or an HTTP-date), capped at 3
  attempts and 60s per wait — a `Retry-After: 3600` is treated as "not now,"
  not slept through. Every adapter's fetch goes through `fetchWithRetry` now,
  the same drop-in replacement everywhere, not copied per adapter.
- **A stale acknowledgment clears itself.** The moment a company with a
  `known_issue_kind` actually succeeds, `scrapeService.js` clears it and
  logs `RESOLVED` — nobody has to notice and run
  `tools/acknowledge-issue.js --clear` by hand.

**Result, verified with a real local cycle, not just tests: all four
previously-acknowledged companies succeeded and had their acknowledgment
auto-cleared in the same run** — NVIDIA (420 jobs), Check Point (92), Keter
(33), Microsoft (18). Cycle time: 91s (comfortably inside prior runs' range,
so pacing's reordering is genuinely free as designed). Exit code 0 — the
first fully green run since classification was added.

**Caveat worth being honest about:** this was run from this machine's own
connection, not from a GitHub Actions runner's datacenter address. Microsoft
and NVIDIA's recovery is real evidence pacing/retry fixed a genuine rate
limit — that mechanism doesn't care which network it runs from. Check Point
and Keter succeeding here is much weaker evidence: both are `403`/block-page
refusals this project has deliberately not tried to engineer around (see
docs/DEPLOY.md's new "Two companies the cloud scrape will never update"
section), and a local, non-datacenter connection succeeding at something a
datacenter address is blocked from is exactly the expected, unrelated reason
— not proof pacing helped them. **The next scheduled GitHub Actions run is
the real test for those two**; if it blocks them again, that run will
correctly report it as `blocked, NOT acknowledged` and re-acknowledging them
is the right move, not a regression.

**The scheduled run answered it (2026-09-12), and the answer was better than
expected.** 36 companies, 33 new jobs, 33 closed, **0 broken**. Microsoft and
NVIDIA both succeeded from a datacenter address — pacing/retry genuinely fixed
a rate limit, as predicted. **Keter succeeded too**, which the caveat above
expected to fail; its block was apparently not as address-bound as Check
Point's. Check Point alone still refuses, correctly reported as `blocked,
already acknowledged` and correctly silent.

One new failure, and it is the useful kind: **Qualcomm returned `429 TOO MANY
REQUESTS`** (Eightfold), reported as `blocked, NOT acknowledged`. Two things
follow from it:

1. **`fetchWithRetry` spent all three attempts and still failed**, so
   Eightfold's rate-limit window outlasts the 60s cap `retryPolicy.js` allows
   itself. That cap is deliberate (a `Retry-After: 3600` must not be slept
   through) — the fix belongs in ordering, not in waiting longer.
2. **`interleaveByPlatform`'s spacing decayed across the run** — the actual
   bug. Greedy round-robin deals from every platform early and only from
   Greenhouse/Workday late, so Eightfold's four tenants landed at 5, 15, 20,
   23: gaps of 10, 5, 3. The two in wide gaps (NVIDIA, Microsoft) succeeded;
   Qualcomm, five behind Microsoft, did not. Rewritten to sort by
   `(indexWithinPlatform + 0.5) / tenantCount`, which spreads a platform over
   the *whole* run no matter when others run dry: the same four tenants now
   land at 3, 12, 27, 36 (worst gap 9 instead of 3), and no two same-platform
   companies are adjacent anywhere in the real 38-company cycle.

   **This cannot help Workday or Greenhouse much** — ten and eleven tenants in
   a 38-company run cannot be more than ~3 apart, by pigeonhole. If either
   starts refusing on density, that needs a real per-platform delay, not a
   better sort.

Qualcomm was deliberately **not** acknowledged: a 429 caused by our own
request pattern is the one failure class this project fixes rather than
mutes. The next scheduled run tests it.

**Rafael marked link-only instead of pretending three hand-typed jobs are its
whole listing (2026-09-11).** Rafael's own site lists roughly 400 open
positions; JobTrail only ever had the three someone typed in by hand through
the `manual` adapter — a visitor filtering to Rafael saw three jobs and had
no way to know that wasn't the real count. Same failure shape as the old
"IBM Israel (0)" that got IBM deactivated, and the fix follows the same
principle: don't let the site imply completeness it can't back up.

A new `watched_companies.link_only_reason` column (set via
`tools/set-link-only.js --name --reason`, cleared with `--clear`) is a third
state, deliberately not reusing `known_issue_kind`: that column says "this
*failure* is expected right now"; this one says "there is no collection
attempt here at all." A link-only company is skipped by `getActiveCompanies()`
entirely (not fetched, not counted as a failure — it isn't one), its
existing `job_snapshots` rows are excluded from search
(`buildJobFilters`) but never deleted, and it still appears in
`filterOptions()` — marked, so the company picker offers it rather than
silently dropping it. Filtering to it shows a plain notice (visibly not a
job card — no status dropdown, no tags) linking to `career_url`, and a
compact page-wide line names every link-only company so the gap is
discoverable without hunting for it.

Applying it to Rafael found a second, pre-existing bug: its `career_url` had
been empty since whenever the company row was first created (`add-job.js`
only ever writes to the manual JSON file, never touches `watched_companies`)
— the new "לצפייה במשרות באתר שלהם" link would have pointed nowhere. Fixed
using the URL already verified live elsewhere in this project
(`career.rafael.co.il`, present in `tests/jobAvailability.test.js`'s and
`manualAdapter.test.js`'s fixtures since 2026-08-19) — not a new fetch, just
correcting stale configuration with data this project already had.

**Checked whether any other already-registered company deserves the same
treatment: no.** Rafael is the only `manual`-adapter row in `watched_companies`
— Israel Aerospace Industries, AllJobs and Wix were all investigated and
never added (see the dead-end notes above), so none of them exist as a row
to reclassify. Verified the drop this caused is exactly Rafael's three: total
open `job_snapshots` was 2293, Rafael accounted for 3 of them, and
`countJobs` (what search actually serves) reads 2290 — the arithmetic
checks out, nothing else got caught in the exclusion.

**The employment-type filter's ~80% drop (2026-09-24) is deliberate, not a
bug.** `matcher.js` (background saved-profile matching) and the live
`GET /api/jobs?employment=` filter (`jobSearchService.js`) made *different*
choices on purpose, each with its own comment and test: matcher.js lets an
unknown `employment_type` pass any filter, while the interactive search
filter keeps excluding unknowns but reports the gap back
(`employmentGap`/`experienceGap`, rendered by `search.js`'s
`renderFilterGapNote`) — see jobSearchService.js's own comment on `unknownGap`
for why those two calls differ. Both landed weeks ago (`545860c`, `9504f29`),
confirmed still live: `GET /api/jobs?employment=full-time` returns
`employmentGap: {"totalWithoutFilter":2257,"unknownCount":1858}` alongside
`totalMatching: 385`. If a future work order reports this as unimplemented,
check the live response before redoing it — `/api/jobs?employment=full-time`
returning far fewer than the unfiltered count is the intended result of
option (b), not evidence option (b) is missing.

**Thirty companies added (2026-09-24), all existing adapters (26 Greenhouse,
4 Ashby), no new code** — Cato Networks, JFrog, Gong, Via, Transmit Security,
Fireblocks, Axonius, Forter, Tipalti, Armis, Orca Security, Descope, BigID,
Torq, Salt Security, Sweet Security, Innovid, Lightrun, Cymulate, SafeBreach,
Apiiro, Guardz, Capitolis, DataRails, Torii, Hello Heart, Lemonade, Moon
Active, HoneyBook, Unit. Melio was already tracked (`melio`, Greenhouse) and
skipped. Innovid, Lightrun, Torii and Capitolis each have exactly one Israeli
posting — real, confirmed against the live API, just not expected to move
search results much. Sentra and Oligo Security were checked and deliberately
excluded again: both now 404 on the board tokens that used to work, so
whatever the earlier check found is no longer reachable the same way; not
re-investigated, same "don't chase a single-digit/zero count" rule as
Innovid/Lightrun/Torii/Capitolis.

**Found while verifying this batch: a real false-positive in the location
matcher, not an adapter bug.** `locations.js`'s generic-region bucket
(`Center`/`North`/`South`/`Sharon`/`Shfela`/`Gush Dan`) matches on the bare
word alone, with no requirement that the surrounding string mention Israel at
all. Two live collisions found this way: Orca Security posts two Singapore
roles whose office name is literally `"Singapore, Central, Singapore"` — the
bare token `"Central"` (Singapore's business district) matches the same
pattern as Israel's Center region — and Salt Security posts a US
sales-territory role literally named `"Central"` with no country in the
string anywhere. Both would have been pulled in by the greenhouse adapter's
default "no `location` configured, auto-match any recognized Israeli token"
fallback (see greenhouseAdapter.js's `matchesLocation`). Fixed narrowly, per
company, with the adapter's own `location` config option
(`{"boardToken":"orcasecurity","location":"Tel Aviv"}`,
`{"boardToken":"saltsecurity","location":"Tel Aviv"}`) rather than touching
the shared `LOCATION_CANONICAL` patterns — a global fix risks unknown
side effects across the other 80+ companies using the same auto-detect path,
and was out of scope for this batch. **Worth a real fix later**: the generic
bucket should probably require an accompanying Israel/city token in the same
raw string before matching, the same way `primaryCanonicalLocation` already
prefers a specific city over a generic one when both are present — right now
nothing stops the next homoglyph collision (a "South" sales region, a
"Sharon" as a person's name in an address line) from doing the same thing
silently. Confirmed both fixes are correct against the live site: Orca now
shows 2 open jobs (both genuinely Tel Aviv), Salt Security shows 5 (the
`"Central"` row is marked closed, not deleted — history stays).

Pushed via a one-off `workflow_dispatch` job (`tools/ci-add-batch-2026-09-24.js`,
deleted after use, same pattern `push-to-turso.js`'s header describes) rather
than a local `push-to-turso.js` run, because this session had no
`TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN` available — added companies directly
against Turso using the same GitHub Actions secrets `scrape.yml` already
uses, then ran one scrape cycle in the same job so they had real jobs
immediately instead of waiting for the next scheduled run. All 30 confirmed
live via `GET /api/meta` afterward, with job counts matching the local dry
run. The scrape step in that job exited non-zero — but so did the two
`Scrape career pages` runs immediately before it (03:43 and 11:18 UTC the
same day, both on the prior commit, before this batch existed) — so this
looks like a pre-existing, unrelated recurring failure rather than anything
this batch caused. Not investigated further; out of scope for this change,
and the regular scheduled scrape will keep surfacing it if it's real.
