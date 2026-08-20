# JobTrail — make the job list actually keep itself up to date

Paste everything below into Claude Code.

---

## Read this before doing anything

The goal is that the live site's job list refreshes on its own, forever, without
anyone running a command.

**Almost all of the machinery for that already exists.** `.github/workflows/scrape.yml`
is committed and scheduled every three hours; `server/main.js` runs one full
cycle; `closeMissingJobs()` retires postings that vanished; `evaluateSanityGate()`
stops a broken scraper from wiping a company's feed.

The site nonetheless shows **"עדיין לא בוצע איסוף נתונים אוטומטי"**, which is the
staleness banner reporting an empty `scrape_runs` table: **the scheduled scrape
has never completed successfully, not once.**

So this is a diagnosis job, not a build job. **Do not start writing a scheduler,
a queue, a worker, or a second scraping path.** Find why the existing one has
never run, fix what is genuinely broken, and state plainly what is left that
only the repository owner can do — because at least one thing almost certainly
is, and no amount of code will substitute for it.

Work in the order below and report after Task 1 before writing anything.

---

## Context

`web -> services -> data -> domain`. `domain/` imports nothing from the project.
All SQL lives in `server/data/`. **One runtime dependency: `libsql`. Do not add
another.**

Deployed on Render (free tier, no persistent disk), data in Turso (hosted
libSQL), scrape scheduled on GitHub Actions. Repository is **public**, so Actions
minutes are unlimited.

### Three ways the remote database differs from a local file

Each of these passed every test and failed only in production. Do not
reintroduce them, and check any new query against all three:

1. **`db.transaction()` throws** — BEGIN and COMMIT are separate stateless HTTP
   requests. Use a conditional `UPDATE ... WHERE <still unclaimed>`, ordered so a
   crash between statements fails safe.
2. **Named `@parameters` silently do not bind** — filters become `column = NULL`
   and return nothing, with no error. Positional `?` only.
3. **`LIMIT`/`OFFSET` must be inlined** as validated integers; a JS number
   arrives as a float and SQLite raises "datatype mismatch".

`npm test` runs against a local file and **cannot catch any of them.** Verify
against Turso.

---

## Task 1 — Find out why it has never run, and report before fixing

Check these in order. Several are things only the owner can resolve; say so
clearly rather than working around them.

**Is the workflow reaching GitHub at all?** Is `.github/workflows/scrape.yml`
committed and on the default branch? Does the Actions tab list it? A workflow on
a branch that is not default is never scheduled.

**Are the repository secrets present?** The run needs `TURSO_DATABASE_URL` and
`TURSO_AUTH_TOKEN` under Settings → Secrets and variables → **Actions**. These
are separate from Render's environment variables — setting them there does
nothing for Actions. **You cannot add these; only the owner can.** If they are
missing, that is the answer, and it should be the first line of your report.

**Would a run succeed if the secrets existed?** Read the workflow as if you were
the runner. In particular, `data/manual/rafael.json` is excluded by `.gitignore`,
so it does not exist in a fresh checkout. `ManualAdapter` throws when its file is
missing, and `main.js` exits non-zero when any adapter fails — **so every
scheduled run fails on Rafael even when the other 36 companies succeeded.**

Fix that by tracking `data/manual/*.json`. The exclusion was written when the
category was "personal lists, like the database"; these are public job
advertisements for companies whose sites refuse automated access, they are the
input to a public listing, and the deployment is broken without them. Update the
comment to say *personal vs. public*, not *data vs. code* — otherwise the next
person restores "consistency" and breaks it again. `jobtrail.db` and `.env` stay
excluded.

**Does `main.js` report usefully?** A run that fails should say which company and
why, in the Actions log, without anyone reproducing it locally.

Report what you found before changing anything beyond the `.gitignore` fix.

---

## Task 2 — Make the pipeline diagnosable without you

`tools/doctor.js` already walks the chain for a local database. Extend it to
answer, in one command, the question "why is the live site not updating?":

- Which database it is talking to — local file or Turso — printed first, because
  every other answer depends on it. Checking the wrong database and reporting it
  confidently is how this whole class of problem stays hidden.
- Whether `scrape_runs` has any successful run, and how long ago.
- Per company: last successful scrape, open job count, and whether the last
  attempt failed and with what error.
- Which companies are configured but have returned zero jobs since being added —
  IBM has, since the day it was registered.

It must exit non-zero when something is genuinely wrong, so it can be run in CI
later without rewriting it.

---

## Task 3 — Record every run, successful or not

If `scrape_runs` does not yet exist, add it: started, finished, companies
attempted, new jobs, closed jobs, failures (with the error text), and whether the
sanity gate refused any company.

**Write the row even when the run fails.** A table that only records successes
cannot distinguish "never ran" from "ran and broke every time" — and those need
opposite responses. The current banner cannot tell them apart, which is why the
site says "no collection has run" when the truthful message might be "eight runs
failed".

Then make the banner say which it is.

---

## Task 4 — Only after the above: run it for real

Once the secrets exist, trigger the workflow manually (`workflow_dispatch`) and
watch it end to end. **Expect real job titles from real companies in the log** —
`CLAUDE.md` is explicit that "no errors thrown" is not the same thing as
working.

A run counts as verified when:

- The Actions run is green.
- `scrape_runs` has a successful row.
- The live site's banner is gone and shows a refresh time instead.
- Rafael's three manual jobs are still present — they must survive a cycle, not
  be closed by it.
- The job count moved. If it did not move at all, something is being skipped
  silently; find out what before declaring success.

---

## Constraints

- **No new dependencies.** No scheduler library, no queue, no HTTP client.
- **Do not build a second scraping path.** One `runCycle`, called by `main.js`,
  invoked by the workflow. If something must also trigger it, it calls the same
  function.
- **Do not weaken `evaluateSanityGate`.** A scrape returning nothing must never
  close a company's whole feed. If the gate is what is blocking runs, say so —
  do not loosen it to make a run pass.
- **Do not attempt to bypass bot protection.** Rafael, Israel Aerospace
  Industries and AllJobs are recorded dead ends and stay that way.
- Never commit `.env` or `jobtrail.db`.
- Windows shell; `libsql` is synchronous.

## Definition of done

- `npm test` passes.
- `node tools/doctor.js` names the database it inspected and reports the true
  state of the pipeline.
- A scheduled or manually triggered run completes green against Turso and writes
  a `scrape_runs` row.
- The staleness banner is gone, replaced by a refresh time.
- Rafael still has its three jobs.

## Report back

**First line: whether `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` exist as
Actions secrets.** If they do not, everything else here is preparation, and the
owner needs to add them before any of it takes effect. Do not bury that.

Then: whether any scheduled run has ever been attempted, and if runs were
attempted and failed, the actual error — not a summary of it.
