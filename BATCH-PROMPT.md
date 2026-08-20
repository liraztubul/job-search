# JobTrail — the scrape times out against the hosted database

Paste everything below into Claude Code.

---

## The problem

`node server/main.js` finishes in seconds against a local file and **exceeds the
20-minute workflow timeout against Turso**, having been cancelled mid-run. The
GitHub Actions log shows it working — connecting, scraping, writing — just far
too slowly.

The cause is round trips, not throughput:

```
upsertJobSnapshot()   SELECT id ... WHERE company_id = ? AND external_id = ?
                      then INSERT or UPDATE
                      = 2 network round trips per job

~2,500 jobs           = ~5,000 sequential round trips
GitHub runner -> Turso (Ireland), ~150ms each, over Hrana HTTP
                      = 12+ minutes of pure waiting
```

`closeMissingJobs()` has the same shape: one `UPDATE` per closed job.

Against a local file each of those is a memory write and the loop is
instantaneous. This is the fourth instance in this project of correct code
behaving completely differently once the database is on the far side of a
network, and it should be the last one that is a surprise.

**Do not fix this by raising `timeout-minutes`.** That hides it until the job
list grows and it returns. The fix is to stop making thousands of sequential
requests.

---

## Context

`web -> services -> data -> domain`. All SQL lives in `server/data/`. **One
runtime dependency: `libsql`.** `npm test` runs against a local file and cannot
reproduce any of this — verify against Turso.

Three remote-only behaviours already worked around; do not reintroduce them:
`db.transaction()` throws; named `@parameters` silently do not bind (positional
`?` only); `LIMIT`/`OFFSET` must be inlined as validated integers.

`tools/push-to-turso.js` already solves exactly this problem for its own bulk
copy — multi-row `VALUES` batches sized from the column count so the statement
stays under SQLite's bound-parameter cap. **Read it before starting.** The same
technique applies here; the batch-size derivation is worth reusing rather than
re-deriving.

---

## Task 1 — One read per company instead of one per job

Before the per-job loop, fetch the whole company's existing rows in a single
query:

```sql
SELECT id, external_id FROM job_snapshots WHERE company_id = ?
```

Build a `Map` from `external_id` to `id`, and let the loop decide new-versus-seen
from memory. That alone removes ~2,500 round trips and leaves 37.

The `{ isNew, id }` contract that `scrapeService` depends on must not change —
new-job notifications and profile matching both key off `isNew`.

## Task 2 — Batch the writes

Insert and update in multi-row statements rather than one per job.

A single `INSERT ... ON CONFLICT(company_id, external_id) DO UPDATE SET ...`
handles both cases in one statement and can carry many rows at once. It needs a
unique index on `(company_id, external_id)` — **check whether one exists and add
it to `schema.sql` and the migration list in `server/data/schema.js` if not.**
Adding it to only one of those two places is the bug that broke the first Turso
deployment; both, always.

**`first_seen_at` must not be overwritten on conflict.** It is what the search
sorts by and what "new" means; resetting it on every scrape would make every job
look like it appeared today, permanently. The `DO UPDATE SET` list must name the
columns that genuinely change — `last_seen_at`, title, location, apply_url, the
filterable fields, and `is_still_open = 1` — and leave `first_seen_at` alone.

Same for `closeMissingJobs`: close in batches with a single
`UPDATE ... WHERE id IN (?, ?, ...)` per batch.

## Task 3 — Prove it, then leave headroom

Measure a full cycle against Turso before and after, and put both numbers in a
comment where the batching happens. A performance fix with no recorded
measurement is a change nobody dares touch later.

Then set `timeout-minutes` to roughly three times the new measured duration —
not because the work needs it, but so an unusually slow day is a slow run rather
than a failed one. Say in a comment what the measured time was, so a future
timeout breach is recognisable as a regression instead of normal drift.

---

## Constraints

- **No new dependencies.**
- **Do not change what a cycle means.** Same jobs found, same jobs closed, same
  `isNew` semantics, same events emitted to `onEvent`.
- **Do not weaken `evaluateSanityGate`.** It must still see the same "how many
  did this company have before, how many did the scrape return" comparison.
- **Do not raise the timeout as the fix.** Raise it only after the real fix, as
  headroom.
- Never commit `.env` or `jobtrail.db`. `libsql` is synchronous. Windows shell.

## Definition of done

- `npm test` passes, with a test proving `first_seen_at` survives a re-scrape of
  an unchanged job — that is the regression this batching most easily
  introduces, and it would be invisible for days.
- A full cycle against Turso completes well inside the timeout; state the before
  and after numbers.
- Job counts per company after the run match what the previous local run
  produced. A faster scrape that quietly finds fewer jobs is not a fix.
- Rafael's manual jobs are unaffected.

## Report back

The two measurements, and whether a unique index on `(company_id, external_id)`
already existed or had to be added — if it had to be added, say whether any
duplicate rows had to be cleaned out first, because that would mean the old code
has been creating them.
