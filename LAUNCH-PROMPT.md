# JobTrail — everything that stands between here and a link you can share publicly

Paste everything below into Claude Code.

---

## Context

Read `CLAUDE.md` first. Three rules shape all of this:

```
web  ->  services  ->  data  ->  domain
```

`domain/` imports nothing from the project. Nothing imports `web/`. All SQL
lives in `server/data/`.

**One runtime dependency: `libsql`.** Do not add a second one. Everything below
is achievable with `node:crypto`, `node:http` and plain JavaScript.

The site is live on Render, backed by a hosted libSQL database (Turso), with
accounts on. It works. This is about the gap between "works" and "safe to point
strangers at".

### Three ways this deployment differs from a local file — all found the hard way

Against the remote database, code that passes every test can still fail. Do not
reintroduce any of these, and check new code against all three:

1. **`db.transaction()` throws.** BEGIN and COMMIT are separate stateless HTTP
   requests. Use a conditional `UPDATE ... WHERE <still unclaimed>` and order the
   statements so a crash between them fails safe. See `passwordResets.js`.
2. **Named `@parameters` silently do not bind**, turning every filtered query
   into `column = NULL` and an empty result — no error. Positional `?` only.
3. **`LIMIT`/`OFFSET` must be inlined** as validated integers; a JS number
   arrives as a float and SQLite raises "datatype mismatch". See
   `limitClause()` in `jobs.js`.

The test suite runs against a local file and **cannot catch these**. Verify
anything database-shaped by running the server against Turso:

```powershell
$env:TURSO_DATABASE_URL="libsql://..."; $env:TURSO_AUTH_TOKEN="..."
node server/web/server.js
```

---

## Task 1 — Confirm the scheduled scrape actually runs

**The highest-priority item, because the failure is silent and the damage
compounds.** A job board showing last month's listings is worse than no job
board: people apply to roles that closed weeks ago, and nothing on the page
admits the data is old.

`.github/workflows/scrape.yml` exists and runs `node server/main.js` twice a
day against Turso. Verify end to end:

- The workflow file is committed and on the default branch.
- It has run at least once. If it never has, say so plainly — it needs
  `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` added as **repository secrets**
  (Settings → Secrets and variables → Actions), which only the owner can do.
- `main.js` exits non-zero when an adapter fails, so a broken scraper turns the
  run red rather than leaving stale rows looking current. Confirm that still
  holds after every change since.

**Then make staleness visible in the product**, because a workflow can be
disabled — GitHub switches off scheduled runs in a repository with no activity
for 60 days, and the site would go on serving old data confidently.

Add a `scrape_runs` table (started, finished, companies, new jobs, failures) and
show the last successful run on the search page: "עודכן לפני 3 שעות". When the
newest successful run is older than 48 hours, say so prominently instead of
quietly. **A visible timestamp is what turns a silent failure into an obvious
one**, and it costs one row per run.

---

## Task 2 — A privacy policy, and a real deletion path

This is a legal requirement, not a nicety. The site stores other people's email
addresses and password hashes on a server in Frankfurt; the Israeli Privacy
Protection Law and the GDPR both apply, and both start applying at the first
user who is not the owner.

Create `client/privacy.html`, in Hebrew, linked from the footer of every page
and from the registration screen. Written plainly — a policy nobody can read
satisfies a lawyer and nobody else. It must state honestly:

- **What is collected:** email address, a scrypt hash of the password (never the
  password), which jobs were marked as applied to, and when. No analytics, no
  tracking, no third-party scripts — confirm that is still true before writing
  it down.
- **Where it lives:** a hosted libSQL database (Turso) in the EU, served from
  Render in Frankfurt.
- **What it is used for:** operating the site. It is not sold, shared, or used
  for marketing.
- **Job listings are not personal data** — they are collected from companies'
  own public career pages.
- **Rights:** access, correction, deletion.
- **What is missing:** no email verification, no password recovery. Say it here
  too. Someone deciding whether to register deserves to know before they choose
  a password they cannot recover.
- A contact address for exercising those rights.

**A policy promising deletion needs deletion to exist.** Build it:

- `DELETE /api/account`, requiring the current password — deletion is
  irreversible and must not be reachable by a hijacked session alone.
- Removes the `users` row and every `applications` / `search_profiles` /
  `password_resets` / `email_confirmations` row belonging to it. Shared tables
  (`job_snapshots`, `watched_companies`) are untouched: they are not personal.
- No `db.transaction()` — order the deletes children-first so an interruption
  leaves no orphan pointing at a deleted account.
- A settings screen with a confirmation step that requires typing the account's
  email, not a checkbox. Then sign out.
- Tests: deletion removes exactly that account's rows and nothing of a second
  account's — extend `tests/tenancy.test.js` rather than starting a new pattern.

---

## Task 3 — Stop promising password recovery that cannot be delivered

Mail sending is deliberately off: every transactional email provider requires a
postal address at signup, and the owner is not willing to give a home address to
an email vendor for a student project. `emailService` already logs the link
instead of sending it.

`login.html` still offers **שכחתי סיסמה**. A visitor clicks it, is told a link
was sent, and nothing ever arrives — it went to a server log only the owner can
read. That is the same failure the demo deployment switched registration off to
avoid.

- Expose whether mail is configured on `GET /api/session`, derived from the
  presence of the API key. **No second switch** — adding the key must be the
  only step that turns everything back on.
- Hide the reset link when mail is off. **Keep the routes and `reset.html`
  reachable**, because a link pulled from the log must still work; leave a
  comment saying so, or someone will delete them as dead code.
- Make "there is no password recovery" unmissable on the registration screen,
  before a password is chosen — not a clause after it.
- Build `tools/reset-password.js --email x --password y`: the owner's escape
  hatch, using the same `hashPassword` the verifier uses (a second
  implementation is an account that can never log in), enforcing the same
  minimum length, bumping `session_epoch`, and working against whichever
  database the environment points at. It requires database credentials, so it is
  not a backdoor — say that in the header.

Also: `tools/set-password.js` prints `JT_PASSWORD_HASH`, which nothing has read
since accounts moved into the `users` table (ADR-007). Delete it — `docs/DEPLOY.md`
already shows the one `crypto.randomBytes` line that is still true — and remove
every remaining mention of that variable.

---

## Task 4 — Two things a first-time visitor gets wrong

Both were found by watching a real person use the site.

**The apply link does not look like a link.** The job title *is* the link, but
`.job-title a` is `color: var(--text); text-decoration: none` and only reveals
itself on hover. On a phone there is no hover at all — no visual cue that the
single most important action on the site is clickable. Give it a permanent
affordance, or add an explicit "הגשת מועמדות" control to the card. Whatever you
choose must be obvious without a pointing device.

**Page one is entirely one company.** Sorting by `first_seen_at DESC` is
correct, but the last company scraped occupies the whole first page, and a
visitor concludes the site tracks one employer. Once Task 1's scheduled scrape
has run across all companies the timestamps interleave and this largely resolves
itself — so **check whether it is still true before changing the sort**. If it
is, prefer the smallest honest fix (a tiebreaker that interleaves companies
within the same scrape batch) over abandoning newest-first, which is the right
default.

---

## Constraints

- **No new dependencies.**
- Respect the layering. Deletion is `data/` + a thin route; the privacy page is
  static; `domain/` gains nothing here.
- Reuse `rateLimit.js` for any new public route — do not write a second limiter.
- Do not weaken the guest/member boundary in `PUBLIC_ROUTES` and `tenancy.js`.
- Never commit `.env`, `jobtrail.db`, or any API key. Git history is clean of
  all of them.
- New secrets go in `render.yaml` as `sync: false`, never as values.
- Development is on **Windows** — no bash-only syntax in anything a user runs.
- `libsql` is synchronous. Don't `await` db calls.

## Definition of done

- `npm test` passes, including: account deletion removing exactly one account's
  rows; the session endpoint reporting mail off; `reset-password.js` producing a
  hash the real login path accepts; and staleness detection at the 48-hour
  boundary.
- The search page shows when the data was last refreshed, and says so loudly
  when that is more than two days ago.
- `client/privacy.html` exists, is linked from every page, and every claim in it
  is true of the code as committed.
- A registered account can delete itself, and afterwards cannot log in.
- With no mail key, no reset link is offered anywhere, and the registration
  screen says there is no recovery.
- The apply action is visibly clickable without hovering.
- Nothing mentions `JT_PASSWORD_HASH`.

## Report back

Whether the scheduled scrape has genuinely ever run, or whether it is waiting on
repository secrets the owner has to add — this one matters more than the rest
and is the easiest to assume is fine.

For the privacy policy, list any claim you could not verify against the code, so
it can be corrected rather than published as an assumption.
