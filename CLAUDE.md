# CricLive backend (NestJS)

Deployed as a built `dist/` upload to cPanel/Passenger — see the root
`CLAUDE.md` for hosting, env, and the cross-cutting invariants.

## Shape

`src/` modules: `auth`, `orgs`, `catalog` (formats/venues/teams/players),
`tournaments`, `matches`, `saas`, `stats` (inside `matches/`), `content` (CMS/news),
`engagement` (follows/devices/notifications/FCM), `media`, `mail`, `realtime`,
`redis`, `database`, `health`, `common`.

The whole scoring domain lives in `src/matches/`:

| file | role |
|---|---|
| `rules-engine.ts` | pure `(state, event, rules) → next state + effects`. No I/O. |
| `scoring.service.ts` | the hot path and every state transition (toss → openers → ball → innings → result) |
| `matches.service.ts` | reads: detail, scorecard, commentary, overs, stats |
| `stats.service.ts` | finalize-time rollups: per-match, tournament, career, head-to-head, MVP |
| `live-state.service.ts` | Redis write-through + pub/sub |

`realtime/live.gateway.ts` relays whatever is published to `live:match:{id}` into
the Socket.IO room `match:{id}` — it whitelists nothing, so a new event name
works with no gateway change, but a client only sees it if `useLive.ts` (web) or
the mobile socket layer subscribes to that name.

## The scoring hot path

Every mutation goes through `withMatch()`: `BEGIN` → `SELECT … FOR UPDATE` on the
match row → work → `COMMIT`. Postgres is the durable checkpoint; Redis is warmed
**post-commit** via `live.syncAndPublish(...)`. Clients pass `expected_seq`
(optimistic check) and `client_event_id` (idempotency), so retries, duplicate
taps, and a stale scorer are all safe.

Order matters when an innings ends: apply `innings_complete` first, then
`match_complete`. `completeInnings` deliberately returns early for the final
innings, leaving `live_state.engine` intact so `completeMatch` can read the chase
total off it. Any new path that closes an innings has to follow that order —
see the `closeInningsNow` block in `updateSettings` for the pattern, and use
`chaseCloseEffect()` from `rules-engine.ts` rather than re-deriving the
tie/super-over verdict.

`replayInnings()` rebuilds every derived value (cards, over summaries, innings
totals, auto commentary) from the ball stream, and backs both undo and ball
correction. Auto commentary is derived data — each body bakes in the running
score, so it is rebuilt wholesale, never patched.

## Migrations

Canonical SQL lives in `../../database/`, mirrored into `migrations/`. Both
copies must be updated together.

```bash
npm run db:migrate     # idempotent, tracked in schema_migrations
```

## Scripts

`scripts/` is the test suite — there is no jest/vitest here. Each E2E logs in,
builds a throwaway org (slug `e2e-club-*`), exercises real HTTP endpoints
against a locally-run backend on the **production** DB, and asserts.

| | |
|---|---|
| `smoke.js` | verifies Neon / Cloudinary / SMTP credentials |
| `e2e-test.js` | full match: toss → score → scorecard → points → stats → MVP |
| `e2e-realtime.js` | Redis live state, WebSocket push, super over, follow-on |
| `e2e-features.js` | profile, RBAC admin, officials, quotas, interruptions/DLS |
| `e2e-permissions.js` | owner can CRUD, viewer gets 403 |
| `e2e-reopen.js` | undo a declare, auto commentary |
| `e2e-batch2.js` | opener self-heal, player profile fields, format overrides |
| `e2e-overs-change.js` | changing overs-per-innings mid-match, both innings |
| `cleanup-e2e.js` | **run this after any E2E** — drops every `e2e-club-*` org |
| `mail-doctor.js` | run on the sending server; separates blocked port vs auth vs delivery |
| `recalculate-mvp.js` | replays the MVP formula over completed matches |
| `backfill-over-summaries.js` | dry-run by default, `--apply` to write |

## Writing against the production DB

`.env` is production. Before any write-shaped investigation:

- Dry-run in a transaction and `ROLLBACK`, diffing before/after, then re-run
  with `--apply`. This has caught more than one bad assumption.
- **Never** re-run `StatsService.finalizeMatch` for a backfill — its
  `notifyFollowers` has no unique constraint behind it and will spam every
  follower with duplicate result alerts. Use `recalculateMvp()` or call the
  individual `build*`/`rebuild*` methods.
- Hand-copying SQL into a scratch script to "check" a bug can silently fix the
  bug you are hunting. Call the compiled endpoint instead.

## Backend-specific gotchas

- `PlayersController` had a class-level `@UseGuards(JwtAuthGuard)` that made
  documented-public routes require auth; it was removed there. **`TeamsController`
  still has the same bug** — `GET /teams/:teamId` and `/teams/:id/stats` require
  auth despite being intended as public.
- Enum/array/smallint casts are required inside `coalesce()` — see root `CLAUDE.md`.
- Postgres `now()` is frozen per transaction, so two rows inserted in the same TX
  tie on `created_at`. Commentary ordering relies on deliberate offsets:
  ball → `now()`, over summary → `+1ms`, innings summary → `+2ms`.
- `player_career_stats` is the only aggregate with no `match_id`, so it neither
  cascades on match delete nor gets revisited. Deleting a match without calling
  `rebuildCareerStatsForPlayers` leaves phantom career totals on the leaderboard.
- Matches are tournament-required (`CreateMatchDto.tournament_id` is mandatory),
  so any script creating a match needs a tournament plus attached teams first.
- Plan quotas throw 402 `PLAN_LIMIT` on team/tournament create and at toss
  (`max_concurrent_matches`); a suite needing more than one tournament must
  upgrade the org's plan first.
