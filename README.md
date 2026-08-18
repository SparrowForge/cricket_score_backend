# CricLive — API

NestJS 10 + PostgreSQL (Neon) + Redis (Upstash) backend for the CricLive
platform: auth, organizations, tournaments, ball-by-ball scoring, live
WebSocket push, statistics, SaaS plans and CMS.

Clients: [`../frontend`](../frontend) (Next.js) and [`../mobile`](../mobile) (Flutter).

## Run

```bash
npm install
npm run db:migrate          # applies migrations/*.sql once each, tracked in schema_migrations
npm run build && npm start  # http://localhost:3001, /health for readiness
npm run start:dev           # watch mode
```

Swagger UI is served at `/api/docs`; the committed spec is [`doc/apidoc.json`](doc/apidoc.json).

### Environment (`.env`)

| Key | Purpose |
|---|---|
| `DATABASE_URL` | Neon pooled connection string (runtime) |
| `DIRECT_URL` | Neon direct connection (migrations) |
| `REDIS_URL` | Upstash — pub/sub for the live gateway, plus caching |
| `PORT` | defaults to `3001` |
| `API_PREFIX` / `API_VERSION` | route prefix, defaults to `api` / `v1` |
| `CORS_ORIGINS` | comma-separated allowed origins |
| `JWT_SECRET`, `JWT_EXPIRES_IN`, `REFRESH_TOKEN_TTL_DAYS` | token signing and lifetimes |
| `ENCRYPTION_KEY` | at-rest encryption for stored secrets |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_IDS`, `GOOGLE_CLIENT_SECRET` | Google sign-in (web + mobile audiences) |
| `SMTP_*` | transactional mail |
| `CLOUDINARY_*` | media uploads |
| `FIREBASE_*` | push notifications |

> **`.env` points at production.** The committed environment carries live Neon
> and Upstash credentials, so a locally-run API reads and writes **production
> data**. Reads are safe; think before running anything that writes. Scripts
> that mutate offer `--dry-run`.

## Modules

| Module | Responsibility |
|---|---|
| `auth` | register/login, JWT access + single-use rotating refresh tokens, Google OAuth, password reset |
| `orgs` | organizations, membership, custom roles, permission grants |
| `catalog` | teams, players (public profiles, career stats, leaderboards), venues |
| `tournaments` | tournaments, groups, fixture generation, points table |
| `matches` | match lifecycle, ball-by-ball scoring engine, commentary, scorecards, stats, MVP |
| `realtime` | Socket.IO gateway; broadcasts state over Redis pub/sub so any node can serve any match |
| `engagement` | follows, device registration, in-app + FCM notifications |
| `content` | news articles and the CMS page/block system |
| `media` | Cloudinary-backed uploads |
| `saas` | plans, subscriptions, entitlements, plan guards |
| `mail` | SMTP transport with port fallback |
| `common` | guards, decorators, access checks shared across modules |

## Scoring engine

Balls are the source of truth; every derived figure is a rebuild, never an
increment, so re-running finalize after a correction always converges.

- `POST /matches/:id/balls` carries `client_event_id` (idempotency) and
  `expected_seq` (optimistic concurrency) — a `409` means the client must resync.
- `POST /matches/:id/balls/batch` drains the mobile offline outbox in order.
- Corrections supersede rather than delete (`is_superseded`), preserving lineage.
- Lifecycle: toss → openers → play → innings break → declare / follow-on /
  rain (DLS) → finalize with player of the match → super over on a tie.

## Statistics and MVP

`StatsService.finalizeMatch` rebuilds per-match facts, MVP points, tournament
and career rollups, head-to-head, and notifies followers.

The MVP formula is specified in [`docs/MVP_SCORING.md`](docs/MVP_SCORING.md) —
keep it in step with `buildMvpPoints()` whenever either changes.

```bash
npm run mvp:recalc -- --dry-run   # re-score every completed match, rolled back
npm run mvp:recalc                # commit (rewrites live MVP figures)
npm run mvp:audit                 # regenerate docs/MVP_AUDIT_TOP3.html
```

`mvp:audit` recomputes every term **independently of the SQL engine** and
reconciles against the stored figure, so a drift between the code and the
published rules surfaces as a mismatch rather than going unnoticed.

Use `recalculateMvp()` rather than `finalizeMatch()` to replay a finished
match: `notifications` has no unique constraint, so re-finalizing would send
every follower a duplicate result alert.

## Regenerating the API spec

`doc/apidoc.json` is committed so clients can diff it. `src/swagger-config.ts`
is the single source of truth shared by `main.ts` and the generator, so the
committed spec cannot drift from what the running API advertises.

```bash
npm run build && npm run openapi
```

## Scripts

| Command | What it does |
|---|---|
| `npm run db:migrate` | apply pending SQL migrations |
| `npm run openapi` | regenerate `doc/apidoc.json` |
| `npm run mvp:recalc` | re-score completed matches (`--dry-run` supported) |
| `npm run mvp:audit` | rebuild the top-3 MVP reconciliation report |
| `npm run smoke` | smoke-test a running instance |
| `npm run lint` | ESLint over `src/` |

`scripts/e2e-*.js` cover scoring, permissions, realtime and reopen flows;
`scripts/seed-demo.js` populates a demo dataset.

## Deploy

> **The live deployment is cPanel shared hosting (LiteSpeed + Phusion
> Passenger).** Build and ship it with `npm run release` — see
> [`BUILD.md`](BUILD.md). The Render/Vercel notes below describe an earlier
> plan and are not how the API runs today.

[`render.yaml`](render.yaml) deploys this service on Render as the realtime
node (`/health` is the health check). The REST API can additionally run on
Vercel — both share the same Neon and Upstash instances, and the Socket.IO
gateway subscribes to the same Redis channels, so a ball scored through either
node reaches every connected client.

After deploying, point the frontend's `NEXT_PUBLIC_WS_URL` at the Render URL.

[`app.js`](app.js) is the **cPanel / Phusion Passenger** entry point for hosts
that boot a plain Node file rather than running `npm start`. It loads `.env`
from its own directory before booting Nest, so the app never depends on
Passenger's working directory and secrets containing spaces, braces or
newlines (`FIREBASE_SERVICE_ACCOUNT`, `SMTP_PASS`) survive intact. It requires
`dist/`, so build before deploying.

## Database

Schema is hand-written SQL in [`migrations/`](migrations), applied in filename
order and tracked in `schema_migrations`. Services use parameterized queries
through a shared `pg` pool (`PG_POOL`) rather than an ORM.

When adding a migration, keep the numeric prefix contiguous and never edit one
that has already been applied in production — add a new file instead.
