# Job Tracker — Architecture & Design Decisions

**Status:** Proposed
**Date:** 2026-08-03
**Author:** liraz
**Scope:** Watch specific company career pages, detect newly posted jobs, notify via Telegram (instant) + email (digest).

---

## 1. The system in one sentence

> A night watchman who walks the same route every 30 minutes, photographs each door,
> compares today's photo to yesterday's, and radios you the moment a new door opens.

Everything below is a detail of that sentence.

---

## 2. Requirements

### Functional

| # | Requirement |
|---|---|
| F1 | Watch N company career pages, each possibly on a different platform |
| F2 | Detect jobs that appeared since the last check |
| F3 | Filter new jobs against my saved search profiles (keywords, location, seniority) |
| F4 | Push a Telegram message within minutes of a match |
| F5 | Send one email digest per day summarizing all matches |
| F6 | Never notify me twice about the same job |
| F7 | Run unattended on a schedule |

### Non-functional (the ones that actually shape the design)

| # | Constraint | Why it matters |
|---|---|---|
| N1 | ~10–30 companies, ~50 jobs each | Tiny data. Rules out anything distributed. |
| N2 | Detection latency target: < 1 hour | Rules out a daily cron as the *only* trigger. |
| N3 | Single user, runs on my machine or a €5 VPS | No auth, no multi-tenancy, no horizontal scale. |
| N4 | Career sites will break my scrapers without warning | Failure handling is a **first-class feature**, not an afterthought. |
| N5 | I'm the only maintainer, and I have coursework | Optimize for "cheap to fix at 11pm", not for elegance. |

**N4 is the one people underestimate.** Every other design choice below bends around it.

---

## 3. Pipeline

```
  scheduler
     │
     ▼
  for each active company
     │
     ├── adapter.getCurrentJobs()        ← the only site-specific code
     │        │
     │        ▼
     ├── sanity gate                     ← "is this result believable?"
     │        │
     │        ▼
     ├── diff vs job_snapshots           ← what's new? what disappeared?
     │        │
     │        ▼
     ├── matcher(job, profile)           ← does it fit what I want?
     │        │
     │        ▼
     └── notification outbox ──┬── Telegram sender  (instant)
                               └── Email sender     (daily digest)
```

Each arrow is a boundary you can test in isolation. That's the whole point of drawing it.

---

## 4. Components

### 4.1 Adapter layer — *the travel plug adapter*

You have one laptop charger (the rest of the system) and a different wall socket in every
country (Comeet, Greenhouse, Lever, custom Elbit HTML). You don't rewire the laptop per
country — you carry a plug adapter.

```js
class JobSource {
  async getCurrentJobs(): Promise<RawJob[]>
}
```

`RawJob = { externalId, title, location, applyUrl, postedAt? }`

**Already built:** `JobSource.js` (the interface), `comeetAdapter.js` (one implementation).
**This layer is the only place allowed to know about HTML, JSON shapes, or company quirks.**

Two flavors of adapter, and you should always look for the first one:

| Flavor | How you find it | Fragility |
|---|---|---|
| **JSON endpoint** — the page's own XHR call | DevTools → Network → Fetch/XHR | Low. Shapes rarely change. |
| **HTML parse** — cheerio over the rendered page | Only when there's no XHR | High. A CSS class rename breaks you. |

> Rule: spend 10 minutes in DevTools before writing 100 lines of cheerio.

### 4.2 Sanity gate — *the watchman whose flashlight died*

The watchman reports "no cars in the lot." Two possible worlds: the lot is empty, or his
flashlight died. **These look identical in the data**, and a naive system treats the second
as breaking news.

Concretely: Comeet changes their response shape → your `.map()` returns `[]` → your diff
concludes "all 40 jobs closed" → you either spam yourself or silently corrupt state.

The gate, before the diff runs:

```
if (jobs.length === 0 && lastKnownCount > 0)  → mark adapter UNHEALTHY, skip diff, alert me
if (jobs.length < lastKnownCount * 0.5)       → suspicious, skip diff, alert me
if (fetch threw / non-200)                    → increment failure counter, skip diff
if (3 consecutive failures)                   → send me "adapter X is broken"
```

The alert here is *"your scraper is broken"*, not *"a job appeared."* Different message,
different urgency. **This is the single highest-value thing to build after the MVP** — without
it the project rots silently and you find out in three weeks that it stopped working.

**Not in the current code. Needs a new `adapter_health` table.**

### 4.3 Diff — *spot the difference*

`upsertJobSnapshot()` already does this: unseen `(company_id, external_id)` → insert, return
`isNew: true`. Seen → bump `last_seen_at`.

Missing half: **closure detection.** Nothing currently sets `is_still_open = 0`. After a healthy
cycle, any job in the DB for that company whose `last_seen_at` is older than this cycle's
timestamp has disappeared from the site. One `UPDATE` at the end of each company's cycle.
Guarded by the sanity gate — you only trust "it disappeared" from a healthy scrape.

> Why bother? Because "posted 3 days ago, still open" vs "closed after 6 hours" tells you a lot
> about whether it's worth applying, and it makes the whole thing a real tracker rather than a pinger.

### 4.4 Matcher — *the bouncer with a list*

Current: lowercase substring on title + optional location contains. Honest and fine for v1.

Known weaknesses, in the order they'll bite you:

1. `"backend"` misses `"Back-End Developer"` and `"Server Side Engineer"` → normalize (strip hyphens, collapse whitespace) + keep a small synonym map.
2. No negative keywords → you'll get `"Senior Staff Backend Architect"`. Add `exclude_keywords` to `search_profiles`.
3. `experience_filter` is in the schema but **never read by `matcher.js`**. Dead column today.
4. Title-only matching → the seniority signal often lives in the description, not the title.

Upgrade path if it annoys you: embed job titles + your profile with a small local model and
threshold on cosine similarity. Don't start here — you can't debug a similarity score at 11pm,
and you *can* debug a substring.

### 4.5 Notification — *the outbox, not the megaphone*

The current code does this:

```js
db.recordNotification(id, profile.id);   // "I told him"
// TODO: actually tell him
```

That order is a bug waiting to be born. Record-then-send means a network blip loses the
notification forever, and the dedup table cheerfully guarantees it never retries.

**Design: an outbox table.** A job match writes a *row*, not a *message*.

```sql
notification_queue(id, job_snapshot_id, profile_id, channel, status, attempts, last_error, created_at, sent_at)
-- channel: 'telegram' | 'email'
-- status:  'pending' | 'sent' | 'failed'
```

- Matcher's job ends at "insert pending row." It never touches the network.
- A sender pass picks up `pending` rows for its channel, sends, flips to `sent`.
- Telegram sender runs every cycle. Email sender runs once a day and batches all pending email rows into one digest.
- Crash mid-send → row stays `pending` → next run retries. That's the whole benefit.

This also makes "both channels" trivial: one match → two rows, different `channel`, different
cadence, independent failure. No coupling between them.

> Analogy: you don't hand a letter directly to the recipient. You put it in the outbox, and the
> mail carrier's schedule is not your problem.

### 4.6 Scheduler

Two tiers, because F4 (fast) and F5 (digest) want different things:

| Tier | Cadence | Does |
|---|---|---|
| Scrape + Telegram | every 30 min | full cycle, instant pings |
| Email digest | 08:00 daily | drains pending email rows into one message |

Start with `node-cron` in-process (one command, `node server/scheduler.js`, no OS config).
Move to system cron/systemd only when you deploy somewhere that reboots.

Add jitter (`± a few minutes`) and a small delay between companies. Hitting the same endpoint
at exactly `:00` every hour from the same IP is the pattern that gets you blocked.

---

## 5. Decision records

### ADR-001: Polling vs. push

**Context:** F2 needs to know when a job appears. Career sites have no webhooks for candidates.

| Option | Verdict |
|---|---|
| **Poll every 30 min** | ✅ Chosen. Only option that actually exists. |
| RSS/Atom where offered | Use it *inside* an adapter when a company has one — cheaper and politer than scraping. Not a system-level strategy; coverage is too spotty. |
| Email alerts from job boards, parsed | Rejected. You've traded scraping a career page for scraping an inbox, and inherited their delay. |

**Consequence:** worst-case detection latency = the poll interval. 30 min comfortably meets N2.

---

### ADR-002: SQLite vs. Postgres

**Context:** ~1,500 rows total. Single process. Single user.

| Dimension | SQLite | Postgres |
|---|---|---|
| Setup | file on disk | a service to run/host |
| Concurrency | one writer | many |
| Ops burden | zero | nonzero |
| Fit for N1/N3 | exact | overkill |

**Decision:** SQLite (`better-sqlite3`, already installed). It's synchronous, which removes a whole
class of async bugs from your DB layer.

**Consequence to accept:** one writer at a time. Your scheduler must not run two cycles
concurrently — take a simple lock file or just keep it single-process. **Revisit if** you ever add a
web UI with background workers, which is the point where the single-writer limit stops being free.

---

### ADR-003: One adapter per platform vs. one generic scraper

| Option | Complexity | Failure mode |
|---|---|---|
| **Adapter per platform** ✅ | Low each, N files | One company breaks. Blast radius = 1. |
| Generic "find the job list" heuristic scraper | High | Breaks subtly on *all* sites, in ways you can't unit-test. |
| LLM-parses-the-page | Medium | Costs money per run, non-deterministic, silently hallucinates job titles. |

**Decision:** adapter per platform, discovered through a **registry** rather than a `switch`.

Each adapter declares its own identity and config contract:

```js
class AmazonAdapter extends JobSource {
    static type = 'amazon';
    static describe = { help: '...', required: { country: '...' }, optional: { query: '...' } };
}
```

`server/adapters/index.js` scans the folder at startup and builds the lookup table. `main.js`
imports `buildAdapter` and nothing else — it never learns the name of a single adapter.

> A `switch` is a receptionist with a handwritten list of names: every new employee means
> editing the list, and forgetting to is a silent failure. A registry reads the name plates
> on the doors.

This is the plugin/registry pattern — the same shape as Express middleware, webpack loaders
or VS Code extensions. The property that matters: **adding a platform touches exactly one
file, the new one.**

**Correction to an earlier estimate.** This doc originally claimed ~4 adapters would cover
80% of the target list. That holds for companies that buy an off-the-shelf ATS. It does not
hold for liraz's actual list — Amazon, Google, Microsoft, NVIDIA, Dell, IBM, Elbit, Rafael are
eight companies on eight in-house systems. Here it is roughly one adapter per company. The
isolation argument still stands (one company breaks, blast radius is 1); the reuse argument
does not.

**Consequence:** adding a *company* on an already-supported platform is a CLI call with no
code at all (`tools/add-company.js`). Adding a *platform* is one new file. The long tail
(Rafael, Elbit) still needs bespoke work — budget it last.

---

### ADR-004: Dedup keyed on `(job, profile)`

**Context:** F6. One job can match two profiles; two profiles shouldn't be one notification, but the
same job must never re-alert.

**Decision:** uniqueness on `(job_snapshot_id, profile_id)` — already in the schema, and correct.
`(company_id, external_id)` is the stable identity of a job; a retitled posting keeps its ID and won't
re-fire.

**Consequence:** if a company deletes and re-posts the same role, `external_id` changes and you'll
get a second alert. Acceptable — that's arguably real news anyway.

---

### ADR-005: Silent first run (bootstrap mode)

**Context:** On day one, *every* job on *every* watched company is "new." A 30-company first run
sends you several hundred Telegram messages, and Telegram rate-limits you into oblivion.

> You calibrate a scale to zero with nothing on it before you weigh anything.

**Decision:** a company's first successful scrape inserts snapshots with **notifications suppressed**.
Add `bootstrapped_at` to `watched_companies`; if null, record the baseline and set the timestamp
without queueing anything. Same rule applies when you *add* a new company later.

**Consequence:** you miss whatever was already posted when you added the company. Correct
trade — those are old postings you'd have found by browsing anyway.

---

### ADR-006: Secrets

Telegram bot token and Gmail app password are real credentials. `.env` + `dotenv`, and `.gitignore`
must cover `.env` **and** `jobtracker.db` (which will contain your search profiles).

There's no `.gitignore` in the repo right now. That's the cheapest bug to fix and the most
embarrassing one to ship.

---

## 6. Schema changes this design implies

```sql
ALTER TABLE watched_companies ADD COLUMN bootstrapped_at TEXT;     -- ADR-005
ALTER TABLE search_profiles   ADD COLUMN exclude_keywords TEXT;    -- §4.4
ALTER TABLE job_snapshots     ADD COLUMN closed_at TEXT;           -- §4.3

CREATE TABLE adapter_health (                                      -- §4.2
    company_id INTEGER PRIMARY KEY REFERENCES watched_companies(id),
    last_success_at TEXT,
    last_job_count INTEGER,
    consecutive_failures INTEGER DEFAULT 0,
    last_error TEXT
);

CREATE TABLE notification_queue (                                  -- §4.5
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_snapshot_id INTEGER NOT NULL REFERENCES job_snapshots(id),
    profile_id INTEGER NOT NULL REFERENCES search_profiles(id),
    channel TEXT NOT NULL,                     -- 'telegram' | 'email'
    status TEXT NOT NULL DEFAULT 'pending',    -- 'pending' | 'sent' | 'failed'
    attempts INTEGER DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL,
    sent_at TEXT,
    UNIQUE(job_snapshot_id, profile_id, channel)
);
```

`notifications_sent` is superseded by `notification_queue` — the UNIQUE constraint carries the
dedup guarantee, and `status` carries the delivery truth. One table instead of two, and it can no
longer claim "sent" for something that never left the building.

---

## 7. Build phases

**Phase 1 — Prove one company end-to-end** *(the riskiest unknown, so it goes first)*
1. Find one real target company's job endpoint via DevTools
2. Confirm/fix `ComeetAdapter`'s field mapping against a real response
3. `node server/main.js` prints real job titles

**Phase 2 — Real notifications**
4. `.gitignore` + `.env`
5. Migrate to `notification_queue`; matcher writes rows only
6. Telegram sender (BotFather → token → chat ID → `sendMessage`)
7. Email digest sender (nodemailer + Gmail app password)

**Phase 3 — Make it trustworthy** *(the phase people skip and then abandon the project)*
8. Bootstrap mode (ADR-005)
9. Sanity gate + `adapter_health` + "your scraper is broken" alert
10. Closure detection

**Phase 4 — Scale the coverage**
11. `node-cron` scheduler, two tiers, with jitter
12. Greenhouse + Lever adapters (huge coverage for ~40 lines each)
13. Exclude-keywords + title normalization in the matcher

**Phase 5 — Optional**
14. Small web UI to manage companies/profiles instead of editing the DB
15. Application status tracking (applied / interviewing / rejected) — turns a notifier into a real tracker

Phases 1–3 is a project that works. Everything after is polish.

---

## 8. What I need from you to start Phase 1

1. **Which companies?** Names + career page URLs. I'll identify each platform from the URL where I can.
2. **Your actual filters** — roles, keywords, locations, student/junior?
3. **Telegram:** message @BotFather → `/newbot` → send me nothing, just put the token in `.env`.
4. **Email:** Gmail requires 2FA + an App Password (your normal password won't work for SMTP).

The DevTools step in the old README is only needed for companies whose platform I can't identify
from the URL alone — send me the URLs first and we'll see how many of those there actually are.

---

### ADR-007: One account per person, and how a leak is prevented

**Status:** Accepted (foundation built; registration flow not yet)
**Date:** 2026-08-06

**Context.** The tracker was designed for one user (N3). Opening it to the
public changes what the data *is*: `applications` and `search_profiles` stop
being "the" pipeline and become "someone's" pipeline.

**Decision.**

| Table | Owner |
|---|---|
| `users` | — |
| `watched_companies`, `job_snapshots` | shared by everyone |
| `applications`, `search_profiles`, `notifications_sent` | exactly one account |

Sharing the job rows is the point: the scrape cost does not multiply with
signups. A thousand accounts still means one request to Amazon.

**The real risk is not authentication, it's a missing WHERE clause.** Auth is
one function that either passes or fails. Tenant isolation is dozens of
statements that must *each* remember `user_id`, and forgetting one produces no
error — just someone else's applications on your screen, in production, found by
a user rather than a test.

So it is not left to discipline. `data/tenancy.js` exports `requireUser`, every
repository function touching a personal table takes `userId` first and calls it,
and `tests/tenancy.test.js` asserts those functions throw without one. A new
repository function that skips the guard turns the suite red.

**Consequences.**

- Easier: adding an account is a row; the job data needs no duplication.
- Harder: every read of personal data now needs to know who is asking, so the
  session must carry a user id and services must thread it through.
- Storage: SQLite allows one writer at a time (ADR-002). Fine for a handful of
  people; the moment concurrent writes queue noticeably, this is the trigger to
  move to Postgres — not before.
- Deployment: the database is a file. On a host with an ephemeral filesystem it
  is erased on every deploy. It needs a persistent volume mounted at the path in
  `data/connection.js`, and that is a one-time configuration, not a code change.

**Not built yet, and required before this is public:** self-registration and
login wiring through services and routes, email verification, password reset,
rate limiting on login, and a privacy policy — real personal data belonging to
other people brings real obligations.
