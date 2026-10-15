# Load testing with k6

Two scenarios, because they measure different failure modes. Running only the
first tells you the API is fast; running only the second tells you it is safe.
Neither tells you both.

```bash
# Install k6 (macOS / Linux / Docker)
brew install k6          # or: docker pull grafana/k6

# Start the API with a realistic configuration
cd ../../..
docker compose up -d postgres redis
npm run db:migrate && npm run db:seed
AI_MODE=mock npm run dev:api
```

Then, from `packages/api`:

```bash
k6 run tests/load/daily-journey.js     # throughput and latency of the read path
k6 run tests/load/ai-endpoints.js      # rate limits, quotas and the spend cap
```

Point either at a deployed environment:

```bash
k6 run -e BASE_URL=https://api.yourdomain.com tests/load/daily-journey.js
```

---

## `daily-journey.js` — throughput

Models one user session: sign up, load Home, browse the pantry, add an item,
search recipes, open the week view, then batch-fetch the stats endpoints. Read
heavy, like production.

Ramps 0 → 25 → 75 → **150** → 75 → 0 VUs over 8 minutes, so steady state *and*
the 6pm burst are measured in one run.

Each VU registers its own account. Sharing one user across 150 VUs would measure
lock contention on a single row and collide on every cache key — a benchmark that
flatters the system instead of testing it.

| Threshold | Budget | Why |
|---|---|---|
| `home_latency_ms` | p95 < 400ms | Cached aggregate; dominates traffic |
| `recipes_latency_ms` | p95 < 500ms | Cached search |
| `pantry_latency_ms` | p95 < 400ms | Cached list |
| `write_latency_ms` | p95 < 900ms | Hits the database directly |
| `http_req_failed` | < 1% | |
| `cache_hit_rate` | > 50% | The read path is *supposed* to be cached |

The run exits non-zero when a threshold is breached, so it can gate a deploy.

---

## `ai-endpoints.js` — controls under pressure

The AI endpoints are the ones that can bankrupt a deployment: every call pays an
upstream provider. This suite proves the controls around them hold.

```bash
# Keep rate limiting ON — required for the 429 assertions to mean anything.
RATE_LIMIT_DISABLED=false AI_MODE=mock npm run dev:api
k6 run -e ENFORCE_LIMITS=true tests/load/ai-endpoints.js
```

It asserts four things:

1. **The limiter returns 429 with correct headers, never a 500.** `server_errors_5xx`
   must be exactly 0 — a rate limiter that throws is worse than no rate limiter.
2. **A rejection is cheap.** `rejected_latency_ms` p95 < 250ms. If a 429 costs as
   much as a 200, the limiter protects the upstream bill but not the API.
3. **Quotas hold under concurrency.** The free tier allows one meal plan per
   month, so the second plan in the same month must return 402 with an upgrade
   message — not succeed, and not 500.
4. **Premium gating survives load.** Price comparison must return 403 for a free
   user rather than leaking data or erroring.

> ⚠️ **Run this with `AI_MODE=mock`.** Against live providers it will spend real
> money on every accepted request. The script prints a warning when it detects
> live mode, but it does not refuse — that is your call to make.

### Why the "limiter armed" rate metric exists

With `RATE_LIMIT_DISABLED=true` every request is allowed, so a run that produced
zero 429s would look like a clean pass while proving nothing at all. The suite
records `rate_limiter_armed` from the presence of `X-Ratelimit-Limit` on
rejections, and the teardown prints an explicit warning when a run saw no 429s.

---

## Reading a run

```bash
k6 run --out json=results.json tests/load/daily-journey.js
```

Or push to a time-series backend:

```bash
K6_OUT=experimental-prometheus-rw k6 run tests/load/daily-journey.js
```

The custom metrics are named per endpoint (`home_latency_ms`, `pantry_latency_ms`,
…) rather than lumped into `http_req_duration`, so a regression names the route
that caused it instead of reporting "the app got slower".

---

## What these tests deliberately do not cover

- **Cold-start latency.** Both suites ramp from zero, so the first iterations
  include connection-pool warmup and JIT. The p95 figures describe steady state;
  read the p99 with the ramp in mind.
- **Postgres itself under load.** These measure the API. Saturating the database
  needs a separate test with `pgbench`, against a production-shaped instance —
  the `postgres:16-alpine` container in `docker-compose.yml` is not that.
- **Vision upload throughput.** The multipart path is exercised only with a
  deliberately invalid payload, because a real scan calls a paid model. Load-test
  uploads against a deployment with `AI_MODE=mock` and expect an honest empty
  detection list rather than latency numbers that mean anything.
- **Redis-backed queue behaviour.** With `ENABLE_REDIS=false` the queue is
  in-process, so BullMQ's own backpressure and retry semantics are not measured.
  Set `ENABLE_REDIS=true` to exercise the real path.
