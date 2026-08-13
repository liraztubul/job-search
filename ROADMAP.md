# JobTrail — Roadmap

Known limitations in the current build, and the fix intended for each one.
This is an honest list, not a sales pitch — some of it is basic (pagination
was a live data-loss bug until it was fixed), some of it is deliberately
deferred (see the "not yet" notes), and the ordering reflects usability impact
more than difficulty.

Architecture and the reasoning behind existing decisions: **ARCHITECTURE.md**.
Read that first if a fix here looks like it conflicts with how something is
currently built — the layering rules there are enforced, not aspirational.

The system scored **50/100 on a System Usability Scale review**; the target
for the items below is **85+**. Two root causes drive most of the list:

1. **The browser UI is read-only.** Adding a company, running a scrape, adding
   a manual job — all of it is a terminal command today. That's fine for one
   developer on localhost, and a real barrier the moment anyone else is using
   this over the web, because they have no terminal to reach for.

2. **The product promises "watch for new jobs and tell me" and currently
   delivers a static wall of rows.** No concept of "new," no saved searches in
   the UI, no notifications. There's little reason to open it a second day.

Items are listed in the order they'd be tackled — each one after the first
depends on what came before it, both technically and in how much it's worth
doing before the next one.

---

## Pagination and counts that tell the truth — done

**Status: fixed.** `queryJobs` used to cap results at 500 rows with no limit
sent by the UI. With 2,128 matching jobs, the page read
`נמצאו 500 משרות מתוך 2128 במאגר` — reasonably parsed as "500 match your
filter," when it actually meant "here are the first 500 of an unknown
number." 1,628 jobs were unreachable with no indication anything was cut.

`queryJobs` and a new `countJobs` (same `WHERE` clause, no `LIMIT`, so the two
can't drift apart) now back a real `GET /api/jobs` response shape:
`{ jobs, page, pageSize, totalMatching, totalPages }`. Ordering always ends in
`, id DESC` as a tiebreaker — `first_seen_at` alone isn't unique (673 Elbit
jobs share one timestamp from a single scrape), and without the tiebreaker a
job could land on two pages or none. The client keeps the full filter state,
page included, in the URL, so a result set is bookmarkable and survives a
refresh; changing a filter resets to page 1, paging does not.

**Found and fixed while building this:** `queryJobs`'s `LEFT JOIN
applications` had no `a.user_id = @owner` clause — every account's job list
was joining in *whichever* account's application status happened to match,
a real cross-account leak of exactly the kind the tenancy guard (ADR-007)
exists to prevent. `tests/jobs.test.js` covers it directly now.

**A bug found afterward, not yet fixed:** requesting a page beyond
`totalPages` currently returns the last page's rows instead of an empty list,
so clicking "next" at the end silently repeats content instead of saying
there's nothing more. The fix is to sanitize the page number and never
substitute a different page's rows for the one that was actually requested.

---

## First-run onboarding

A new account currently lands on every job from every watched company, which
is meaningless to someone who just signed up.

**Planned:** a 3-step wizard shown whenever an account has no search profile —
what you're looking for (free text + role type), where (multi-select from the
canonical location list), and experience level. Saving it lands the account on
a filtered search with a banner offering to edit the profile or see everything
unfiltered. Done means a new account never sees an unfiltered list before
choosing something, and reaches a relevant result in under a minute with no
instructions.

---

## Managing everything from the browser

Add a **Settings** page, entirely through the existing services layer (no SQL
or business rules added to routes):

- **Search profiles** — list, create, edit, delete. The table already exists
  and has no UI at all, which is why the product's core promise — "tell me
  when something matching appears" — is currently invisible.
- **Companies** — list watched companies with job counts and last successful
  scrape; add one by picking an adapter from the registry. Since
  `server/adapters/index.js` already exposes `availableTypes()` and each
  adapter's `describe` (required/optional config), the form can be generated
  from that instead of hand-written per adapter — a new adapter would then
  need no UI work either.
- **Manual jobs** — an add/edit form for `manual`-adapter companies, replacing
  hand-edited JSON in `data/manual/`, with the same duplicate-`externalId`
  validation `tools/add-job.js` already does.

Done means adding a company, adding a manual job, and creating a search
profile are all things a user can do without opening a terminal.

---

## "Scan now" with visible progress

`server/services/scrapeService.js` already takes an `onEvent` callback and
emits `company:start` / `company:fetched` / `company:failed` / `job:new` /
`job:matched` — nothing currently listens to it.

**Planned:** `POST /api/scan` that runs a cycle and streams progress with
Server-Sent Events (not WebSockets — see the Protocols section of
`CLAUDE.md`), showing which company is being checked, how many jobs came
back, and which failed and why. Since `better-sqlite3` allows one writer, a
scan already in progress should make a second request return `409` with the
current progress instead of starting a second one. Done means one button
refreshes the data, the process is visible while it runs, and a failure names
the company that failed.

---

## System status the user can see

There's currently no way to tell whether the data is fresh or whether a
company's adapter is quietly broken. IBM has returned 0 jobs for a while and
nothing in the UI says so.

**Planned:** a `scrape_runs` table (`started_at, finished_at, company_id,
jobs_found, status, error`) written by `scrapeService`, surfaced as a "last
updated" timestamp in the header, a per-company status row on the Settings
page, and a dismissible warning after three consecutive failed runs for one
company.

**Also planned alongside this:** the sanity gate described in
ARCHITECTURE.md §4.2 — if a scrape returns 0 jobs for a company that had jobs
before, mark the run failed and don't overwrite the previous data. A broken
scraper and a company that genuinely closed every role look identical in the
data; only one of them is real, and the gate is what tells them apart.

---

## Making unseen jobs impossible to miss

The whole value of this product is catching new postings, and the UI
currently has no concept of "new."

The distinction that matters is between "new to the world" (`first_seen_at`
is recent) and "new to this user" (they haven't looked at it yet) — the
second is the one worth building. A job posted three days ago that a user
never saw is new to them; a job posted an hour ago that they already
dismissed is not.

**Planned data model:** a `seen_through` timestamp on `users`, and a
`job_views(user_id, job_snapshot_id, seen_at)` table. A job is NEW when
`first_seen_at > seen_through` and no `job_views` row exists for that
(user, job) pair. Both are personal data — `userId` first, `requireUser`,
`job_views` added to `PERSONAL_TABLES` with coverage in
`tests/tenancy.test.js`. On account creation, `seen_through` is set to "now,"
so a new user's first screen doesn't show 2,128 "new" badges — which would
convey exactly as much as showing none.

**The rule that makes this trustworthy: nothing is ever marked seen just
because a page rendered.** That's the failure mode of every unread-count
feature — glance at the app on a phone, everything silently flips to read,
and whatever you meant to come back to is gone with no way to find it again.
Seen state should change only on a deliberate act: clicking through to a
job's apply URL, setting an application status on it, dismissing it directly,
or clicking "mark all as seen" (which should be undoable for the session,
since clicking it by accident otherwise loses the whole queue).

The badge should count only jobs matching the user's active search profile,
reusing `server/domain/matcher.js` rather than reimplementing the rule in
SQL — someone watching for student roles in Haifa shouldn't see "47 new"
because NVIDIA posted 47 senior roles in Santa Clara. A badge nobody trusts
is worse than no badge, so both counts (matching and total) should be shown
when they differ.

**Worth writing and testing as a pure function first:** "is this job new for
this user" has four inputs — `first_seen_at`, `seen_through`, a view row, and
profile match — and is exactly the kind of logic that silently inverts if
it's wired straight into UI code without a test.

---

## Closure detection

All 2,128 jobs are currently marked open, because nothing ever sets
`is_still_open = 0`. Left long enough, users will click through to dead
postings and stop trusting the list.

**Planned:** after a scrape that passes the sanity gate above, mark any job
for that company not seen in the current run as closed, with a `closed_at`
timestamp — only after a *healthy* run, since a broken adapter returning `[]`
must never be allowed to close an entire company's listings. Closed jobs
should show greyed out with a "no longer posted" tag rather than disappear,
so a tracked application doesn't silently vanish from the dashboard.

---

## Notifications

`matcher` and `search_profiles` already decide which jobs a user cares about.
Nothing is ever sent — see ARCHITECTURE.md §4.5 for the outbox design this is
waiting on: a `notification_queue` table written by the matcher and drained by
a separate sender, so a notification is recorded before it's sent rather than
lost on a network blip. First channel planned is in-app only — a bell icon
with unread matches. No email, no SMTP credentials, no new dependency; email
can come later through the same queue (see "Not planned yet" below for why
that's specifically blocked on a custom domain).

---

## Not planned yet, and why

**SMS one-time codes — considered and rejected.** Every message costs real
money (~₪0.15 in Israel), and an unauthenticated "send me a code" endpoint
hands an attacker a button that spends it — a password guess costs CPU, an
SMS costs currency. It doesn't remove the need for rate limiting either; it
makes it more urgent, because the failure mode becomes a bill instead of just
CPU time. SMS is also the weakest widely-deployed second factor — SIM-swap
attacks are routine, and NIST no longer recommends it as a standalone
authenticator — and a phone number is personally identifying information,
which adds privacy obligations rather than removing them.

**Email one-time codes / password reset — worth building, not yet started.**
Transactional email providers require a domain with DNS you control, and
`*.fly.dev` belongs to Fly, not to this project. This becomes the next real
piece of auth work once a custom domain exists, and it would solve both email
verification and password reset with one mechanism.

---

## What "done" looks like

A person who has never seen this system can, in a browser, with no
instructions and no terminal: create an account, define what they're looking
for, see matching jobs, page through all of them, trigger a refresh,
understand whether the data is fresh, see what's new since their last visit,
mark a job as applied, and find that application again the next day.
