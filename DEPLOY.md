# Putting JobTrail on the internet

Two routes, and they produce different things.

| | **Render** (below) | **Fly.io** (further down) |
|---|---|---|
| Credit card | not required | required for identity, not charged |
| Accounts on the live site | no | yes |
| Persistent disk | none | 1 GB volume |
| Deploys by | pushing to GitHub | `fly deploy` |
| Sleeps when idle | yes, ~50 s to wake | yes, a few seconds |

Render is the free route, and the trade it makes is real: its free tier gives a
container with **no disk that survives a restart**. Listings can ship inside the
image, so the search works perfectly. Accounts cannot — so rather than offer a
registration form that takes a password and loses it, the deployment switches
accounts off and says why. The full version, tracking included, runs locally.

---

# Route A — Render (free, no credit card)

## Step 1 — build the demo database

The container has no disk, so the job listings travel inside the image.

```powershell
node tools/make-demo-db.js
```

It copies your database, empties every personal table (accounts, applications,
saved searches, notification history), runs `VACUUM` so deleted rows are not
merely marked free but actually overwritten, then reopens the file and verifies
the tables are empty before telling you it worked. If anything survives, it
deletes the file rather than leave one that is named as though it is safe.

Expect roughly 0.8 MB, and read its output — it lists exactly what it kept.

## Step 2 — put the repository on GitHub

```powershell
git add -A
git add -f demo.db          # -f because .gitignore excludes *.db
git commit -m "JobTrail: rate limiting, async hashing, public demo"
```

Create an empty repository on github.com, then:

```powershell
git remote add origin https://github.com/<your-username>/jobtrail.git
git branch -M main
git push -u origin main
```

Check that `.env` and `jobtrail.db` did **not** go up: `git ls-files | findstr /i "\.env jobtrail.db"` should print nothing.

## Step 3 — connect Render

1. [render.com](https://render.com) → sign up **with GitHub**. No card.
2. **New → Blueprint**
3. Pick the repository. Render finds `render.yaml` and reads the whole
   configuration from it — the Dockerfile, the region, every environment
   variable. Nothing to fill in by hand.
4. **Apply**, then wait. The first build compiles `better-sqlite3` from source
   and takes several minutes.

The address is `https://jobtrail.onrender.com` (Render appends a suffix if the
name is taken). Put it in the first line of `README.md`.

Every `git push` to `main` redeploys automatically.

## Refreshing the listings later

Render cannot scrape on its own — the container has nowhere to keep the result.
Re-run the scrape locally and push the new snapshot:

```powershell
node server/main.js
node tools/make-demo-db.js
git add -f demo.db && git commit -m "refresh demo data" && git push
```

## What to check once it is live

- The blue strip under the header explaining it is a demo
- `/robots.txt` and `/sitemap.xml` return plain text, not a download
- Filters, free-text search and paging all work
- The first visit after an idle hour takes ~50 seconds — that is the free tier
  waking up, not a fault

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

Three product gaps remain:

- **no email verification** — anyone can register with an address that isn't theirs
- **no password reset** — a forgotten password is a lost account, permanently
- **no privacy policy** — required by GDPR/Israeli privacy law once you hold other people's data

None of these block you from deploying. Password reset is the one that will bite
first, and it needs a custom domain before it can be built — a transactional
email provider has to verify DNS records you control, and `*.fly.dev` belongs to
Fly. See `ROADMAP.md`.

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

The first build takes a few minutes — it compiles `better-sqlite3` from C++
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
