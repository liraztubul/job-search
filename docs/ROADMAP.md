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

**A bug found afterward, since fixed:** requesting a page beyond `totalPages`
used to return the last page's rows instead of an empty list, so clicking
"next" at the end silently repeated content. `page` is now sanitized (a real
integer, minimum 1) but never *substituted* — see
`server/services/jobSearchService.js`. Page 400 of a 9-page result answers
honestly with `jobs: []` and the true `totalMatching`/`totalPages`, and the
client shows a distinct "nothing on this page — N total matches, here's page
1" state, separate from "nothing matches this filter at all". Clamping to the
last page would have been the smaller diff and the worse answer: it makes the
response lie about which page it is.

---

## Password reset and registration email confirmation — done

**Status: fixed.** There was no way back into an account: a forgotten
password lost it permanently, and this doc originally listed the fix as
blocked on owning a custom domain, on the assumption that a transactional
email provider needs DNS you control. That assumption turned out to be wrong
for the volume this app actually sends at — see the corrected note under
"Not planned yet" below.

Both flows share one mechanism (`server/services/verificationService.js`): a
32-byte random token, only its SHA-256 hash ever stored, single use, and
compared with `crypto.timingSafeEqual` against the small set of recently
issued tokens rather than a `WHERE token_hash = ?` lookup — the whole point
being that a database leak hands over nothing usable. Requesting a reset
answers identically, in the same shape, whether or not the address is
registered, the same care the login handler already took.

A reset now also bumps a `session_epoch` on the account and embeds it in
every signed session cookie, so resetting a password signs out every other
session at the same moment — there was previously no way to revoke a
cookie once issued. Registration confirmation is deliberately **non-blocking**:
an unconfirmed account can sign in and use the site fully. A hard block would
be the more common design, and it's worth being explicit about why this app
doesn't do that yet: there is no support inbox, so a bounced or delayed
confirmation email would lock a real person out of an account they legitimately
created, with no way to appeal. Blocking becomes worth it once there's
somewhere for that appeal to go, or once unconfirmed accounts turn out to be
a real abuse vector in practice — neither is true yet.

**Since this was written: mail sending was deliberately switched off.** Every
transactional provider requires a postal address at signup, and that's not a
trade the owner is willing to make for a student project — see
`server/services/emailService.js`. The flow above still works end to end; it
just can't deliver the link. `client/login.html` now derives whether mail is
configured from `GET /api/session`'s `mailConfigured` field (no second
switch — adding `BREVO_API_KEY` is the only step that turns the reset link
back on) and hides the entry point while it's off, with an unmissable notice
at registration that there is no recovery. The routes and `client/reset.html`
stay reachable regardless, because a link the owner pulls from the server log
must still work. `tools/reset-password.js` is the owner's own escape hatch in
the meantime — it requires database credentials, so it isn't a backdoor,
just that same access going through the real `hashPassword` instead of a
second implementation.

---

## Privacy policy and account deletion — done

**Status: fixed.** ADR-007 listed a privacy policy as required before
strangers use this, alongside email verification and password reset (both
above). `client/privacy.html` is now linked from the footer of every page and
from the registration screen, states plainly what's collected (email, a
scrypt hash, application statuses), where it lives (Turso/EU, Render/
Frankfurt), and what's still missing (email verification isn't enforced,
password recovery depends on mail being configured).

A policy promising deletion needed deletion to exist: `DELETE /api/account`
(`server/services/userService.js`'s `deleteAccount`, `server/data/users.js`'s
`deleteUserAccount`) requires the current password, removes every row the
account owns children-first with no `db.transaction()` (same reasoning as
`passwordResets.js` — a remote libSQL connection is stateless HTTP), and
leaves shared tables (`job_snapshots`, `watched_companies`) untouched.
`client/settings.html` gates it behind typing the account's own email, not a
checkbox. `tests/accountDeletion.test.js` proves deletion removes exactly one
account's rows and nothing of a second account's — the same leak class
ADR-007 exists to prevent, now checked for this code path too.

---

## First-run onboarding — built, then deliberately removed

**Status: not planned, not in progress.** A 3-step wizard (what you're looking
for, where, experience level) was built exactly as originally specified — a
modal shown whenever a signed-in account had no search profile, saving through
the same `POST /api/profiles` Phase 1 built, landing on a pre-filtered search
with a banner offering to edit or see everything. It worked, was verified live,
and was then removed at the owner's explicit request: a new account should land
directly on the normal search page, with nothing to answer before seeing it.

This is not a gap to fill in later. `client/js/onboarding.js` no longer exists;
`client/index.html` has no wizard markup. **The feature it would have fed —
search profiles — is unaffected and stays exactly as built**: `search_profiles`
CRUD, the settings page, the API, and `matcher.js` are all still there. A
person who wants a profile creates one from הגדרות, same as before the wizard
ever existed. If first-run onboarding is wanted again later, this paragraph is
the note that it was tried, worked, and was pulled for a product reason — not
a technical one.

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
back, and which failed and why. Since `libsql` allows one writer, a
scan already in progress should make a second request return `409` with the
current progress instead of starting a second one. Done means one button
refreshes the data, the process is visible while it runs, and a failure names
the company that failed.

---

## System status the user can see — partly done

**Status: the "is the data fresh" half is fixed; the per-company half is
still planned.** There was previously no way to tell whether the scheduled
scrape (`.github/workflows/scrape.yml`) had actually run recently, and a
disabled or silently failing scheduler would leave the site serving old
listings with total confidence.

A `scrape_runs` table now exists (`server/data/schema.sql`) — one row per
completed cycle (`started_at, finished_at, companies, new_jobs, closed_jobs,
failures, failure_details`), written unconditionally at the end of
`scrapeService.runCycle()` regardless of whether individual companies failed,
since a partial failure still refreshed everyone else's data.
`server/domain/scrapeFreshness.js` is the pure "is this stale" rule (no scrape
in 24+ hours, or none ever — the scrape itself runs every 3 hours, see the
cron comment in `.github/workflows/scrape.yml`) and the search page shows
"עודכן לפני 3 שעות" or a prominent warning when it's past that line — see
`GET /api/meta`'s `lastScrapeAt`/`scrapeStale` fields.

**Still planned:** the richer *per-company* version originally sketched here
(`company_id, jobs_found, status, error` per row, a per-company status row on
a Settings page, a dismissible warning after three consecutive failures for
one company). The whole-cycle table above answers "is anything fresh" but not
"which specific company's adapter is quietly broken" — that's this section's
unfinished half.

**Correction to this section's original text:** it proposed the sanity gate
(ARCHITECTURE.md §4.2) as future work alongside the table above. That was
already wrong when written — `server/domain/scrapeSanity.js`'s
`evaluateSanityGate` is wired into `scrapeService.runCycle()` and has its own
test coverage (`tests/scrapeSanity.test.js`). It's unrelated to the freshness
work in this section; the two were never actually coupled.

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

## Closure detection — done

**Status: fixed.** Nothing ever set `is_still_open = 0`, so every job stayed
open forever and the list slowly filled with dead postings. `closeMissingJobs`
(`server/data/jobs.js`) now marks any job not seen in the current run as
closed with a `closed_at` timestamp — but **only after a run that passed the
sanity gate**, which is the whole safety property: a broken adapter returning
`[]` would otherwise close an entire company's listings in one cycle, and the
gate refusing a suspicious drop is what stands between a parse error and
wiping 400 real jobs.

It is demonstrably working rather than merely wired up: 1,191 jobs are closed
against 2,277 open. The clearest case is Palo Alto Networks, whose count had
been stuck at a stale 318 — the gate refused the drop to ~147 once, the next
cycle returned a closely matching number, the gate accepted it as real, and
214 postings that no longer existed were closed.

Closed jobs are excluded from search but never deleted, so a tracked
application doesn't vanish from the dashboard — it stays, greyed out
(`.job.is-closed`) and tagged **המשרה נסגרה**, which is the honest outcome:
you applied to something that has since been taken down, and hiding that
would leave you waiting for an answer that isn't coming.

---

## Notifications

`matcher` and `search_profiles` already decide which jobs a user cares about.
Nothing is ever sent — see ARCHITECTURE.md §4.5 for the outbox design this is
waiting on: a `notification_queue` table written by the matcher and drained by
a separate sender, so a notification is recorded before it's sent rather than
lost on a network blip. First channel planned is in-app only — a bell icon
with unread matches. No SMTP credentials, no new dependency; email can come
later through the same queue and the same Brevo account already wired up for
password reset (`server/services/emailService.js`) — no longer blocked on a
custom domain, see "Password reset and registration email confirmation"
above.

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

**Corrected: email one-time codes did *not* need a custom domain after all.**
This section used to say password reset and email confirmation were blocked
on owning a domain, because transactional email providers are usually
described as needing DNS you control. That's true for *domain
authentication* (bulk senders, and better deliverability at any volume), but
not for *single sender verification* — proving you own one mailbox by
pasting back a code emailed to it, which is all the volume this app sends
needs. See "Password reset and registration email confirmation" above for
what shipped, and `server/services/emailService.js` for the provider
comparison this correction is based on.

---

## What "done" looks like

A person who has never seen this system can, in a browser, with no
instructions and no terminal: create an account, define what they're looking
for, see matching jobs, page through all of them, trigger a refresh,
understand whether the data is fresh, see what's new since their last visit,
mark a job as applied, and find that application again the next day.
