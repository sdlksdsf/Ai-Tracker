# Deploying PlateMatch — step by step

This guide puts PlateMatch on the internet using five free services. You do
everything in their websites ("dashboards") — no command line needed.

```
   Visitor's browser
          │
          ▼
  ┌───────────────┐   API calls    ┌────────────────┐
  │    Vercel     │ ─────────────► │     Render     │
  │  the website  │                │    the API     │
  │ (apps/mobile) │                │ (packages/api) │
  └───────────────┘                └───────┬────────┘
                                           │
                 ┌─────────────────────────┼───────────────────────┐
                 ▼                         ▼                       ▼
          ┌─────────────┐          ┌──────────────┐        ┌──────────────┐
          │    Neon     │          │   Upstash    │        │  Cloudinary  │
          │  database   │          │ Redis cache  │        │ photo storage│
          └─────────────┘          └──────────────┘        └──────────────┘
```

The repository already contains everything the services need:

| File                      | What it does                                                    |
| ------------------------- | --------------------------------------------------------------- |
| `render.yaml`             | Tells Render how to build, start and health-check the API       |
| `apps/mobile/vercel.json` | Tells Vercel how to build and serve the website                 |
| `packages/api/drizzle/`   | Database migrations — applied automatically when the API starts |

---

## Before you start

### Accounts you need (all free, no credit card)

| Service        | What it is for                               | Sign up                                                  |
| -------------- | -------------------------------------------- | -------------------------------------------------------- |
| **GitHub**     | Holds the code; the others read it from here | you already have it                                      |
| **Neon**       | PostgreSQL database                          | https://neon.com — "Sign up with GitHub"                 |
| **Upstash**    | Redis (cache and rate limits)                | https://upstash.com — "Sign up with GitHub"              |
| **Cloudinary** | Stores photos people upload                  | https://cloudinary.com — free plan                       |
| **Render**     | Runs the API                                 | https://render.com — "Sign up with GitHub"               |
| **Vercel**     | Hosts the website                            | https://vercel.com — "Continue with GitHub" (Hobby plan) |

### Three rules for secrets

Some values below are **secrets** (passwords inside connection strings, API
secrets). Anyone who has them can read or delete your data.

1. **Copy them straight from one dashboard into the other.** Keep the provider's
   tab open and paste directly into Render. Don't put them in chat, email,
   documents or screenshots.
2. **Never put them in the code.** No file in this repository should ever contain
   one; `.env` files are already ignored by Git.
3. **If one leaks, rotate it** — every provider has a "reset password / regenerate
   key" button — then paste the new value into Render.

### Pick one region and use it everywhere

The API talks to the database on every request, so they must be close together.
This guide uses **Singapore** for all three (closest for South Asia):

| Service | Choose                                            |
| ------- | ------------------------------------------------- |
| Neon    | AWS · Asia Pacific 1 (Singapore)                  |
| Upstash | AWS · ap-southeast-1 (Singapore)                  |
| Render  | already set: `region: singapore` in `render.yaml` |

Most of your users in Europe? Use Frankfurt instead (Neon: AWS Europe Central 1,
Upstash: eu-central-1) **and** change `region: singapore` to `region: frankfurt`
in `render.yaml` before Step 4 — Render cannot move a service later.

---

## Step 0 — Make sure the code is on `main`

Render and Vercel deploy the `main` branch. If these deployment changes are still
in a pull request, open it on GitHub and click **Merge pull request**.

✅ **Check:** on GitHub, the `main` branch shows the files `render.yaml` and
`apps/mobile/vercel.json`.

---

## Step 1 — Database: Neon

1. Sign in to https://console.neon.tech and click **New project**.
2. Fill in:
   - **Project name:** `platematch`
   - **Postgres version:** leave the default (17)
   - **Region:** AWS · Asia Pacific 1 (Singapore)
3. Click **Create project**.
4. On the project dashboard click **Connect**.
5. In the dialog, **turn off "Connection pooling"**. (The direct connection is the
   one Neon recommends for database migrations, which the API runs when it starts.)
6. Copy the connection string. It looks like:
   `postgresql://neondb_owner:••••••@ep-something-123456.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require`

✅ **Check:** the string starts with `postgresql://` and contains `sslmode=require`.
Keep this tab open — you will paste it in Step 4.

---

## Step 2 — Redis: Upstash

1. Sign in to https://console.upstash.com, open **Redis**, click **Create Database**.
2. Fill in:
   - **Name:** `platematch`
   - **Primary region:** AWS · ap-southeast-1 (Singapore)
   - **Plan:** Free
   - Leave **Eviction** off.
3. Click **Create**.
4. On the database page, find the **Connect** section, choose the **TCP** (or
   "ioredis") tab, reveal the password (eye icon) and copy the URL. It looks like:
   `rediss://default:••••••@good-name-12345.upstash.io:6379`

✅ **Check:** it starts with **`rediss://`** — two **s**, meaning encrypted. Keep this tab open.

> Why this app stays inside the free 500,000 commands/month: background jobs run
> inside the API (`QUEUE_DRIVER=memory` in `render.yaml`) instead of polling Redis
> around the clock — measured: ~0 commands a minute while idle, versus ~490 with
> the job queue on Redis.

---

## Step 3 — Photo storage: Cloudinary

1. Sign up at https://cloudinary.com (free plan) and open the **Console**.
2. Click **Settings** (gear icon) → **API Keys**.
3. You need three values from this page. Keep it open:
   - **Cloud name** (e.g. `dabc12345`)
   - **API Key** (a long number)
   - **API Secret** — click the **eye icon** first; copying the dots copies nothing useful.

✅ **Check:** you can see the API Secret in plain text (letters, digits, `-` or `_`).

---

## Step 4 — API: Render

1. Sign in to https://dashboard.render.com.
2. Click **New** → **Blueprint**.
3. Connect your GitHub account if asked, and give Render access to the
   **Ai-Tracker** repository.
4. Select the repository. Render reads `render.yaml` and shows one service,
   **platematch-api** (plan: Free).
5. Render now asks for the values marked secret in `render.yaml`. Paste:

   | Field                   | Paste                                                                   |
   | ----------------------- | ----------------------------------------------------------------------- |
   | `CORS_ORIGINS`          | `https://platematch.vercel.app` for now — you will correct it in Step 6 |
   | `DATABASE_URL`          | the Neon connection string from Step 1                                  |
   | `REDIS_URL`             | the Upstash `rediss://` URL from Step 2                                 |
   | `CLOUDINARY_CLOUD_NAME` | Cloud name from Step 3                                                  |
   | `CLOUDINARY_API_KEY`    | API Key from Step 3                                                     |
   | `CLOUDINARY_API_SECRET` | API Secret from Step 3                                                  |

   The sign-in secrets (`JWT_SECRET`, `JWT_REFRESH_SECRET`) and the demo
   account's password are generated by Render automatically — you never see or
   type them.

6. Click **Deploy Blueprint** (sometimes labelled **Apply**).
7. Open the **platematch-api** service and watch **Events/Logs**. The first build
   takes about 3–5 minutes. When it is live, the logs contain:
   - `Applied 1 database migration(s)` — the database tables were created
   - `Deployment configuration … "storage":"cloudinary","cache":"redis"`
   - `PlateMatch API listening`
8. Copy the service address shown at the top of the page, e.g.
   `https://platematch-api.onrender.com` (Render may add a few letters to make it unique).

✅ **Check:** open these two addresses in your browser (put your own address in front):

| Open                         | You should see                                     |
| ---------------------------- | -------------------------------------------------- |
| `…onrender.com/health/ready` | `{"ready":true,"database":"ok","cache":"redis",…}` |
| `…onrender.com/health`       | `…"storage":"cloudinary"…`                         |

If the deploy failed, the logs say exactly which setting is wrong — see
[Troubleshooting](#troubleshooting).

---

## Step 5 — Website: Vercel

1. Sign in to https://vercel.com and click **Add New…** → **Project**.
2. Find **Ai-Tracker** under "Import Git Repository" and click **Import**
   (allow Vercel to access the repository if asked).
3. On the "Configure Project" screen:
   - **Project Name:** `platematch` (this becomes `platematch.vercel.app` if the name is free)
   - **Root Directory:** click **Edit** and choose **`apps/mobile`** ← important
   - **Framework Preset:** leave it as **Other** — `vercel.json` sets the build for you
   - **Environment Variables:** add one:

     | Key                   | Value                                                                                              |
     | --------------------- | -------------------------------------------------------------------------------------------------- |
     | `EXPO_PUBLIC_API_URL` | your Render address from Step 4, e.g. `https://platematch-api.onrender.com` — nothing after `.com` |

     This one is **not** a secret: it is built into the website, so anyone can read
     it. Never put a real secret in an `EXPO_PUBLIC_…` variable.
4. Click **Deploy** and wait about 3 minutes.
5. Open the project's **Domains** (or the "Visit" button) and copy the
   production address, e.g. `https://platematch.vercel.app`.

✅ **Check:** the build log contains
`✔ EXPO_PUBLIC_API_URL = https://…onrender.com (baked into this build)`, and the
address opens the PlateMatch sign-in screen.

---

## Step 6 — Let the website talk to the API (CORS)

Browsers only let a website call an API that names it as allowed.

1. In Render, open **platematch-api** → **Environment**.
2. Edit **`CORS_ORIGINS`** and paste your exact Vercel address from Step 5, e.g.
   `https://platematch.vercel.app` — starting with `https://`, no `/` at the end.
3. Click **Save** and choose **Save and deploy**. Wait until the service is live again.

✅ **Check:** open the website, **Create account**, sign in, then refresh the
page — you should stay signed in.

> Want Vercel preview deployments to work too? Use a comma-separated list:
> `https://platematch.vercel.app,https://platematch-*-yourteam.vercel.app`
> (a `*` matches one word made of letters, digits and dashes).

---

## Step 7 — Final check

1. On the website, open **Scan**, choose **Pick from library**, and upload any photo.
   Then in Cloudinary open **Media Library** → folder **platematch/scans** — the
   photo is there. (Without an AI key the scan finds 0 items; that is expected.)
2. Run the automatic check: on GitHub open **Actions** → **Deploy check** →
   **Run workflow**, enter your Render and Vercel addresses, and click **Run**.
   Every line should be a ✓. Each ✗ comes with the fix.

🎉 You're deployed. Every push to `main` now redeploys automatically: Render when
the API changes, Vercel when the website changes.

---

## Troubleshooting

| What you see                                                                        | Cause                                                                                        | Fix                                                                                      |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Website: "No internet connection" / browser console says **blocked by CORS policy** | `CORS_ORIGINS` on Render does not exactly match the website address                          | Step 6. Render's logs name the blocked address: `CORS: blocked a browser request from …` |
| Vercel build fails: **Web build stopped: EXPO_PUBLIC_API_URL needs fixing**         | The variable is missing, not `https://`, or has a path                                       | Vercel → Settings → Environment Variables → fix it → Deployments → ⋯ → **Redeploy**      |
| Website loads but every action fails, the API was fine                              | Website built before `EXPO_PUBLIC_API_URL` was set or changed — it is baked in at build time | Redeploy on Vercel after changing it                                                     |
| Render deploy fails: **Refusing to start in production:** followed by a list        | A required setting is missing or malformed — each line says which one                        | Render → Environment → fix → Save and deploy                                             |
| Render logs: **Cannot reach PostgreSQL** / `password authentication failed`         | Wrong `DATABASE_URL`                                                                         | Copy it again from Neon → Connect                                                        |
| `/health/ready` shows `"cache":"down"`                                              | Wrong `REDIS_URL` (logs show `WRONGPASS` or connection errors)                               | Copy the `rediss://` URL again from Upstash, password revealed                           |
| Uploads fail; logs say **Cloudinary rejected the credentials**                      | API key/secret copied wrong (often the masked `••••`)                                        | Step 3, reveal the secret, paste again                                                   |
| First visit after a while takes ~1 minute                                           | The free Render instance was asleep (after 15 minutes without visitors)                      | Normal on the free plan; the Starter plan stays awake                                    |
| Render logs show `FastifyDeprecation … FSTDEP022/023/024`                           | Notices about a future Fastify version                                                       | Harmless                                                                                 |

## What the free plans mean

| Service    | Free allowance                                                       | What happens at the limit          |
| ---------- | -------------------------------------------------------------------- | ---------------------------------- |
| Render     | 750 instance hours/month; sleeps after 15 idle minutes               | Service suspended until next month |
| Neon       | 0.5 GB storage, 100 compute hours/month; sleeps after 5 idle minutes | Database paused until next month   |
| Upstash    | 500,000 commands/month, 256 MB                                       | Database paused until next month   |
| Cloudinary | 25 monthly credits (storage + bandwidth + transformations)           | Uploads/delivery limited           |
| Vercel     | Hobby plan — for personal, non-commercial projects                   | —                                  |

Good to know on the free Render plan:

- Background work (fridge-scan processing, the hourly notification sweep) runs
  inside the API, so it only happens **while the service is awake**, and a job
  that is running when the service sleeps or redeploys is dropped.
- Render's health check uses `/health/live`, which does not touch the database
  or Redis — so the checks themselves never keep Neon awake or use Upstash commands.

## Later: when you outgrow the free plans

- **Always on:** change the Render service to the **Starter** plan. Then move
  migrations out of start-up — set a **Pre-Deploy Command** of
  `node packages/api/dist/migrate.js` and `DATABASE_MIGRATE_ON_BOOT=false`.
- **More than one API instance:** set `QUEUE_DRIVER=redis`, run a separate worker
  (`node packages/api/dist/worker.js`, `ENABLE_WORKER=true`), and keep
  `ENABLE_CRONS=true` on exactly one of them. On Upstash, use a fixed-price plan —
  idle job workers send roughly 180 commands a minute.
- **AI features:** add `GEMINI_API_KEY`, `OPENAI_API_KEY` and/or `ANTHROPIC_API_KEY`
  in Render → Environment. Until then the built-in engine is used.
- **Your own domain:** add it in Vercel (website) and Render (API), then put the
  new website address in `CORS_ORIGINS` and the new API address in
  `EXPO_PUBLIC_API_URL` (and redeploy Vercel).

## Reference: every setting

**Render** (all defined in `render.yaml`; secrets are typed into the dashboard)

| Variable                                           | Value                 | Why                                                                    |
| -------------------------------------------------- | --------------------- | ---------------------------------------------------------------------- |
| `NODE_VERSION`                                     | `22`                  | The Node version CI tests with                                         |
| `NODE_ENV`                                         | `production`          | Enables the production safety checks                                   |
| `HOST`                                             | `0.0.0.0`             | Render can only reach the API on this address; `PORT` is set by Render |
| `TRUST_PROXY`                                      | `true`                | Rate limits see the visitor's IP, not Render's proxy                   |
| `CORS_ORIGINS`                                     | _your Vercel address_ | Which websites may call the API                                        |
| `DATABASE_URL`                                     | _secret (Neon)_       | PostgreSQL connection                                                  |
| `DATABASE_MIGRATE_ON_BOOT`                         | `true`                | Apply migrations on start (free plan has no pre-deploy step)           |
| `REDIS_URL`                                        | _secret (Upstash)_    | Cache and rate limits                                                  |
| `ENABLE_REDIS`                                     | `true`                | Use Redis                                                              |
| `QUEUE_DRIVER`                                     | `memory`              | Jobs run inside the API — protects the Upstash free tier               |
| `ENABLE_WORKER` / `ENABLE_CRONS`                   | `false` / `true`      | This one service does the background work                              |
| `STORAGE_DRIVER`                                   | `cloudinary`          | Photos go to Cloudinary (local disk is wiped on every deploy)          |
| `CLOUDINARY_CLOUD_NAME`, `_API_KEY`, `_API_SECRET` | _secret (Cloudinary)_ | Upload credentials                                                     |
| `CLOUDINARY_FOLDER`                                | `platematch`          | Folder in your Media Library                                           |
| `JWT_SECRET`, `JWT_REFRESH_SECRET`                 | _generated by Render_ | Sign-in tokens (regenerating signs everyone out)                       |
| `SEED_DEMO_USER` / `SEED_DEMO_PASSWORD`            | `true` / _generated_  | Loads the public recipe library; the demo login gets a random password |
| `ENABLE_SWAGGER`                                   | `false`               | API docs page (`/docs`) off in production                              |
| `AI_MODE`                                          | `auto`                | Built-in engine until you add AI keys                                  |

`APP_URL` defaults to Render's address and `FRONTEND_URL` to the first
`CORS_ORIGINS` entry, so neither needs setting.

**Vercel** (Root Directory `apps/mobile`; everything else comes from `vercel.json`)

| Setting               | Value                                                                                     |
| --------------------- | ----------------------------------------------------------------------------------------- |
| Install               | `cd ../.. && npm ci --include=dev --ignore-scripts` (whole workspace, from the repo root) |
| Build                 | `npm run build:web` — checks `EXPO_PUBLIC_API_URL`, then `expo export --platform web`     |
| Output                | `dist`                                                                                    |
| Routing               | unknown paths serve `index.html`, so deep links and refreshes work                        |
| `EXPO_PUBLIC_API_URL` | your Render address (public, built into the site)                                         |

## How this setup was tested

Before it was handed over, the whole stack was run end to end with stand-ins for
the hosted services: PostgreSQL 17 behind TLS that rejects unencrypted
connections (like Neon), password-protected Redis behind TLS (like Upstash), and
a mock of Cloudinary's upload API that verifies every request signature with
Cloudinary's official SDK. Render's build and start commands were run from
`render.yaml` in a clean copy of the repository against an empty database;
Vercel's own CLI (`vercel build`) built the website from `vercel.json`; and a
real Chrome browser signed in, refreshed, followed a deep link and uploaded a
photo through it. CI repeats the Render-style build, first boot and smoke test
on every push (`.github/workflows/ci.yml` → "Production boot").
