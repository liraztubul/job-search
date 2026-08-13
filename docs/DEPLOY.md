# Putting JobTrail on the internet

Two routes. Both are free and both keep accounts; they differ in where the
database sits and what you have to hand over to get it.

| | **Render + Turso** (below) | **Fly.io** (further down) |
|---|---|---|
| Credit card | never asked for | required for identity, not charged |
| Database lives | Turso's servers | a volume on your own app |
| Deploys by | pushing to GitHub | `fly deploy` |
| Sleeps when idle | yes, ~50 s to wake | yes, a few seconds |

Render's free tier gives a container with **no disk that survives a restart**,
so nothing may be stored inside it. The database is therefore hosted: Turso runs
libSQL, which is SQLite, and `libsql` speaks to it with the same synchronous API
that opens a local file. Nothing in `server/data/` knows the difference.

---

# Route A — Render + Turso (free, no credit card)

## Step 1 — regenerate the lockfile

The driver changed from `better-sqlite3` to `libsql`, and `package-lock.json`
still names the old one. The Docker build runs `npm ci`, which fails outright
when the lockfile and `package.json` disagree — better than installing the
wrong thing, but it fails at build time rather than here.

```powershell
npm install
```

## Step 2 — create the database

1. [turso.tech](https://turso.tech) → sign up with GitHub. No card, no payment screen.
2. Create a database. Any name; the region closest to Frankfurt keeps it near
   the Render container.
3. Copy two values from its page: the **database URL** (`libsql://...`) and a
   **token**.

## Step 3 — push your listings up

A new database is empty, and an empty database looks exactly like a broken one.

```powershell
$env:TURSO_DATABASE_URL="libsql://your-db.turso.io"
$env:TURSO_AUTH_TOKEN="..."
node tools/push-to-turso.js
```

It applies the schema and copies companies and jobs. It never copies accounts,
applications or saved searches in either direction — those belong to whoever
created them, on whichever database they used.

Re-run it any time after a local scrape to refresh the listings.

## Step 4 — push the code

```powershell
git add -A
git commit -m "Store data in a hosted libSQL database so accounts persist"
git push
```

Check nothing personal went with it — this should print nothing:

```powershell
git ls-files | findstr /i ".env jobtrail.db jobtracker.db"
```

## Step 5 — give Render the three secrets

`render.yaml` marks them `sync: false`, so Render will prompt for each one
rather than read it from the public repository.

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

| Variable | Value |
|---|---|
| `JT_SESSION_SECRET` | the string just printed |
| `TURSO_DATABASE_URL` | `libsql://...` from step 2 |
| `TURSO_AUTH_TOKEN` | the token from step 2 |

`JT_SESSION_SECRET` is what turns accounts on. Without it the server refuses
registration and runs as a single account. Keep a copy: changing it later
invalidates every session cookie and signs everyone out.

Then **Apply** / **Manual Deploy**.

## What to check once it is live

- The log says `Using hosted database at libsql://...` and then a job count
- Register an account, mark a job as applied
- **Wait for the service to sleep, then load it again and log back in.** The
  application is still there. That single check is the whole point of this
  route — everything else worked on the previous deployment too.
- `/robots.txt` and `/sitemap.xml` return plain text, not a download

---

# Route B — Fly.io (accounts, a real volume, card required)

Everything below runs on **Fly.io**. Roughly 20 minutes the first time, about
40 seconds for every deploy after that.

---

## Before you start: read this part

The site will accept registrations from strangers, and their passwords will be
stored in your database.

**Login rate limiting is now in place** (`server/web/middleware/rateLimit.js`):
five wrong passwords per account per 15 minutes, twenty per IP, three
registrations per IP per hour. That was the only item on this list that was a
security hole rather than a missing feature.

**Password reset and registration email confirmation are both built** —
`server/services/verificationService.js`, sent through Brevo
(`server/services/emailService.js`). Set `BREVO_API_KEY` and `JT_MAIL_FROM`
(see that file's header for the two-minute setup: no custom domain needed,
just verifying one sender mailbox) or leave them unset and the reset/confirm
links print to the server log instead — the whole flow is testable with no
account at any provider.

One product gap remains: **no privacy policy** — required by GDPR/Israeli
privacy law once you hold other people's data. Doesn't block deploying, but
should happen before real strangers register. See `ROADMAP.md`.

---

## Step 1 — install the Fly CLI

PowerShell:

```powershell
iwr https://fly.io/install.ps1 -useb | iex
```

Close and reopen PowerShell, then:

```powershell
fly auth signup     # or: fly auth login
```

Fly asks for a credit card even on the free allowance. It is used for identity
verification; the configuration in `fly.toml` (one shared-cpu machine, 512 MB,
`auto_stop_machines`) sits inside the free tier.

## Step 2 — pick a name nobody has taken

`fly.toml` already sets:

```toml
app = "jobtrail"
```

That name becomes your address: `https://jobtrail.fly.dev`. If it's
already taken by someone else on Fly, change it here — and keep the link in
`README.md` in sync with whatever you pick.

## Step 3 — create the app and its disk

```powershell
cd C:\Users\liraz\Downloads\job-tracker\job-tracker

fly launch --no-deploy --copy-config --name jobtrail --region cdg
fly volumes create jobtrail_data --size 1 --region cdg
```

The volume is the part people forget. A Fly machine's own filesystem is
recreated from the image on every deploy — anything written to it is gone.
`fly.toml` mounts this volume at `/data` and `JT_DB_PATH` points the database
there, so accounts and saved applications survive a deploy.

**The region must match.** A volume in `cdg` and a machine in `iad` will not
find each other.

## Step 4 — set the session secret

This is what turns accounts on. Without it the server runs in single-account
mode and registration is refused.

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Copy the output and:

```powershell
fly secrets set JT_SESSION_SECRET=<paste it here>
```

Keep a copy somewhere safe. Changing this value later signs everyone out —
sessions are validated against it, so old cookies stop verifying.

It is a *secret*, not an environment variable in `fly.toml`: `fly.toml` goes
into git, and anyone holding this string can forge a session cookie for any
account.

## Step 5 — deploy

```powershell
fly deploy
```

The first build takes a few minutes — it compiles `libsql` from C++
source inside the container, which is exactly why there's a Dockerfile instead
of letting Fly guess. After that, layer caching makes it fast.

```powershell
fly open        # opens the site
fly logs        # if something looks wrong
```

## Step 6 — put some jobs in it

A fresh volume is an empty database.

```powershell
fly ssh console
cd /app
node server/seed.js
node server/main.js
exit
```

`main.js` runs one full scrape. Expect real job titles from real companies in
the output — "no errors thrown" is not the same thing.

## Step 7 — register your account

Open the site, click **התחברות** in the top-left, then **אין לי חשבון — הרשמה**.

The first account you create is a normal account like any other. Applications
you tracked locally are not transferred — that data is in the `jobtrail.db`
file on your laptop, and the server has its own.

---

## Getting into Google

Being online does not put you in Google. Two things have to be true, and the
second one takes time.

**Submit the site.** Go to [Google Search Console](https://search.google.com/search-console),
add `https://your-app.fly.dev` as a URL-prefix property, verify it with the
HTML-tag method (paste the tag into `client/index.html`'s `<head>`, redeploy),
then submit `https://your-app.fly.dev/sitemap.xml`.

**Then wait.** Indexing a brand-new site takes days to several weeks. Nothing
you can do speeds it up meaningfully.

### The honest limitation

Searching Google for *"JobTrail liraz"* will find you. Searching for
*"משרת סטודנט אינטל חיפה"* will not — and that gap is structural, not a
settings problem.

Google indexes URLs. Right now this site has one indexable URL: the search
page. The 2,128 jobs arrive by `fetch()` *after* the page loads and never get
their own address, so from a crawler's point of view the site contains one page
that says "JobTrail" and nothing else.

Making job searches findable means giving each job a real URL that the server
renders into HTML — `/job/12345` returning a page with the title, company and
location already in the markup. That is a genuine feature, not a checkbox, and
it's the thing to build if being found through job searches is the goal.

### The other honest limitation

The listings are copied from other companies' career pages. Google actively
demotes sites whose content is a copy of a canonical source elsewhere. A job
aggregator competing with the company's own posting for the same words tends to
lose. That's not a reason to skip SEO — it's a reason not to expect the site to
outrank intel.com for Intel's own job title.

---

## Everyday commands

```powershell
fly deploy                    # ship a change
fly logs                      # what the server is saying
fly ssh console               # a shell inside the running machine
fly status                    # is it up?
fly secrets list              # which secrets are set (not their values)
fly apps destroy <name>       # tear the whole thing down
```

## Backing up the database

There is one copy of it, on one volume. Fly snapshots volumes daily, but
pulling a copy down yourself takes one command:

```powershell
fly ssh sftp get /data/jobtrail.db ./backup-jobtrail.db
```

Worth doing before any deploy that changes `schema.sql`.

## Two things that will bite

**Scraping does not run by itself.** `main.js` is one cycle, triggered by hand.
Until there's a scheduler, the job list is as fresh as the last time you ran it
over SSH.

**`min_machines_running = 0` means the first visit after an idle period is
slow.** The machine stops when nothing is using it and takes a few seconds to
wake. Setting it to 1 removes the delay and costs money. For a site that is
mostly you, the delay is the better trade.
