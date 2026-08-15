# JobTrail — be honest about password recovery

Paste everything below into Claude Code.

---

## Context

Read `CLAUDE.md` first. One runtime dependency (`libsql`); do not add another.
Layering is `web -> services -> data -> domain`, all SQL lives in
`server/data/`, and personal data goes through `requireUser`.

The site is live on Render against a hosted libSQL database (Turso).

Password reset by email is **built, tested and working** — the tokens, the
single-use enforcement, the session epoch, the rate limits, `client/reset.html`,
all of it. What it does not have is a way to actually deliver the mail.

That is a deliberate decision, not an oversight. Every transactional email
provider requires a postal address at signup, because anti-spam law requires one
to be associated with a bulk sender. The owner is a student and is not willing
to give a home address to an email vendor for a personal project. Sending is
therefore switched off, and `emailService` already falls back to logging the
link instead of sending it.

**The problem this creates:** `client/login.html` still offers **שכחתי סיסמה**.
A visitor clicks it, submits an address, is told a link has been sent, and
nothing ever arrives — the link went to a server log only the owner can read. A
form that promises delivery it cannot perform is worse than no form. The same
reasoning that switched registration off in the earlier demo deployment applies
here.

Three tasks. None of them delete the reset feature — it stays built, and turns
itself back on the moment a key exists.

---

## Task 1 — Hide the reset flow when mail cannot be sent

`emailService` already knows whether it is configured (it checks for the API
key before choosing between sending and logging). Expose that as a plain
boolean, and surface it to the client on `GET /api/session` alongside the
existing fields — the same pattern `demo` used before it was removed.

Then:

- Hide the **שכחתי סיסמה** link on `client/login.html` when mail is off.
- `client/reset.html` and the two `/api/password-reset/*` routes stay reachable,
  because a link the owner pulls from the log must still work. **The routes are
  not disabled — only the entry point is hidden.** Say so in a comment; a future
  reader will otherwise "tidy up" the unreachable-looking routes.
- In registration mode the hint already says there is no password reset. Make
  that unconditional and unmissable rather than a passing clause: someone
  choosing a password needs to know before they choose it, not after.

Do **not** gate this on a new environment variable. Deriving it from "is there
an API key" means adding the key is the only step needed to turn everything back
on — no second switch to remember, no way for the two to disagree.

---

## Task 2 — `tools/reset-password.js`, the escape hatch

The owner has something no visitor has: direct access to the database. That is
enough to recover any account without any email at all.

```bash
node tools/reset-password.js --email someone@example.com --password "a new one"
```

It must:

- Use the same `hashPassword` from `server/web/middleware/auth.js`. Not a second
  implementation — a hash written by a tool that disagrees with the verifier is
  an account that can never log in again.
- Enforce the same minimum length as registration, from the same source.
- Bump `session_epoch`, exactly as the email flow does. The reason is identical:
  a password is being changed, and any session held by anyone else must stop
  working at that moment.
- Work against whichever database the environment points at — local file by
  default, Turso when `TURSO_DATABASE_URL` is set. `server/data/connection.js`
  already resolves this; do not re-implement it.
- Refuse clearly when the email does not exist, listing nothing about which
  accounts do.
- Print what it changed, and warn that every existing session for that account
  is now invalid.

This is not a security hole: it requires database credentials, and anyone
holding those can already do anything. Say that in the file header, because it
otherwise looks like a backdoor.

---

## Task 3 — Fix `tools/set-password.js`, which now lies

It prints `JT_PASSWORD_HASH=...` and tells the user to put it in `.env`. Nothing
reads that variable any more — `auth.js` keys off `JT_SESSION_SECRET` alone, and
accounts moved into the `users` table when the project went multi-user (ADR-007).
Anyone following its instructions today gets a line that does nothing, and
concludes their login is broken for some other reason.

Either narrow it to what is still true — generating a `JT_SESSION_SECRET` — and
rename it to match, or delete it and fold that one line into `docs/DEPLOY.md`,
which already shows the `crypto.randomBytes` command. Prefer deleting: a tool
that does one thing a documented one-liner already does is a file to keep in
sync for no gain.

Check the rest of the docs for the same stale variable while you are there.

---

## Constraints

- **No new dependencies.**
- Do not delete or disable the password reset implementation. It is switched
  off at the entry point, and re-enables itself when a key appears.
- Do not add a second "is email enabled" switch. Derive it from the key.
- `libsql` is synchronous — don't `await` db calls. Its `.get()` returns a
  `_metadata` key that `connection.js` strips; don't reach past that.
- **Positional `?` parameters only**, never named `@name` ones — named
  parameters silently fail to bind against the remote database and turn every
  filtered query into an empty result. Same for `LIMIT`/`OFFSET`, which must be
  inlined as validated integers. See the comments in `server/data/jobs.js`.
- Never commit `.env`, `jobtrail.db`, or any API key.

## Definition of done

- `npm test` passes, with new tests for: the session endpoint reporting mail
  off; `reset-password.js` producing a hash the real verifier accepts; and the
  epoch bump invalidating an existing session.
- With no mail key set, `login.html` shows no reset link, and the registration
  screen states plainly that there is no recovery.
- With a key set, the link reappears with no other change.
- `node tools/reset-password.js --email <you> --password "..."` lets that
  account log in with the new password, against Turso as well as locally.
- No file or document mentions `JT_PASSWORD_HASH`.

## Report back

Confirm the reset routes are still reachable with the entry point hidden, and
say how you verified the tool's hash is accepted by the real login path rather
than merely looking correct.
