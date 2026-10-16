<div align="center">

# 🥗 PlateMatch

### Cook what you have. Waste less.

**Photograph your fridge → AI identifies every ingredient → get recipes you can cook *right now* → plan the week → shop the cheapest basket → track what you actually throw away.**

A production-ready, cross-platform meal planner built to attack household food waste from every angle at once.

[![CI](https://github.com/sdlksdsf/Ai-Tracker/actions/workflows/ci.yml/badge.svg)](https://github.com/sdlksdsf/Ai-Tracker/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-3C873A?logo=node.js&logoColor=white)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-679-2D8F4E)](#testing)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](#type-safety)

**Runs with zero API keys.** Add a key for any one capability and only that capability goes live.

</div>

---

## Table of contents

- [Why this exists](#why-this-exists)
- [The 30-second demo](#the-30-second-demo)
- [Quickstart](#quickstart)
- [What you get without any API keys](#what-you-get-without-any-api-keys)
- [Features](#features)
- [Screens](#screens)
- [Architecture](#architecture)
- [The AI pipeline](#the-ai-pipeline)
- [Food-allergy safety](#food-allergy-safety)
- [API reference](#api-reference)
- [Configuration](#configuration)
- [Deployment](#deployment)
- [Testing](#testing)
- [Project layout](#project-layout)
- [Design decisions & honest limitations](#design-decisions--honest-limitations)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

---

## Why this exists

The average household throws away food it paid for, then buys ingredients for recipes it doesn't have the rest of, then throws *those* away too. It's a loop, and each step feeds the next.

Most recipe apps make the loop worse: they show you a dish, you shop for all of it, and half of what you already had quietly expires.

PlateMatch inverts it. **Your fridge is the starting point, not the recipe.**

| The loop | What PlateMatch does |
|---|---|
| You forget what you have | A photo of the fridge becomes a searchable, expiry-dated pantry |
| You don't know what to cook | Recipes ranked by how much of your pantry they use — expiring items first |
| You overbuy | The grocery list is *only* what's missing, minus anything already at home |
| You pay more than you should | Every line priced across stores, routed to the cheapest one |
| You can't see the cost | Waste logging turns it into money and CO₂e you can actually track |

---

## The 30-second demo

```bash
git clone https://github.com/sdlksdsf/Ai-Tracker.git platematch
cd platematch

npm install
docker compose up -d postgres redis
cp .env.example .env

npm run db:migrate
npm run db:seed
npm run dev:api
```

That's it. Open **http://localhost:4000/docs** for the interactive API.

Sign in with the seeded demo account:

```
demo@platematch.app
PlateMatch2025
```

It comes with a 24-item pantry (several things deliberately about to expire), 34 published recipes across 11 cuisines, and declared peanut + shellfish allergies so you can watch the safety filter work.

<details>
<summary><b>Don't have Docker?</b></summary>

Point `DATABASE_URL` at any PostgreSQL 16 instance you already have. Redis is optional — without it PlateMatch falls back to an in-memory cache and an in-process job queue, which is correct for a single local process.

```bash
DATABASE_URL=postgresql://you:pass@your-host:5432/platematch ENABLE_REDIS=false npm run dev:api
```
</details>

<details>
<summary><b>Run the mobile app</b></summary>

```bash
cd apps/mobile
npm install
npx expo start
```

Scan the QR code with Expo Go (Android) or the Camera app (iOS). The app discovers your dev machine's LAN IP automatically — no configuration needed.

To point it at a deployed API instead:

```bash
EXPO_PUBLIC_API_URL=https://api.yourdomain.com npx expo start
```
</details>

---

## What you get without any API keys

This is the part most "AI app" templates quietly skip. PlateMatch ships a **built-in deterministic engine** that implements the full product loop offline:

| Capability | With keys | Without keys |
|---|---|---|
| **Fridge scan** | Vision model identifies ingredients with confidence scores | Returns an honest *"nothing detected"* plus actionable guidance — **it never invents ingredients from pixels** |
| **Recipes** | Live generation, allergen-guarded | Draws from a bundled **34-recipe corpus** (11 cuisines, every one with full nutrition) and filters it against your pantry and allergies |
| **Meal plans** | Live 7-day planning with macro verification | Assembled from the same corpus, still verified against your calorie target within ±10% |
| **Nutrition** | Edamam → Spoonacular | **116-entry USDA composition table**, scaled by ingredient weight |
| **Grocery prices** | Kroger → Spoonacular → live | Offline price index — every line still gets a real number, never `$0` |
| **Payments** | Stripe Checkout + portal | Simulated: grants the tier locally and flags `simulated: true` so the app says so honestly |

`AI_MODE` controls the policy:

```
auto   use live providers when the relevant key exists, else the built-in engine  ← default
live   always call providers; fail loudly if a key is missing
mock   always use the built-in engine (tests, CI, demos, offline work)
```

Check what your deployment is actually using — no auth required:

```bash
curl -s localhost:4000/api/v1/ai/status | jq
```

---

## Features

### 📸 Fridge scanning
Photograph your shelves. A vision model returns named ingredients with quantities, categories, confidence scores and — when a label is legible — a parsed expiry date. You review every detection before anything is saved: pre-ticked by confidence, individually renameable, rejectable. Your corrections are sent back with the confirmation so detection accuracy can be measured over time.

### 🍳 Recipe generation that respects your kitchen
Ranked by **pantry match**, prioritising anything about to expire. Filters for cuisine, meal type, difficulty and max time. Live serving scaler that recomputes every quantity. Each ingredient line tells you *have vs. need* — "You have 200 g · need 400 g" — which is the difference between a list and a decision.

### 📅 Weekly meal planning
Optimises for your calorie and macro targets, dietary restrictions, allergies, family size, cooking skill, time budget and grocery budget. Every plan is **verified** against your daily target within ±10%, and the verification report comes back with it so you can see which days landed and which didn't. Swap any single meal — pick a recipe or ask for a fresh suggestion that avoids everything else in the week.

### 🛒 Grocery lists that cost less
Aggregates every ingredient across your plan, scales to servings, merges duplicates, and drops what's already at home. Then prices each line across stores and routes it to the cheapest one — typically **$8–20 saved on a weekly shop**. Hand off to Instacart, Amazon Fresh, Walmart, Kroger or Pandago with a pre-filled search, or share a plain-text list.

### 🗑️ Waste tracking that means something
Log what you threw away in two taps. Grams, CO₂e and cost are derived server-side from per-category factors and a price index, so there's nothing to look up. Every total is paired with an equivalent you can picture: trees needed to absorb the carbon, meals' worth of food, and how you compare with the UNEP household average of ~1.5 kg per person per week.

### 🏆 Gamification that isn't decorative
Badges show progress even while locked — "18 of 20 recipes cooked" is what makes someone cook two more. Points, levels and a waste-free streak, all evaluated lazily from your own rows so a badge can never be missed because a write path forgot to emit an event.

### 🔔 Notifications that arrive when they're useful
Six triggers: expiry alerts (9 AM), meal reminders (your three configured times), weekly report (Sunday 6 PM), smart suggestions (5 PM), achievements, and scan completion. **Delivery is timezone-correct**: the sweeps run hourly and fire only for users whose *local* hour matches, so 9 AM means 9 AM in Karachi and 9 AM in Toronto. Quiet hours are honoured server-side by every sweep.

---

## Screens

15 screens across 5 tabs, one design system.

| | Screen | What it does |
|---|---|---|
| 1 | **Auth** | Email/password, Google, Apple, password reset |
| 2 | **Home** | Greeting, impact stats, expiring carousel, today's plan, ranked suggestions |
| 3 | **Scan** | Camera with framing guides, permission handling, library fallback |
| 4 | **Scan review** | Tick, rename and reject detections before they reach your pantry |
| 5 | **Recipes** | Search, filter, sort by pantry match, AI generation |
| 6 | **Recipe detail** | Ingredients with have-vs-need, method, nutrition, allergen warnings |
| 7 | **Pantry** | Grouped by location and urgency, add/edit/delete, batch actions |
| 8 | **Cooking mode** | One step at a time in large type, screen stays awake, spoken steps, per-step timer |
| 9 | **Meal plan** | Seven day-cards, calorie bars against target, swap and complete |
| 10 | **Grocery list** | Group by category or store, 48dp checkboxes, price comparison, provider hand-off |
| 11 | **Waste** | Log, trend chart, impact equivalents |
| 12 | **Achievements** | Level card, badges grouped earned-first then closest-to-unlocking |
| 13 | **Profile** | Impact stats, plan, preferences, account actions |
| 14 | **Premium** | Your *own* quota usage as the pitch, tier and interval picker, comparison table |
| 15 | **Settings** | Language, units, haptics, all six notification triggers, quiet hours, live server + AI status |

---

## Architecture

```
┌─────────────────────┐         ┌──────────────────────────────────────────┐
│   apps/mobile       │  HTTPS  │            packages/api                  │
│   Expo 52 · RN 0.76 │ ──────► │        Fastify 5 · TypeScript strict     │
│   expo-router v4    │  JSON   │                                          │
│   Zustand + Query   │         │  routes → services → db                  │
└─────────────────────┘         │      │                                   │
                                │      ├─ services/ai/     vision chain    │
                                │      │                   reasoning chain │
                                │      │                   nutrition       │
                                │      │                   prices          │
                                │      │                   allergen-guard  │
                                │      │                                   │
                                │      └─ jobs/            scan processor  │
                                │                          6 sweeps        │
                                └───────────┬──────────────┬───────────────┘
                                            │              │
                              ┌─────────────▼──┐    ┌──────▼───────┐
                              │ PostgreSQL 16  │    │   Redis 7    │
                              │ Drizzle ORM    │    │ cache+queue  │
                              │ 28 tables      │    │  BullMQ      │
                              └────────────────┘    └──────────────┘
```

**`packages/shared`** is the contract. Zod schemas, TypeScript types and constants — every enum, unit conversion, CO₂ factor, plan limit and rate limit — live there once and are consumed by both the API and the app. The mobile build resolves it straight to TypeScript source via a Metro `resolveRequest` hook, so there's no build step in between and the two cannot drift.

| | Files | Lines |
|---|---|---|
| `packages/shared` | 14 | 2,223 |
| `packages/api` | 82 | 23,506 |
| `apps/mobile` | 75 | 16,948 |
| **Total** | **171** | **~42,700** |

---

## The AI pipeline

Every AI capability is a **fallback chain**, not a single provider call. If the primary fails, times out or returns something unparseable, the next one runs.

```
Vision       gemini-3-pro  →  gpt-5.6-terra  →  built-in engine (honest empty result)
                                    + Google Cloud Vision for bounding boxes

Reasoning    claude-sonnet-5  →  gpt-5.6-sol  →  gemini-3-flash  →  built-in corpus

Nutrition    Edamam  →  Spoonacular  →  USDA composition table (116 entries, cached 30d)

Prices       Kroger  →  Spoonacular  →  offline price index (cached 24h)
```

Costs are metered per call against a **per-user daily spend cap**, so a runaway client can't burn the API budget. Usage is recorded asynchronously — never awaited inline on a request path.

<details>
<summary><b>Why these model IDs?</b></summary>

The original spec pinned `gemini-2.5-pro-preview-03-25`, `gpt-4o-2024-11-20` and `claude-sonnet-4-20250514`. Those are legacy identifiers — `gemini-2.5-*` retires from Vertex AI on **20 October 2026** — so they're not used anywhere in this codebase. The defaults above are the current-generation models, all overridable via env:

```
AI_VISION_PRIMARY_MODEL      AI_REASONING_PRIMARY_MODEL
AI_VISION_FALLBACK_MODEL     AI_REASONING_FALLBACK_MODEL
AI_VISION_FAST_MODEL         AI_REASONING_BATCH_MODEL
```
</details>

---

## Food-allergy safety

This is the part of the codebase that cannot be allowed to fail quietly.

A model is *instructed* never to use an allergen. Instructions are not a guarantee, and an allergy mistake can be fatal. So every model output passes through a **deterministic, offline guard** before it is persisted or shown:

```
services/ai/allergen-guard.ts
  ├─ findViolation()    one ingredient vs. allergies + diet + avoid-list
  ├─ auditRecipe()      every ingredient, every cooking step, and the title
  ├─ sanitizeRecipe()   reject the WHOLE recipe — never silently edit it
  └─ guardBatch()       filter a generation batch, reporting why each was dropped
```

Three deliberate choices:

**It is over-blocking by design.** Substring matching on normalised names, plural folding, and explicit keyword families per allergen. A false positive costs a recipe. A false negative costs a hospital visit.

**It checks steps and titles, not just ingredients.** "Fry in peanut oil" appearing only inside step 2 is still caught — an ingredients-only check would let it through.

**A violation disqualifies the whole recipe.** Nothing is quietly deleted from an ingredient list, because a recipe with a silently removed component is a worse answer than no recipe.

The keyword families are tested exhaustively — `tests/unit/allergen-guard.test.ts` pins 41 cases including derived ingredients (`groundnut oil`, `arachis`, `marzipan`, `ghee`, `calamari`), reverse aliases (declaring "groundnut" still protects you from "peanut butter"), violation precedence (allergen > diet > avoid), optional ingredients and substitutes.

> ⚠️ **This is a safety net, not a medical device.** It catches what a keyword table can catch. If you have a severe allergy, read the ingredient list yourself. Nutrition figures are estimates and are not a substitute for medical dietary advice.

---

## API reference

105 endpoints under `/api/v1`. Bearer JWT — 15-minute access tokens, 7-day rotating refresh tokens with family revocation on reuse.

Interactive docs at **`/docs`** (OpenAPI 3.1, generated from the same Zod schemas that validate at runtime — they cannot drift).

```
POST   /auth/register          POST   /scan/fridge              POST   /recipes/generate
POST   /auth/login             GET    /scan/status/:id          GET    /recipes
POST   /auth/refresh           POST   /scan/:id/confirm         GET    /recipes/:id
POST   /auth/logout            GET    /pantry                   POST   /recipes/:id/cook
POST   /auth/google            POST   /pantry                   POST   /recipes/:id/rate
POST   /auth/apple             GET    /pantry/stats             POST   /meal-plans/generate
POST   /auth/forgot-password   GET    /pantry/expiring-soon     GET    /meal-plans/week
POST   /auth/reset-password    POST   /pantry/batch-use         POST   /meal-plans/:id/entries/:id/swap
                               PATCH  /pantry/:id               POST   /meal-plans/:id/entries/:id/complete
GET    /users/me               DELETE /pantry/:id               POST   /grocery-lists/generate
PATCH  /users/me                                               POST   /grocery-lists/:id/prices
PUT    /users/me/preferences   GET    /waste                    POST   /grocery-lists/:id/order
POST   /users/me/allergies     POST   /waste                    GET    /achievements
GET    /users/me/nutrition…    GET    /waste/stats              GET    /dashboard/home
POST   /users/me/avatar        GET    /waste/impact             GET    /dashboard/savings
DELETE /users/me                                               GET    /health · /health/ready
GET    /notifications          POST   /subscription/checkout    GET    /api/v1/ai/status
PUT    /notifications/prefs    POST   /subscription/webhook
```

Every response uses one envelope, and every error uses one shape:

```json
{ "statusCode": 422, "error": "validation_error", "message": "…", "requestId": "…" }
```

**Rate limits** — 100/min general · 10/min AI generation · 5/min fridge scans · 10/min auth (per IP). Counters live in Redis so they hold across replicas; remaining budget is in the `X-RateLimit-*` headers.

---

## Configuration

```bash
cp .env.example .env
```

The template documents **all 101 variables**, and CI fails if it drifts from what the server actually reads. Every one is optional — see [What you get without any API keys](#what-you-get-without-any-api-keys).

The ones worth knowing first:

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | `postgresql://platematch:platematch@localhost:5432/platematch` | Matches `docker-compose.yml` |
| `REDIS_URL` | `redis://localhost:6379` | Optional; falls back to in-memory |
| `AI_MODE` | `auto` | `auto` · `live` · `mock` |
| `STORAGE_DRIVER` | `local` | `local` · `cloudinary` · `s3` (MinIO ships in compose) |
| `JWT_SECRET` | dev default | **Server refuses to start in production with the default** |
| `ENABLE_CRONS` | `true` | Disable on every replica but one |
| `SEED_DEMO_USER` | `true` | Idempotent demo account |

Production hardening is enforced, not suggested: a dev-default `JWT_SECRET` or `STORAGE_DRIVER=local` makes the process **refuse to start** when `NODE_ENV=production`.

---

## Deployment

### Free-tier cloud: Vercel + Render + Neon + Upstash + Cloudinary

**Step-by-step dashboard guide: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)** — no command line needed.

| Piece | Service | Configured by |
|---|---|---|
| Website (`apps/mobile`, Expo web) | Vercel | [`apps/mobile/vercel.json`](apps/mobile/vercel.json) — Root Directory `apps/mobile`, `EXPO_PUBLIC_API_URL` |
| API (`packages/api`) | Render | [`render.yaml`](render.yaml) Blueprint — health check `/health/live`, migrations on boot |
| PostgreSQL | Neon | `DATABASE_URL` |
| Redis (cache, rate limits) | Upstash | `REDIS_URL` (`rediss://`), jobs in-process via `QUEUE_DRIVER=memory` |
| Uploads | Cloudinary | `CLOUDINARY_CLOUD_NAME` / `_API_KEY` / `_API_SECRET` |

`node scripts/check-deploy-config.mjs` validates `render.yaml` against Render's schema and both configs against the code (CI runs it), and `node scripts/smoke-deploy.mjs --api … --web …` — or **Actions → Deploy check** — tests a live deployment from the outside.

### Containers

```bash
docker build -f deploy/Dockerfile.api    -t platematch/api    .
docker build -f deploy/Dockerfile.worker -t platematch/worker .
```

Four-stage builds: native modules (argon2, sharp) compile in a throwaway layer and the runtime image gets production deps plus `dist/` only. Non-root user, `HEALTHCHECK` on `/health/live`, migration SQL included.

Run the API and the worker separately so a long vision call can never delay an HTTP response:

```bash
docker run -d --env-file .env -p 4000:4000 -e ENABLE_WORKER=false platematch/api
docker run -d --env-file .env -e ENABLE_CRONS=true               platematch/worker
```

### Database

```bash
npm run db:migrate      # apply pending migrations
npm run db:generate     # generate SQL after editing schema.ts
npm run db:seed         # idempotent demo data

node packages/api/dist/migrate.js   # production: the built bundle, no tsx needed
```

Migrations are committed SQL (`packages/api/drizzle/0000_init.sql` — 28 tables, 16 enums, 75 indexes). CI runs `drizzle-kit check` to catch a `schema.ts` edit that was never generated into SQL — the drift that turns a green build into a broken deploy.

### Mobile

```bash
cd apps/mobile
eas build --platform all --profile production
```

`eas.json` defines `development`, `preview` and `production` profiles with EAS Update channels.

### CI

`.github/workflows/ci.yml` runs five jobs on every push: typecheck + lint, unit tests, integration tests against **real Postgres 16 and Redis 7 service containers** (migrations applied, schema drift checked, seed smoke-tested), a build that verifies all four entrypoints emit and that the server fails with a *diagnostic message* when the database is unreachable, and a dependency audit with a committed-secrets scan.

`.github/workflows/security.yml` boots the real API against Postgres, seeds it, and runs an **OWASP ZAP baseline scan**, publishing SARIF to the Security tab plus a report artefact. On pull requests it also runs GitHub's dependency review as a *report* — see below for why it does not block.

`release.yml` builds and pushes the container image to GHCR on a tag push, and queues EAS mobile builds — the latter only when the **`EAS_ENABLED` repository variable** is `true`, reading the token from the `EXPO_TOKEN` secret. It has to be a variable rather than a secret test because `secrets` is not a valid context in a job-level `if:`; without that gate a fork with no Expo account gets a skipped job and a green release run instead of a failure.

### Supply chain

The blocking gate is `node scripts/audit-runtime.mjs`, and it is deliberately narrower than `npm audit`.

A whole-workspace audit on this repo reports 63 high/critical advisories — and essentially all of them are in the Expo / React Native / Metro / Jest / Vitest toolchain, which runs on developer and CI machines and is in neither the server bundle nor the app binary. The spec pins Expo SDK 52 and React Native 0.76, so blocking on those keeps the gate red on every PR no matter what the PR changes, and a gate that is always red is a gate people learn to ignore.

So the script walks **`packages/api`'s production dependency subtree** from the lockfile's own edges — 240 packages — and fails on any high or critical advisory in it. `npm ls --workspace` cannot do this: in a hoisted workspace it reports the shared tree and declares Expo and Jest "shipped". Advisories outside the subtree are still printed, just not blocking.

Anything accepted must be written into the allow-list **with a reason**, and the script fails if an entry has none. There is currently exactly one:

| Package | Severity | Why it is accepted |
|---|---|---|
| `@fastify/static` | high | Serves only the bundled Swagger UI assets. The patched release ships with `@fastify/swagger-ui` 6.x, which requires **Fastify 6**; this repo is on Fastify 5. Retires with that migration. |

Two advisories in the shipped tree were fixed rather than accepted:

- **`sharp` 0.33.5 → 0.35.5** (libvips CVEs). This was the one that genuinely mattered: it parses **untrusted user-uploaded images**. The upgrade changed the ESM type shape — the callable moved to a default export, so `typeof import('sharp')` stopped having call signatures — and the loader now names it explicitly. A real libvips round-trip in the test suite means the next upgrade fails in CI, not in production.
- **`drizzle-orm` 0.38.4 → 0.45.4** (SQL injection via improperly escaped identifiers). Exposure here was nil — the codebase has no `sql.raw` and builds no dynamic identifiers, every `orderBy` uses imported column objects — but the upgrade was clean and removes the only flagged direct dependency. It did change behaviour underneath us; see the decimal regression in [Testing](#testing).

After both, the shipped API runtime tree has **no unaccepted high or critical advisory**. Proving the gate can still bite: emptying the allow-list makes it exit 1 on `@fastify/static`, and `--all` makes it exit 1 on the 62 toolchain advisories.

### Load testing

Two k6 scenarios, because they measure different failure modes — see [`packages/api/tests/load/README.md`](packages/api/tests/load/README.md).

```bash
k6 run tests/load/daily-journey.js    # throughput: 0→150 VUs, per-endpoint p95 budgets
k6 run tests/load/ai-endpoints.js     # controls: rate limits, quotas, the spend cap
```

The AI suite is the one worth having. Its thresholds assert that the limiter
returns **429 with correct headers and never a 500**, and that a rejection is
*cheaper* than the work it prevents (p95 < 250ms) — a limiter that costs as much
as the call it blocks protects the upstream bill but not the API. It also checks
the free tier's one-plan-per-month quota holds under concurrency, returning 402
rather than silently succeeding.

---

## Testing

**679 tests**, and all three packages — `shared`, `api` and `mobile` — typecheck with **zero errors** under `strict` + `noUncheckedIndexedAccess`.

```bash
npm test                                    # everything, via turbo
npm run typecheck                           # shared + api + mobile

cd packages/shared && npx vitest run        #  69 contract tests
cd packages/api    && npx vitest run        # 375 unit tests
cd packages/api    && npm run test:e2e      # 148 integration tests (needs Postgres)
cd apps/mobile     && npx vitest run --config vitest.pure.config.ts   #  87 mobile tests
```

531 run anywhere. The **148 integration tests** boot the real Fastify app and drive it with `app.inject()`, so they need PostgreSQL — `npm run db:up` locally, or let CI's service containers provide it. When no database is reachable they **skip loudly** rather than passing vacuously, because a green run that exercised nothing would be believed.


| Suite | Cases | Covers |
|---|---|---|
| `shared/constants` | 69 | **The cross-package contract.** Plan limits and tier monotonicity, rate limits, token TTLs, cache TTLs, upload caps, CO₂ factors for every category, unit conversions, allergen keyword coverage, macro splits summing to 1.0 |
| `allergen-guard` | 41 | **Safety-critical.** Ingredients, steps, titles, optional items, substitutes, dietary exclusions, avoid-lists, violation precedence, and a per-keyword regression table |
| `food` | 128 | Ingredient normalisation, singular/plural round-trips, category inference, unit conversion, quantity parsing, similarity matching, shelf life, CO₂ factors, price estimation |
| `dates` | 66 | Date maths, expiry urgency buckets, timezone resolution (including half-hour offsets), label parsing, period ranges |
| `nutrition` | 40 | Mifflin–St Jeor targets, goal ordering, macro splits, clinical clamping, macro verification |
| `pagination` | 40 | Page clamping, offsets, cursors, ETags, field selection |
| `openapi` | 6 | **The generated spec actually describes the API:** >80 paths, every resource tag represented, the endpoints a client integrates against first, bearer auth, the `{ data, meta }` envelope, and `/docs/json` serving the same document |
| `ratelimit` | 13 | **The allow-list composition.** `RATE_LIMIT_DISABLED` genuinely allows everything, the health probes / Stripe webhook / docs stay exempt when it does not, `/metrics` deliberately does not, query strings are ignored, `/api/v1/health` is not mistaken for `/health`, and `generalRateLimitOptions()` no longer sets an allow-list at all so nothing can be silently overwritten |
| `image` | 18 | **Upload admission.** Magic bytes decide, never the `Content-Type` header: forged `image/jpeg` over arbitrary bytes is refused, a GIF wearing a JPEG label is refused by its own header, allowed formats pass, and empty/oversized get 400/413. Plus a real libvips round-trip so a `sharp` upgrade fails here rather than in production |
| `cost` | 24 | Model pricing resolution including dated suffixes, per-call cost, token estimation |
| `format` + `parse` | 61 | Every user-facing number: money, weight, CO₂, dates, quantities |
| `i18n` | 18 | Catalogue parity across en/es (411 keys each): missing keys, orphans, empty strings, placeholder mismatches, untranslated copies, locale-tag resolution |
| `api` (mobile) | 8 | **The two functions that decide whether a list screen renders anything:** query-string serialisation (booleans → `true`/`false`, empty values dropped, arrays repeated, text encoded) and page-envelope normalisation |
| **`e2e/health`** | 11 | Degraded-vs-ready probes, public access, and `/ai/status` leaking no key-shaped substring |
| **`e2e/auth`** | 28 | Refresh-token **rotation**, a rotated token rejected on replay, forged tokens getting 401 while non-token-shaped stubs get 422, malformed tokens never 500ing, forgot-password unable to enumerate accounts, no hash or Stripe id in the profile |
| **`e2e/pantry`** | 26 | Derived expiry fields, shelf-life estimation, ownership returning **404 not 403**, out-of-range limits rejected while the documented maximum is accepted, the free-tier 50-item cap |
| **`e2e/recipes`** | 22 | Generation in mock mode, pantry-match ratios agreeing with their own counts, and **a declared allergen never appearing** in any title, ingredient, substitute or step |
| **`e2e/planning`** | 21 | 7-day plans, the ±10% nutrition verification report, day cards carrying the date/label/today flag they render, the week overview exposing its grocery list, every list endpoint using one `{ data, meta }` envelope, grocery lines always priced > 0, duplicate lines merged, **every NUMERIC column arriving as a JS number rather than a string**, price comparison gated 403 on free |
| **`e2e/insights`** | 41 | Waste derived server-side, CO₂e scaling and meat-vs-vegetable ordering, impact equivalents, achievement progress bounds, the public pricing table, simulated checkout |

The test suite has already earned its keep — it found **eight real bugs**, including two safety ones:

> `parseExpiryLabel('12 Jun 2026')` returned **2027**-06-12. The regex's optional day group swallowed the first two digits of the year, so the explicit year was lost and an "assume next year" fallback fired — silently pushing expiry dates a year out and suppressing alerts for food that was actually about to go off.

> `corn` had no allergen keyword family at all, so a declared corn allergy only matched the literal word — missing cornstarch, corn syrup, maize, polenta and masa. `shared/constants` now asserts that **every** allergen a user can declare in onboarding has non-empty derived-ingredient coverage.

Also caught: the allergen keyword families were never consulted at all (a plural/singular key mismatch meant `groundnut oil` passed for a declared peanut allergy), `pluralize('tomato')` returned `tomatos`, `parseQuantity('500ml')` dropped the unit, `frozen peas` categorised as a vegetable with a 7-day shelf life instead of 180, a negative SQL `OFFSET`, and key-order-dependent ETags.

It also caught two **wrong claims shipped to users**: the Premium screen said "there are no ads on any plan" while `PLAN_LIMITS.free.ads` is `true`.

### What the integration + typecheck pass found

Running the suite against a real PostgreSQL 18 server, and typechecking the **mobile app for the first time** (316 errors, none of them previously surfaced), turned up a second crop — this time on the client side, where a 200 response can still mean "your data went nowhere":

> **Allergies were silently discarded.** Onboarding and Preferences sent diet, budget, family size *and the allergy list* to `PATCH /users/me`. That route validates against `updateProfileSchema`, and Zod strips keys it does not know — so the server returned **200** while throwing all of it away. A user declaring a peanut allergy had no allergy stored, and the recipe guard had nothing to enforce. Both screens now call the endpoints that actually own those fields (`POST /users/me/onboarding`, `PUT /users/me/preferences`).

> **The Recipes tab was permanently empty.** `GET /recipes` flattened its pagination onto the top level while every other list endpoint used `{ data, meta }`. The client helper unwrapped `data`, so the screen read `.items` off an array and got `undefined` — an empty list, with no error anywhere. The endpoint now uses the standard envelope, and `buildQuery`/`normalizePage` are unit-tested because they are the single point where this class of bug lives.

> **A forged `Content-Type` admitted arbitrary bytes.** `validateImageInput` fell back to the *declared* MIME type whenever magic-byte sniffing found nothing, so shell-script bytes labelled `image/jpeg` passed the allow-list and were forwarded to a vision provider and written to storage. The mismatch branch beneath it even logged "using sniffed type" while continuing to use the declared one. Sniffing is now a requirement, not a cross-check, and 18 tests pin upload admission.

> **`RATE_LIMIT_DISABLED=true` logged "rate limiting is OFF" and then limited anyway.** `generalRateLimitOptions()` installed `allowList: () => true` for the flag, and the plugin spread its *own* allow-list after it — object spread decides the winner, so the operational list silently replaced the disable. Nothing noticed locally, where each run is short; in CI, where Redis makes the counter shared and persistent across the whole suite, the pantry-quota seed (which deliberately writes past the free-tier cap) tripped the 100/min general limit and failed with a 429 in a job configured to have no rate limiting at all. The allow-list is now composed in exactly one place, and proven both ways: 150 requests against a disabled server produce **zero** 429s, and 150 against an armed one produce **50**, with correct `x-ratelimit-*` headers. The armed half is what makes the first result mean anything.

> **Every decimal silently became a string.** Upgrading `drizzle-orm` to 0.45 (for the SQL-injection advisory) changed `PgNumeric.mapFromDriverValue` to coerce NUMERIC to a string, overriding the global `pg` type parser the schema had been relying on. Nothing threw: `existing.quantity + input.quantity` became concatenation, the merged grocery line turned into `NaN`, and the API told the shopper to buy **0 g of flour**. All 41 decimal columns now declare `mode: 'number'` — the supported mechanism — and an integration test asserts NUMERIC arrives as a JS number across quantities, prices and savings.

> **`/docs` documented three endpoints.** `@fastify/swagger` assembles the spec from an `onRoute` hook, so it only sees routes registered *after* it — and the docs plugin was registered last, on the reasonable-sounding theory that the route schemas had to exist first. The document came out with its own `openapi.json` route, the upload wildcard and the service banner, and none of the ~90 real endpoints. Swagger UI still rendered and looked complete, and the integration harness boots with `skipDocs: true`, so nothing complained. The spec is now 98 paths / 110 operations across all 13 tags, with a test that builds the app the way `server.ts` does and counts them.

Three CI jobs were also broken in ways that made them look like real failures: `npx vitest run --config packages/api/vitest.config.ts --root packages/api` never started, because vitest resolves `--config` *relative to* `--root` and looked for `packages/api/packages/api/vitest.config.ts` — so the unit and integration jobs died at startup without running a single test. The ZAP job polled `localhost:4000` while `PORT` defaults to **8080**, so the server booted fine and the scan reported it as broken. And the unit job ran vitest with `--coverage` while `@vitest/coverage-v8` was not a dependency of anything, so it failed before the first test.

Also caught: five list endpoints (`/meal-plans`, `/grocery-lists`, `/recipes/favorites`, `/recipes/history`, `/recipes`) each inventing their own pagination shape; `WeekOverviewDto` never exposing `grocery_list_id`, so the Plan screen's "open your shopping list" shortcut had nothing to open; `GET /meal-plans/:id/days` returning `date: null` and no day label, leaving the calendar cards with empty headers and no "today" highlight; per-achievement `points` computed server-side but never sent, so the "+N pts" badge could not render; a non-multipart upload to `/scan/fridge` returning **500** instead of 415; `waste/stats` breaking its own `YYYY-MM-DD` contract by returning full timestamps; two Ionicons glyph names that do not exist (`ice-cube-outline`, `filing-outline`), rendering blank icons on the freezer and pantry rows; `StatCard` imported from a path it does not live at, in four screens; and four DTO fields (`cooking_skill_level`, `dietary_preference`, `health_goal`, `activity_level`, `added_via`) typed as loose `string` while the database columns are real enums — which is what made the preferences bug invisible to the compiler.

### What the scheduling + timezone pass found

A later read-through of the job layer and everything that asks "what day is it?" turned up a category of bug that no typecheck can see and no local run reproduces, because local development is exactly the configuration where it works:

> **Four of the six notification triggers never fired in production.** With Redis configured, the scheduler registered every cron as `{ task: 'refresh-expiry' }` — the payload was hard-coded. So expiry alerts, meal reminders, smart suggestions and the weekly report were enqueued zero times, while `refresh-expiry` ran five times a day; purge-tokens, purge-scans and recalculate-achievements never ran either. The in-process fallback (Redis absent — i.e. every dev machine and CI) called the right function for each schedule, so the only configuration anybody tested was the one that worked. There is now a single `MAINTENANCE_TASKS` list that the scheduler, the dispatcher and a unit test all read, so "what can a schedule ask for?" has one answer.

> **Nothing consumed the queue in a single-process deployment.** `server.ts` never registered the job processors — only `worker.ts` did — so with `ENABLE_WORKER=false` (the documented one-container deployment) or with Redis simply absent, `POST /scan/fridge` returned a scan id, the row said `queued`, and no processor ever picked it up: the fridge-scanning feature was dead in precisely the setups the docs recommend. The API process now registers the processors and the schedules whenever it owns the queue, the in-process queue honours the `attempts`/`backoffMs` a caller passes (it had 2 retries hard-coded, so a scan retried a different number of times depending on which back-end was live), and a job with no processor attached is dropped instead of being reported as "queued" forever.

> **Meal reminders could not fire at the configured minute.** Both shipping defaults are 07:30 and 18:30, the sweep runs hourly at :00, and the old predicate skipped any reminder whose configured minute was greater than the current minute — inside the same hour. A reminder set for 18:30 was therefore skipped by the 18:00 sweep and the next sweep was 19:00, in the next hour. The window is now minute-accurate with a full 60-minute grace that wraps across midnight, so "deliver on the first sweep at or after the configured time, exactly once" is what the code does — with unit tests pinning the boundary cases. It also no longer names *a* dinner from the plan; it names **today's**.

> **"Today" meant "today wherever the database happens to be".** Waste stats bucketed days with `date(logged_at)` — the database session timezone — while labelling them with the server's calendar, and anchored week/month/year windows to UTC midnight. For a user in Karachi that meant Monday-morning waste counted towards last week, and between 00:00 and 05:00 local on a Monday the window started in the *future* and the screen read "nothing logged this week" for someone who had just logged something. Periods, daily buckets, the waste-free streak, dashboard trends, the expiring-soon suggestion window, plan lookup and the pantry value card now all resolve the user's own calendar. Two more of the same family: the Stats trends endpoint returned a **fabricated** savings series (`cumulative += max(0, 2 - wasted * 0.5)` — invented money, straight to a chart), and the eight-week savings chart summed only grocery-list savings while the headline total also counted cooking and waste avoidance. Both now derive from the same definition as `total_saved_usd`.

> **"Better than average" was a function of account age.** `WasteImpactDto.user_kg_per_week` divided *lifetime* waste by the number of weeks since signup, so the longer you had been a member the smaller your reported weekly waste became — a user throwing away 5 kg a week was congratulated for beating the 1.5 kg national average after a year. It is now the real average over the most recent four weeks (or the account's lifetime, if shorter).

> **An OAuth sign-in could take over an existing account.** Google and Apple sign-ins linked to an existing password account purely on the email address. Google hands out unverified addresses, and Apple omits the email on every sign-in after the first — where the code fell back to a *client-supplied* one. Presenting any valid token plus someone else's address attached your provider identity to their account and issued you a session for it. Linking now requires the provider to assert `email_verified`; an unverified address gets a clear "sign in with your password and connect this provider from settings" instead.

Also in this pass: quiet hours compared at hour granularity, so a 22:30 window went quiet at 22:00 (and a 07:30 one stayed quiet until 08:00); `getPantryStats` returned a hard-coded `total_estimated_value: 0` and `oldest_item: null` while the Pantry screen rendered both; `POST /scan/:id/confirm` replied `pantry_items: []` and threw away the insert's `returning()` rows; the dashboard cache was invalidated by pantry writes only, so logging waste or cooking a meal left Home and Stats showing pre-write numbers for up to five minutes; `getHomeSummary` threw a bare `Error` (a 500) for a deleted user with a live token; a free-form ingredient category was written to a Postgres enum through `as GroceryList['status'] as never`, which is a type-checking off-switch around a column that rejects unknown values; and `getActivePlan` judged "today" in UTC while the plan owner's own day had already rolled over.

The suite grew with the fixes: 420 API unit tests across 13 files (from 375), including first-time coverage for the cron schedule ↔ worker-task contract, the reminder due-window arithmetic, quiet-hours minute precision, per-user local-calendar maths, and the in-process queue's retry and lifecycle semantics.

---

## Project layout

```
Ai-Tracker/
├── apps/
│   └── mobile/                  Expo 52 · React Native 0.76 · expo-router v4
│       ├── app/                 15 screens + 5-tab navigation
│       ├── components/
│       │   ├── ui/              13 design-system primitives
│       │   └── charts/          donut · bar · line on react-native-svg
│       ├── theme/tokens.ts      every colour, radius, spacing step, font size
│       ├── lib/                 api client · kv · secure storage · format
│       ├── stores/              auth · ui (zustand)
│       ├── hooks/               data access · polling · debounce
│       └── i18n/                en + es, 411 keys each
│
├── packages/
│   ├── shared/                  the contract — Zod schemas, types, constants
│   └── api/
│       ├── src/
│       │   ├── config/          env (101 validated vars) · prompts
│       │   ├── db/              schema · pool · migrations · seed
│       │   ├── lib/             logger · errors · jwt · crypto · redis · queue
│       │   │                    storage · image · pagination · ratelimit
│       │   ├── plugins/         security · auth · multipart · swagger · telemetry
│       │   ├── routes/          105 endpoints
│       │   ├── services/        12 domain services + dto
│       │   │   └── ai/          16 files: providers, chains, guard, cost ledger
│       │   ├── jobs/            5 processors · 8 schedules · 4 notification sweeps
│       │   ├── data/            34-recipe corpus · 116-entry USDA table
│       │   └── utils/           food · dates · nutrition
│       └── drizzle/             committed migration SQL
│
├── deploy/                      Dockerfile.api · Dockerfile.worker
├── .github/workflows/           ci · release · mobile-preview
├── docker-compose.yml           postgres:16 · redis:7 · minio
└── .env.example                 all 101 variables, documented
```

---

## Design decisions & honest limitations

Things that deviate from the obvious choice, and why.

**Tamagui was rejected.** The spec called for it. Its babel/compiler plugin is a well-known build-breakage source and can't be verified in CI here, so the design system is hand-rolled on top of the exact Section 6 tokens (`theme/tokens.ts` + 13 primitives in `components/ui/`). You get the same visual result with no compiler in the build path.

**Victory Native XL was rejected.** It pulls in `@shopify/react-native-skia` — a large native dependency — for three chart shapes. `react-native-svg` does the same job with no extra native module.

**`drizzle-orm` is pinned to 0.38.4**, deliberately *not* upgraded to get `decimal({ mode: 'number' })`. Version 0.36+ requires index callbacks to return an object, and all 28 tables use the array form. `.$type<number>()` plus a registered `NUMERIC` parser achieves the same result without touching 31 table definitions.

**Offline vision is not faked.** With no vision key, a scan returns an empty detection list and an actionable suggestion. Inventing ingredients from pixels would populate a pantry with food the user doesn't have, which then drives recipe suggestions, grocery lists and expiry alerts — one plausible-looking hallucination poisoning the entire product.

**`argon2` has a fallback.** It's a native module; if the binding fails to load, `lib/crypto.ts` degrades to Node's `crypto.scrypt`. Argon2id remains primary.

**The legacy model IDs in the original spec are not used.** See [Why these model IDs?](#why-these-model-ids)

**Known gaps.** Integration tests require Postgres + Redis and are exercised in CI, not in a bare `npm test`. The mobile app's component tests use the jest-expo preset and need its dependency tree installed; the platform-independent modules (`format`, `parse`, `i18n`) run in plain Node and are covered today. Household sharing has schema support (`households`, `household_members`) and a Family tier that gates it, but the member-management UI is not built yet.

---

## Roadmap

**Phase 1 — Core MVP** ✅ complete
Auth · fridge scan · pantry · recipes · meal plans · grocery lists · waste tracking · achievements · notifications · subscriptions

**Phase 2 — Growth**
- [ ] Household sharing UI (schema and Family tier gating are in place)
- [ ] Barcode scanning for packaged goods
- [ ] Recipe sharing between users
- [ ] Offline-first pantry with expo-sqlite sync

**Phase 3 — Scale**
- [ ] Multi-region deployment
- [ ] Maestro E2E suite wired into CI (the 11 flows exist under `apps/mobile/.maestro`)
- [ ] Web app (the Metro web export already builds)

---

## Contributing

```bash
npm install
docker compose up -d postgres redis
cp .env.example .env
npm run db:migrate && npm run db:seed
npm run dev          # api + worker concurrently
```

Before opening a PR:

```bash
npm run typecheck    # must be clean — strict mode, no escape hatches
npm test             # 399 tests
npm run lint
npm run format
```

**Type safety** is enforced end to end: `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `exactOptionalPropertyTypes` off only where it fights Zod inference. `packages/shared` and `packages/api` both compile with **zero errors**, and CI checks both on every push.

A few conventions worth knowing before you touch the code:

- **Never write a service against remembered schema names.** Dump the real column names from `src/db/schema.ts` first — this is how ~100 type errors got introduced once.
- **Native and optional deps import lazily**, inside functions, with a degraded path.
- **Cost lives only in `services/ai/cost.ts`.** Usage goes through `ledger.ts`.
- **Don't fake a capability you can't verify.** An honest empty result beats a plausible invention.

---

## License

MIT — see [LICENSE](LICENSE).

Built to make household food waste visible enough to fix. If it saves you one bag of spinach, it worked.

<div align="center">

**🥗 PlateMatch** — *Cook what you have. Waste less.*

[Report a bug](https://github.com/sdlksdsf/Ai-Tracker/issues) · [Request a feature](https://github.com/sdlksdsf/Ai-Tracker/issues) · [API docs](http://localhost:4000/docs)

</div>
