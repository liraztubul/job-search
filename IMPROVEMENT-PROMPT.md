# Job Tracker — usability overhaul for public web users

Paste everything below into Claude Code.

---

## Context

Read `CLAUDE.md` and `ARCHITECTURE.md` before writing anything.

Respect the existing architecture:

- Layering is `web -> services -> data -> domain`. `domain/` imports nothing
  from the project. Nothing imports `web/`.
- All SQL lives in `server/data/`. Not in services, not in routes, not in tools.
- Adapters self-register from `server/adapters/`. Never add a `switch` over
  adapter types.
- Every query touching per-account data takes `userId` first and calls
  `requireUser` from `server/data/tenancy.js`.
- **No new npm dependencies.** The project is deliberately `better-sqlite3`
  only, `node:crypto` for auth, and Node's built-in `fetch`. Playwright is
  dev-only and must stay out of the runtime.

The system currently scores **50/100 on SUS**. Target: **85+**.

Two root causes:

1. **The browser UI is read-only.** Adding a company, running a scrape, adding a
   manual job — all of it is a terminal command. Acceptable for one developer on
   localhost; fatal once real users reach this over the web, because they cannot
   do any of it.

2. **The product promises "watch for new jobs and tell me" and delivers a static
   wall of rows.** No concept of "new", no saved searches in the UI, no
   notifications. There is no reason to open it tomorrow.

Work through the tasks in order. They are ordered by dependency and by usability
impact, not by difficulty. Do not start a task before the previous one passes
its acceptance criteria.

---

## Task 1 — Pagination, and counts that tell the truth

**Do this first: it is a live data-loss bug, and every later task renders into
this list.**

`server/data/jobs.js` caps `queryJobs` at 500 rows by default and the UI never
sends a limit. With 2,128 matching jobs the user sees
`נמצאו 500 משרות מתוך 2128 במאגר` and reasonably reads it as "500 match my
filter". It actually means "here are the first 500 of an unknown number".
1,628 jobs are unreachable, with no indication that anything was cut.

### Server

- `queryJobs` takes `page` (1-based) and `pageSize` (default **20**, max 100)
  and translates them to LIMIT/OFFSET. Remove the silent 500 default.
- Add a separate `countJobs(userId, filters)` running `COUNT(*)` with the **same
  WHERE clause** and no LIMIT. It must be a second query, not derived from the
  rows returned — that is the entire point.
- `GET /api/jobs` returns `{ jobs, page, pageSize, totalMatching, totalPages }`.

**The ordering must be total and stable.** `ORDER BY first_seen_at DESC` alone is
not unique — SQLite may break ties differently on each query, so a job appears on
both page 2 and page 3 while another is never shown. Always append `, id DESC` as
a tiebreaker, whatever sort the user picks.

This matters in practice, not in theory: all 673 Elbit jobs were inserted in the
same scrape and share a timestamp.

### UI

Below the results:

```
‹ הקודם   1  2  [3]  4  5 … 107   הבא ›
```

- 20 jobs per page.
- Show first, last, current and two neighbours; elide the rest with `…`. Do not
  render 107 page links.
- Prev disabled on page 1, Next on the last page — **disabled, not hidden**, so
  the control does not move under the cursor.

**RTL: "next" points LEFT.** In a `dir="rtl"` page the forward arrow is `‹` and
back is `›`. Use logical CSS properties. Getting this backwards is the most
common bug in Hebrew interfaces and makes the page feel wrong without the user
being able to say why.

Replace the current sentence with:

```
2,128 משרות תואמות · מציג 41–60
```

Three numbers are currently conflated and must stay distinguishable: how many
match the filter, which are on screen, and how many exist in total. **Never show
a number the user could read as "this is all there is" when it means "this is
what I chose to send".**

### Behaviour

- Page lives in the URL (`?page=3&experience=senior`) so a result set can be
  bookmarked, shared, and survives a refresh.
- **Changing any filter resets to page 1.** Otherwise the user lands on an empty
  page and reads it as "no results".
- Setting a status or dismissing a job must NOT jump back to page 1.
- On page change: move focus to the results heading, announce
  `מציג 41–60 מתוך 2,128` in the existing aria-live region, and scroll to the top
  of the list — not the top of the document, which would hide the filters they
  just set.

### Tests

1. `countJobs` returns the same number regardless of page or pageSize.
2. Paging through every page and concatenating yields each job exactly once — no
   duplicates, nothing skipped. **Seed rows that share a `first_seen_at` value**;
   a test with unique timestamps passes even when the ordering is broken.
3. `page=0`, `page=-1`, `page=99999`, `pageSize=1000` are clamped, not errors.

---

## Task 2 — First-run onboarding

A new account currently lands on every job from every company, which is
meaningless to them.

Show a 3-step wizard when an account has no search profile:

1. **What are you looking for?** — free-text keywords + role type
2. **Where?** — multi-select from the canonical list in
   `server/domain/locations.js`
3. **Experience level** — the closed vocabulary in `server/domain/vocabulary.js`

Save it as a `search_profiles` row for that user. Land them on the search page
with those filters applied and a one-line banner:
`מציג משרות שמתאימות לפרופיל שלך — [עריכה] [הצג הכל]`

**Acceptance:** a new account never sees an unfiltered list before choosing
anything, and reaches a filtered, relevant result in under 60 seconds with no
instructions.

---

## Task 3 — Manage everything from the browser

Add a **Settings** page. Everything goes through the services layer; no SQL or
business rules in routes.

**a. Search profiles** — list, create, edit, delete. The table already exists and
has no UI at all, which is why the product's core promise is invisible.

**b. Companies** — list watched companies with job counts and last successful
scrape. Add one by picking an adapter from the registry. `server/adapters/index.js`
already exposes `availableTypes()` and each adapter's `describe` with its
required/optional config — **render the form from `describe`**, so a new adapter
needs no UI work. Validate with the existing `validateConfig()` and show its
messages inline.

**c. Manual jobs** — add/edit form for `manual`-adapter companies, replacing
hand-edited JSON in `data/manual/`. Same validation as `tools/add-job.js`:
reject a duplicate `externalId` before saving, and name the offending entry.

**Acceptance:** a user can add a company, add a manual job, and create a search
profile without opening a terminal.

---

## Task 4 — "Scan now" with visible progress

`server/services/scrapeService.js` already takes an `onEvent` callback and emits
`company:start` / `company:fetched` / `company:failed` / `job:new` /
`job:matched`. Nothing consumes it.

Add `POST /api/scan` that runs a cycle and streams progress with **Server-Sent
Events** — not WebSockets, see the Protocols section of `CLAUDE.md`. Show which
company is being checked, how many jobs came back, and which failed and why.

`better-sqlite3` allows one writer: if a scan is already running, return **409**
with the current progress instead of starting a second one.

**Acceptance:** one button refreshes the data, the user can watch it happen, and
can see which company failed.

---

## Task 5 — System status the user can see

Users have no way to know whether the data is fresh or whether a company is
broken. IBM has had 0 jobs for a while and nothing in the UI says so.

Add a `scrape_runs` table (`started_at, finished_at, company_id, jobs_found,
status, error`) written by `scrapeService`. Surface it as:

- `עודכן לאחרונה: לפני שעתיים` in the header
- a status row per company on the Settings page
- a dismissible warning when a company has failed 3 runs in a row

**Also implement the sanity gate** (ARCHITECTURE.md §4.2) while you are here: if
a scrape returns 0 jobs for a company that had jobs before, mark the run failed
and do **not** overwrite the previous data. A broken scraper and a company that
closed every role look identical in the data, and only one of them is real.

---

## Task 6 — Make unseen jobs impossible to miss

The whole value is catching new postings, and the UI has no concept of "new".

### The distinction that matters

- **new to the world** = `first_seen_at` is recent
- **new to THIS USER** = they have not looked at it yet

The second is the one worth building. A job posted three days ago that the user
never saw is new to them. A job posted an hour ago that they already dismissed is
not.

### Data model

Add to `users`:

```
seen_through TEXT   -- ISO timestamp; jobs first seen after this are "new"
```

And a dismissal table:

```
job_views(user_id, job_snapshot_id, seen_at, UNIQUE(user_id, job_snapshot_id))
```

A job is NEW when `first_seen_at > seen_through` **and** there is no `job_views`
row for that (user, job).

Both are personal data: `userId` first, `requireUser`, and `job_views` goes in
`PERSONAL_TABLES` with coverage in `tests/tenancy.test.js`.

**On account creation, set `seen_through = now`.** Otherwise a new user's first
screen shows 2,128 "new" badges, which conveys exactly as much as showing none.

### The rule that makes this trustworthy

**Never mark anything seen just because a page rendered.**

This is the failure mode of every unread-count feature: the user glances at the
app on their phone, everything silently flips to read, and the thing they meant
to come back to is gone with no way to find it. Scrolling past a job is not the
same as having considered it.

Seen state changes ONLY on a deliberate act:

- clicking through to the job's apply URL
- setting any application status on it
- clicking the per-job dismiss control
- clicking "סמן הכל כנראה", which advances `seen_through` to now

Make "סמן הכל כנראה" **undoable for the session** — keep the previous
`seen_through` in memory and offer "בטל" in the confirmation toast. Someone who
clicks it by accident has otherwise lost their whole queue.

### How it looks

Redundant cues, never colour alone:

- a text badge reading `חדש` — real text, not a coloured dot, so a screen reader
  announces it and a colour-blind user sees it
- a 3px accent stripe on the inline-start edge of the card
- heavier title weight
- a small `✓ ראיתי` button per card, to clear one item without opening it

Pinned, collapsible, at the top of the search page:

```
┌─────────────────────────────────────────────┐
│ 12 משרות חדשות מאז הביקור האחרון            │
│ [הצג רק חדשות]  [סמן הכל כנראה]             │
└─────────────────────────────────────────────┘
```

Hide the block entirely at zero — an empty "0 new" banner trains people to ignore
that region of the screen.

Also: put the count in the document title (`(12) Job Tracker`) so it is visible
from a background tab, add a `חדשות בלבד` filter chip with `newOnly` in the URL
state, and make newest-first the default sort.

### Count what the user actually cares about

The badge counts only jobs matching the user's active search profile, not every
new row. `server/domain/matcher.js` already answers "does this job fit this
profile" — reuse it, do not reimplement the rule in SQL.

Someone watching for student roles in Haifa must not see "47 new" because NVIDIA
posted 47 senior positions in Santa Clara. That number destroys trust in the badge
within two days, and **a badge nobody trusts is worse than no badge**.

Show both when they differ: `12 חדשות שמתאימות לך · 47 חדשות בסך הכל`.

### Accessibility

- the banner is a live region: after a scan, announce
  `12 משרות חדשות מאז הביקור האחרון`
- the `חדש` badge is part of the card's accessible name, announced as
  `חדש — Senior Firmware Engineer, Mobileye`
- mark-seen buttons need a per-job accessible label naming the job, not
  "mark seen" repeated 20 times
- the mark-seen control is in tab order, not hover-only

### Acceptance

1. A daily visitor sees, at a glance and with no clicks, how many relevant jobs
   appeared since last time.
2. Opening and closing the site does NOT clear that count.
3. Clicking through to a job clears it for that job only.
4. "Mark all as seen" is one click and undoable within the session.
5. The count reflects the saved search; the overall number is available but
   secondary.
6. Every cue reaches a screen reader and a colour-blind user.

**Write "is this job new for this user" as a pure function in `server/domain/`
and test it before wiring any UI to it.** It has four inputs — `first_seen_at`,
`seen_through`, a view row, profile match — and is exactly the kind of logic that
silently inverts.

---

## Task 7 — Closure detection

All 2,128 jobs are marked open, because nothing ever sets `is_still_open = 0`.
Users will click through to dead postings and stop trusting the list.

After a scrape that **passed the sanity gate from Task 5**, mark any job for that
company not seen in this run as closed, with a `closed_at` timestamp. Only for a
healthy run — a broken adapter returning `[]` must never be allowed to close an
entire company.

Show closed jobs greyed out with a `כבר לא מפורסמת` tag rather than hiding them,
so a tracked application does not silently vanish from the dashboard.

---

## Task 8 — Notifications

`matcher` + `search_profiles` already decide which jobs a user cares about.
Nothing is ever sent.

Build the outbox from ARCHITECTURE.md §4.5: a `notification_queue` table written
by the matcher, drained by a separate sender. **Never send inline** — record-then-
send loses the notification on any network blip, and the dedup table then
guarantees it never retries.

First channel: **in-app only** — a bell icon with unread matches. No email, no
SMTP credentials, no new dependency. Email can come later through the same queue.

---

## Constraints

Keep everything already built:

- semantic landmarks, aria-live on result counts, visible focus, WCAG AA contrast
  in all three colour modes, status conveyed by text and not colour alone, the
  accessibility panel, RTL Hebrew. **Every new control meets the same bar.**
- `tests/tenancy.test.js` stays green.
- Add tests for every new service function and every new pure function.
- `npm test` passes with zero failures before anything is called done.
- After each task, **run the server and exercise the new screen**. Do not report
  a task complete because the code compiles.
- Update `CLAUDE.md` and `README.md` as behaviour changes.

## Definition of done

A person who has never seen this system can, in a browser, with no instructions
and no terminal: create an account, define what they are looking for, see
matching jobs, page through all of them, trigger a refresh, understand whether
the data is fresh, see what is new since last time, mark a job as applied, and
find that application again tomorrow.
