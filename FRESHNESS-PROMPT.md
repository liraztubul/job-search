# JobTrail — never show a job that no longer exists

Paste everything below into Claude Code.

---

## Context

Read `CLAUDE.md` first. `web -> services -> data -> domain`; `domain/` imports
nothing; all SQL lives in `server/data/`. **One runtime dependency (`libsql`) —
do not add another.** `fetch` is built into Node 18+.

### The remote database is not the same as a local file

Three differences, each found only in production. Do not reintroduce them:

1. **`db.transaction()` throws** — BEGIN and COMMIT are separate stateless HTTP
   requests. Use a conditional `UPDATE ... WHERE <still unclaimed>` and order
   statements so a crash between them fails safe.
2. **Named `@parameters` silently do not bind**, turning filters into
   `column = NULL` and returning nothing, with no error. Positional `?` only.
3. **`LIMIT`/`OFFSET` must be inlined** as validated integers — a JS number
   arrives as a float and SQLite raises "datatype mismatch".

The test suite runs against a local file and **cannot catch these**. Verify
anything database-shaped against Turso before calling it done.

### What already exists — do not rebuild it

Closure detection is built and working: `closeMissingJobs()` in
`server/data/jobs.js`, called from `scrapeService.js`, guarded by
`evaluateSanityGate()` so a broken scraper cannot mark a company's whole feed
closed. `buildJobFilters` excludes `is_still_open = 0` unconditionally, and
`listApplications` deliberately does not — closing a job must never erase
someone's own tracked application.

That machinery is correct. The problem is that it only runs when a scrape runs,
and the live database has not been scraped since it was populated by hand.

---

## Task 1 — The scheduled scrape fails on Rafael every single run

`.github/workflows/scrape.yml` runs `node server/main.js` against Turso. It
cannot currently succeed.

`data/manual/rafael.json` exists on the owner's disk but is excluded by
`.gitignore` (`data/manual/*.json`). Actions checks out from git, so the file is
absent, `ManualAdapter.getCurrentJobs()` throws, and `main.js` exits non-zero
because an adapter failed. Every run goes red even when the other 36 companies
succeeded — and a red run that is red for a known, boring reason is a failure
signal nobody reads any more.

**Fix:** track `data/manual/*.json`.

That rule was written when the concern was "personal lists, like the database".
It is the wrong category: these are public job advertisements copied from a
company's own careers page, for companies whose sites refuse automated access
(Rafael sits behind Reblaze). They are not personal data, they are the input to
a public listing, and the deployment is broken without them.

Update `.gitignore` and replace the comment with the real reason. Keep
`jobtrail.db` and `.env` excluded — the distinction being drawn is *personal vs.
public*, not *data vs. code*, and the new comment should say so, since the next
person will otherwise "restore consistency" by re-ignoring it.

Then confirm: does the workflow run clean, and has it ever actually run? If it
is waiting on `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` repository secrets that
only the owner can add, **say so plainly** — that is the difference between
"scheduled" and "running", and everything below depends on it.

---

## Task 2 — Scrape more often

Currently `0 3,15 * * *` — twice a day, so a job can be dead for up to twelve
hours while still being listed.

Move to every three hours (`0 */3 * * *`). That is eight runs a day; each takes
a few minutes, which is far inside the free Actions allowance even for a private
repository.

Do not go below hourly. Past that the cost lands on the career sites being
polled, not on us, and this project has been deliberate about not being a
nuisance to them. Note the reasoning next to the cron line so a future "make it
faster" has to argue with it.

---

## Task 3 — Check the link when someone clicks it

The honest version of "check on every refresh".

Scraping 37 sites per page load is not viable — minutes per request, and every
visitor's refresh becomes a burst of traffic at companies who did not ask for
it. But checking **the one job a person is actually about to open** is a single
request, and it closes the gap between the last scrape and this moment.

Add `POST /api/jobs/:id/verify`:

- Fetch the job's `applyUrl` — `HEAD` first, falling back to `GET` for hosts
  that reject HEAD (several career platforms do).
- A short timeout (5 seconds) and a real `User-Agent`. If it times out or the
  host errors, **treat it as unknown, not as closed.** A slow server is not a
  closed job, and wrongly closing a live listing is the worse mistake.
- On a confident "gone", call the same `closeMissingJobs` path used by the
  scrape so one visitor's click benefits everyone. Do not write a second closing
  routine.

**Companies on the `manual` adapter must be exempt from verification entirely,
and this is not an optimisation — without it the feature deletes their jobs.**

Rafael is tracked manually precisely because its site sits behind Reblaze bot
protection. A server-side fetch of a Rafael URL is exactly the automated access
Reblaze exists to refuse, so it will *always* fail. If a block is read as "this
posting is gone", the first person to click a Rafael job closes it permanently,
and the same happens to every company added for the same reason later.

So, two independent guards, because either one alone eventually fails:

1. Skip verification when the job's company uses the `manual` adapter. There is
   nothing to learn from a request we know will be refused.
2. In `jobAvailability.js`, classify bot-protection responses — 403, 429, a
   CAPTCHA or challenge page, Reblaze's own markers (`rbzns`, Perfdrive) — as
   **unknown**, never as closed. This is the general rule, and it protects sites
   that start using bot protection after being added.
- Rate limit it through the existing `rateLimit.js`, per IP — it makes outbound
  requests on demand, which is exactly the shape of endpoint that gets abused.

**404 is not the only signal, and this is the part worth getting right.** Many
career sites return `200` with a "position no longer available" page rather than
a proper 404 — Workday, Eightfold and several bespoke sites all do. Add a small
`server/domain/jobAvailability.js` (pure, no network, no database) that decides
from a status code plus a body snippet, matching a short list of phrases in
English and Hebrew ("no longer available", "position has been filled", "המשרה
אינה זמינה", and similar). Being pure makes it testable against real captured
bodies, which is the only way to know it works.

Keep the list conservative. **A false "closed" hides a real job from everyone**,
while a false "open" costs one person one click — the errors are not
symmetrical, and the threshold should reflect that.

On the client: intercept the click, verify, then either open the link or replace
the card with "המשרה נסגרה" and remove it on the next search. The wait must be
visible and brief; if verification has not answered within about a second,
**open the link anyway**. Never make someone wait on a check that exists to save
them a wasted click.

---

## Task 4 — Say when the data was last refreshed

All of the above still leaves a window, and the site should not pretend
otherwise.

Record each cycle in a `scrape_runs` table (started, finished, companies, new
jobs, closed jobs, failures) and show the newest successful run on the search
page: "המשרות עודכנו לפני 3 שעות". When it is older than 24 hours, say so
prominently rather than quietly.

This is what turns a silent failure into an obvious one. GitHub disables
scheduled workflows in a repository with no activity for 60 days; without a
visible timestamp the site would go on confidently serving month-old listings,
and the first person to find out would be someone applying to a filled role.

---

---

## Task 5 — Four companies the owner expects to see and does not

Checked against the live database. Twelve of the sixteen she named are tracked
and returning jobs. Mellanox is correctly absent — it folded into NVIDIA, which
is already tracked, and `CLAUDE.md` records that. These four are the gap:

| Company | State |
|---|---|
| **Amdocs** | not registered at all |
| **SanDisk** | not registered at all |
| **KLA (KLA-Tencor)** | not registered at all |
| **IBM Israel** | registered, adapter returns **0 jobs**, and always has |

**IBM first — it is the more damaging of the two problems.** A company listed in
the filter dropdown with nothing behind it reads as "IBM has no openings", which
is a claim the site is making and cannot support. Either fix `ibmAdapter.js` or
deactivate the company row so the site stops asserting something untrue. Find
out which by printing the raw response before touching the mapping — guessing at
field names is, per `CLAUDE.md`, the main way this project wastes an hour.

For the three missing ones, follow the process the project already has and do
not shortcut it:

```bash
node tools/probe.js "<careers url>"     # is there a JSON endpoint behind the page?
node tools/sniff.js <name>              # for SPAs: real browser, captures the XHRs
node tools/add-company.js --name "…" --type <adapter> --country ISR
```

Fifteen adapters are already registered, so there is a fair chance each of these
is a tenant of one of them — Workday, Eightfold, SmartRecruiters, Greenhouse,
Comeet and Ashby between them cover most Israeli tech employers. **If so, no code
is needed at all**, only a company row.

Two rules from hard experience, both in `CLAUDE.md`:

- **A token or tenant name that returns 200 is not proof of identity.** Guessing
  Greenhouse's board token `iai` for Israel Aerospace Industries returned five
  real jobs belonging to an unrelated UK company. Check that the titles and
  locations are plausible for the actual employer before trusting a guess.
- **Workday's location facet has at least three different shapes.** A filter
  that returns nothing does not mean the tenant has no Israeli jobs; test
  against both shapes `resolveLocationFacet()` handles before concluding.

If one of them turns out to be blocked the way Rafael and IAI are, **stop and
record why** in `CLAUDE.md` alongside the existing dead ends. That file's list of
what did not work and the reason is one of the more valuable things in this
repository — do not add a company by working around a site's refusal.

---

## Constraints

- **No new dependencies.** `fetch` is built in; no HTTP client library.
- **Do not attempt to bypass bot protection** on any site, for any company.
  Rafael, Israel Aerospace Industries and AllJobs are recorded dead ends and
  stay that way.
- `jobAvailability.js` goes in `domain/` and must stay pure — no network, no
  database, no imports from the project.
- Reuse `closeMissingJobs` and `rateLimit.js`; do not write second versions.
- Do not weaken `evaluateSanityGate` — a scrape returning nothing must never
  close a company's whole feed.
- Never commit `.env` or `jobtrail.db`.
- Windows shell; `libsql` is synchronous.

## Definition of done

- `npm test` passes, including `jobAvailability` tested against real captured
  bodies (a genuine 404, a 200 "no longer available" page, and a live posting),
  and the staleness banner at the 24-hour boundary.
- The workflow runs green, or the report states exactly which secret is missing.
- Clicking a job that has since closed says so instead of opening a dead page,
  and the job disappears from the next search for everyone.
- Clicking a live job opens it with no perceptible delay.
- The search page shows when the data was last refreshed.
- **Clicking a Rafael job does not close it.** Verify this directly — it is the
  one place where the new feature can destroy data, and it will look fine right
  up until someone clicks.
- Rafael's three manual jobs still appear after a full scrape cycle.
- IBM either returns real jobs or no longer appears as an option, and Amdocs,
  SanDisk and KLA are tracked — or each has a recorded reason in `CLAUDE.md` for
  why it cannot be.

## Report back

Whether the scheduled scrape has genuinely ever run against Turso — the rest of
this is worthless if it has not, and it is the easiest thing to assume is fine.

And which phrases you put in the availability list, with the source you verified
each against. A guessed phrase that matches too broadly deletes real jobs.
