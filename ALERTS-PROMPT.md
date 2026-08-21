# JobTrail — make a red scrape run mean something again

Paste everything below into Claude Code.

---

## The problem

The scheduled scrape works. It fetches 37 companies, writes them to Turso, and
finishes in under two minutes. It then **exits non-zero every single time**, so
GitHub emails a failure notice eight times a day, and has done since the day it
started running.

The five reported failures are:

```
Check Point Israel:  fetch failed on start=0: 403 Forbidden
Palo Alto Networks:  sanity gate: returned 147 job(s), had 318 open (over 50% drop)
Snyk Israel:         Workday: no location matches country "Israel"
Broadcom Israel:     Workday: no location matches country "Israel"
Syneron-Candela:     SmartRecruiters returned 1 job, none matched the location filter
```

**Only one of those is a fault, and it is not the same kind of fault as the
others.** Three are companies that genuinely have no Israeli openings right now —
`CLAUDE.md` records all three as verified and expected, and the adapters throw
there deliberately, as a signal to check the facet logic before trusting a zero.
One is the sanity gate doing exactly its job: refusing to close 171 jobs on a
suspicious result. One, Check Point, is a real block.

`main.js` treats all five identically, so a red run currently means "it is
Tuesday". The cost is not the noise itself — it is that when NVIDIA's adapter
genuinely breaks, the email will look exactly the same and nobody will open it.

**The goal: red means something changed that a person needs to look at.**

---

## Context

`web -> services -> data -> domain`. `domain/` imports nothing from the project.
All SQL lives in `server/data/`. **One runtime dependency (`libsql`) — do not add
another.** `libsql` is synchronous; `db.transaction()` throws against the remote
database; positional `?` parameters only; `LIMIT`/`OFFSET` inlined. `npm test`
runs against a local file and cannot catch remote-only behaviour.

---

## Task 1 — Classify failures instead of counting them

A scrape failure currently reaches `summary.failures` as a company name and a
string. Give it a `kind`, decided where the failure actually happens rather than
by matching on message text later — a classifier that greps error strings breaks
the first time someone rewords a message.

Four kinds:

| kind | meaning | example |
|---|---|---|
| `broken` | the adapter or the site did something unexpected | parse error, 500, timeout |
| `blocked` | the site refused us on purpose | 403, 429, bot protection |
| `empty` | the adapter ran fine and the company genuinely has no matching jobs | Snyk, Broadcom, Syneron-Candela |
| `refused` | the sanity gate rejected a suspicious result | Palo Alto |

`empty` is the one that needs care. The adapters throw on a zero result **on
purpose**, because a zero can equally mean "the facet lookup is wrong" — that
design is deliberate and documented, and must stay. What changes is that a
zero is reported as its own kind rather than as a breakage.

## Task 2 — Exit red only for something new

`main.js` should exit non-zero when a run contains a `broken` or `blocked`
failure, and zero when every failure is `empty` or `refused`. All of them still
print, and all are recorded in `scrape_runs` — this changes what is *shouted
about*, not what is *known*.

Two refinements, both of which stop a permanent condition from becoming
permanent noise:

**A `blocked` company that is already known about should not shout forever.**
Check Point blocks the GitHub runner's address, and that is not going to change
because an email said so eight more times. Add a `known_issue` column to
`watched_companies` holding the kind a human has already acknowledged (and,
usefully, when). A failure whose kind matches the recorded one prints but does
not turn the run red; a failure of any *other* kind still does. Acknowledging
"Check Point blocks us" must not silence "Check Point now returns garbage".

Add a small tool for setting it, alongside the existing
`tools/set-company-active.js`, so acknowledging is a deliberate act with a
recorded reason rather than a config edit nobody remembers.

**A `refused` verdict is fine once and alarming when it persists.** The sanity
gate refusing Palo Alto means the data was not trusted — correct. But if it
refuses on every run, PANW's listings are frozen at a number that may already be
wrong, and nobody is being told. Count consecutive refusals per company; after
three in a row (nine hours), promote it to a `broken` failure so it goes red.
Either the drop is real and the gate needs to accept it, or something is wrong —
both need a human.

## Task 3 — Let a real drop through

The gate currently has no way to accept a legitimate large drop. If Palo Alto
genuinely cut from 318 to 147, it will refuse forever.

Give it memory: **if two consecutive scrapes return closely matching low counts,
accept the drop.** A transient failure does not reproduce the same number three
hours later; a real reduction does. This keeps the protection the gate exists for
— a single broken scrape can still never mass-close a company — while letting
reality through in six hours instead of never.

Do not simply raise the 50% threshold. That weakens the guard everywhere to fix
one company.

## Task 4 — Say it plainly at the end

The summary should distinguish the four kinds, so the log answers "do I need to
do anything" without reading five error strings:

```
Done. 37 companies, 38 new jobs, 49 closed.
  2 companies with no matching jobs (expected): Snyk Israel, Broadcom Israel
  1 held back by the sanity gate: Palo Alto Networks Israel (1st refusal)
  1 blocked, already acknowledged: Check Point Israel
  0 broken
```

A run with nothing in the last two lines is a good run, and should be green.

---

## Constraints

- **No new dependencies.**
- **Do not make the adapters stop throwing on zero results.** That behaviour is
  deliberate — see the Snyk/Broadcom notes in `CLAUDE.md`. Classify the throw;
  do not remove it.
- **Do not weaken `evaluateSanityGate`'s threshold.** Task 3 adds memory, not
  tolerance.
- **Do not classify by matching error message text.** Set the kind where the
  failure occurs.
- Both `schema.sql` and the migration list in `server/data/schema.js` must gain
  any new column — one without the other is the bug that broke the first Turso
  deployment.
- Never commit `.env` or `jobtrail.db`. Windows shell.

## Definition of done

- `npm test` passes, with tests for: each kind being assigned correctly; a run of
  only `empty`/`refused` failures exiting zero; a `broken` failure exiting
  non-zero; an acknowledged `blocked` company not turning a run red while a
  *different* failure from that same company still does; three consecutive
  refusals escalating; and two consecutive matching low counts being accepted.
- A real scheduled run against Turso finishes **green**, with the four-line
  summary above.
- Check Point is acknowledged with a recorded reason, not silenced by deleting it.
- Palo Alto's situation is resolved one way or the other within two runs, and the
  log says which.

## Report back

Whether Palo Alto's drop turned out to be real — if the second run also returns
~147, that is the answer, and the site has been showing 318 jobs of which about
170 no longer exist.
