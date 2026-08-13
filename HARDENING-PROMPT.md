# Job Tracker — hardening for a public deployment and a public repo

Paste everything below into Claude Code.

---

## Context

This is a Node project with **one runtime dependency: `better-sqlite3`**. Do not
add a second one. Everything here is achievable with `node:crypto`, `node:http`
and plain JavaScript, and "there's a well-known npm package for this" is not a
reason to reach for it.

Read `CLAUDE.md` first. The layering rules are real and enforced by review:

```
web  ->  services  ->  data  ->  domain
```

`domain/` imports nothing from the project. Nothing imports `web/`. All SQL
lives in `server/data/`.

The site is deployed on Fly.io (`fly.toml`, `Dockerfile`, `DEPLOY.md`) as a
**single machine** with `max_machines_running = 1`, because SQLite has one
writer. That constraint shapes Task 1 — read it before choosing a design.

The job search is public; anything personal requires a session. That boundary
lives in `PUBLIC_ROUTES` in `server/web/routes/index.js` and in
`resolveViewer`/`GUEST` in `server/data/tenancy.js`. Do not weaken it.

Two goals, in tension only occasionally:

1. The site accepts registrations from strangers and stores their passwords.
2. The repository is a portfolio piece that employers will read.

Where they conflict, prefer the honest version over the impressive one.

---

## Task 1 — Rate limiting on authentication

**The problem.** Nothing currently limits login attempts. An automated
credential-stuffing bot — the realistic attacker for a site like this, not a
targeted one — can try tens of thousands of leaked email/password pairs as fast
as the network allows. This is the single largest hole in the system.

Create `server/web/middleware/rateLimit.js` and apply it to `POST /api/login`
and `POST /api/register`.

### Design requirements

**Two independent counters, not one.**

- Per client IP
- Per submitted account identifier (the email in the request body)

Each alone is insufficient, and this is worth a comment in the file explaining
why: an IP-only limit is defeated by a botnet spreading attempts on one account
across thousands of addresses, and an account-only limit is defeated by one
machine spraying one common password across thousands of accounts. Trip either
counter and the request is refused.

**Getting the client IP right — this is the bug that will happen.**

On Fly, `req.socket.remoteAddress` is Fly's internal proxy, not the visitor.
Every request will appear to come from the same address, so the fifth failed
login **anywhere** would lock out **everyone**. Read the real address from the
`Fly-Client-IP` header, falling back to the leftmost entry of `X-Forwarded-For`.

But do not trust those headers unconditionally: any client can set them, and a
trusted `X-Forwarded-For` lets an attacker rotate a header value and bypass the
IP limit entirely. Only honour them when a `JT_TRUST_PROXY=1` environment
variable is set (add it to `fly.toml`, leave it unset locally). With it unset,
use the socket address. Write a test for both paths.

**Bounded memory.**

The naive implementation is a `Map` keyed by identifier, and it is a denial of
service: an attacker submitting a million distinct email addresses creates a
million entries and exhausts the machine's 512 MB. Cap the number of tracked
keys and evict expired entries; when the cap is reached with nothing expired,
prefer failing closed (refuse the request) over growing without limit. Test
this — send more distinct identifiers than the cap and assert memory is bounded
and behaviour is still correct.

**A sliding window, with an injectable clock.**

The limiter must take a `now()` function so tests can advance time instead of
sleeping. A test suite that sleeps for the window duration is a test suite
people stop running.

Suggested policy, adjust if you can argue for better: 5 failed attempts per
account per 15 minutes, 20 per IP per 15 minutes, registration capped at 3 per
IP per hour. **Successful logins should not consume the account budget** —
otherwise a legitimate user who signs in frequently locks themselves out.

**The response must not leak account existence.**

The rate limit response is identical whether or not the email belongs to a real
account. The existing login handler is already careful about this ("the server
deliberately does not say whether the email exists") — do not undo it by
rate-limiting known accounts differently from unknown ones.

Respond `429` with a `Retry-After` header in seconds. Add a Hebrew translation
of the message to `client/login.html`'s `ERROR_TRANSLATIONS` map, and make it
say when the user can try again — a lockout with no stated end is
indistinguishable from a broken site.

**In-memory is the correct choice here, and the comment should say why and when
it stops being correct.** With one machine there is nothing to share state
with, and a `rate_limits` table would add write load to the same SQLite file
that serves every search. The moment `max_machines_running` goes above 1, this
becomes wrong — each machine would enforce its own separate budget. Say so in
the file header.

---

## Task 2 — Make password hashing asynchronous, and raise its cost

**The problem.** `server/web/middleware/auth.js` uses `crypto.scryptSync` in
both `hashPassword` and `verifyPassword`. Node is single-threaded, and
`scryptSync` runs on the main thread for roughly 100 ms. Ten concurrent login
attempts freeze the entire server for about a second — no job searches, no
static files, nothing. The password-guessing attack from Task 1 is
simultaneously an availability attack, and neither symptom explains the other in
the logs.

### What to change

**Switch to the asynchronous `crypto.scrypt`**, promisified with
`util.promisify` or wrapped by hand. It runs on libuv's threadpool and does not
block the event loop. `hashPassword` and `verifyPassword` become `async`; trace
every caller (`server/services/userService.js` at minimum) and make them await.
The route handlers are already `async`, so this should not reach `web/`.

**Raise the work factor, but size it against the actual machine.** The current
default is N=2^14 (16384). OWASP suggests 2^17. Note that scrypt's memory cost
is roughly `128 * N * r` bytes — at N=2^17, r=8 that is ~134 MB *per concurrent
hash*, on a 512 MB VM. Node's default `maxmem` is 32 MB and will throw before
you get there, so `maxmem` must be set explicitly either way.

Benchmark it rather than guessing. Report the measured time per hash and pick
the highest cost that keeps a single login comfortably under ~250 ms on the
deployed machine size; N=2^16 with r=8, p=1 is a reasonable starting point given
the 512 MB limit and Task 1's cap on concurrency. **Document the number you
measured and the machine you measured it on** — a tuning constant with no
recorded justification is a magic number the next person is afraid to touch.

**Do not lock out existing accounts.** The stored format is currently
`salt:hash` with implicit default parameters. Once the parameters change, they
must be stored alongside the hash or old passwords can never be verified again.
Move to a self-describing format:

```
scrypt$<N>$<r>$<p>$<salt>$<hash>
```

and have `verifyPassword` detect the legacy `salt:hash` shape (no `$`) and
verify it with the old parameters. Write a test that verifies a
legacy-format hash still succeeds — this is the change most likely to silently
destroy every existing account, and the test is the only thing standing between
you and finding out in production.

Optionally re-hash a legacy password to the new format on successful login,
since that is the one moment the plaintext is available.

Keep `crypto.timingSafeEqual`. Keep the length check before it.

### The measurement worth keeping

Write `tools/bench-auth.js` that measures **maximum event-loop delay** while
hashing N passwords concurrently, and report the before/after numbers. Use
`perf_hooks.monitorEventLoopDelay`.

This is the most interesting artifact in the whole task. Put the two numbers in
a comment above the changed function and in the README — a tuning decision with
a measurement behind it reads completely differently from one without.

---

## Task 3 — Make the repository legible to someone giving it 30 seconds

The code is strong (roughly 3,900 lines of server code against 3,100 lines of
tests) and the repository does not currently show it.

**Add screenshots to the README.** There are none, for a project whose whole
point is a user interface. Create `docs/` and add the markup for two images —
the job search page with real results, and the application tracker — with
descriptive alt text. You cannot take the screenshots yourself: leave the
`![...](docs/search.png)` references in place and tell the user exactly which
two files to save and where. Do not fabricate placeholder images.

**Put the live URL in the first paragraph**, once it is deployed.

**Add a short "What this demonstrates" section** near the top: the adapter
registry (a new career-site platform is one file and no changes anywhere else),
the tenancy guard that turns a forgotten `WHERE user_id` into a crash, the
pagination fix and the cross-account join bug it uncovered, and the fact that
dead ends are documented rather than hidden. Three or four lines. State it
plainly; do not oversell it.

---

## Task 4 — Reframe `IMPROVEMENT-PROMPT.md` as `ROADMAP.md`

The content is good and the framing is wrong for a public repository: it is
written as instructions to an AI ("Task 3 — build X"), and a human reader
encounters a file that reads like a work order rather than an assessment.

Rename it to `ROADMAP.md` and rewrite the headings and framing so each entry
describes a **known limitation and its intended fix**, addressed to a person.
Same content, same honesty about what is missing — "notifications are printed to
the console; the outbox design is in ARCHITECTURE.md §4.5" is a strength, not
something to hide. Mark Task 1 (pagination) as done, and record the
out-of-range-page bug found afterwards:

> Requesting a page beyond `totalPages` currently returns the last page's rows
> instead of an empty list, so a "next" click at the end silently repeats
> content. Fix: sanitize the page number, never substitute it.

Leave `CLAUDE.md` where it is. It is an accurate architecture summary and
AI-assisted development is not something to conceal.

---

## Constraints

- **No new dependencies.** Not for rate limiting, not for anything here.
- **Respect the layering.** The rate limiter is `web/` middleware; it does not
  touch SQL and does not import from `data/`.
- **Do not weaken the public/private boundary** established in `PUBLIC_ROUTES`
  and `tenancy.js`. Guests read jobs; personal data needs a session.
- **Never commit `.env`, `jobtracker.db`, or `data/manual/*.json`.** Git history
  is currently clean of all three — keep it that way.
- Development is on **Windows**; do not assume bash-only shell syntax in
  anything a user runs.
- `better-sqlite3` is **synchronous** — never `await` a db call.

## Definition of done

- `npm test` passes, with new tests covering: the window opening and closing on
  an injected clock; per-IP and per-account limits tripping independently; the
  key cap holding under a flood of distinct identifiers; `JT_TRUST_PROXY` both
  set and unset; and a legacy `salt:hash` password still verifying after the
  format change.
- `node tools/bench-auth.js` prints a before/after event-loop delay, and the
  numbers appear in the README.
- Logging in five times with a wrong password returns `429` with a
  `Retry-After`, and `client/login.html` shows a Hebrew message stating when the
  user may retry.
- A sixth attempt against a **different** account from the same IP still
  succeeds if that IP is under its own limit — proving the two counters are
  genuinely independent and not one counter with two names.
- The README opens with what the project is, a live link, and two screenshots.
- `ROADMAP.md` exists; `IMPROVEMENT-PROMPT.md` does not.

## What NOT to build

**SMS one-time codes.** They were considered and rejected, and the reasoning
belongs in `ARCHITECTURE.md` as an ADR rather than in a commit message:

- Every message costs real money (~₪0.15 in Israel) and an unauthenticated
  "send me a code" endpoint hands an attacker a button that spends it. A
  password guess costs CPU; an SMS costs currency.
- It does not remove the need for rate limiting — it makes it urgent, because
  the failure mode is now a bill.
- SMS is the weakest available authentication factor. SIM-swap attacks are
  routine and NIST no longer recommends it as a standalone authenticator.
- A phone number is personally identifying information, which increases privacy
  obligations rather than reducing them.

**Email one-time codes / password reset — worth building, but not yet.**
Transactional email providers require a domain you control DNS for, and
`*.fly.dev` belongs to Fly. This becomes the next real piece of work *after* a
custom domain is bought, and it solves email verification and password reset
with one mechanism. Note it in `ROADMAP.md`; do not start it now.

Write the ADR for both decisions. Knowing what not to build, and being able to
say why, is the part of this project worth showing.
