# Leaderboard D1 Migration Runbook

This project now stores leaderboard data in D1 (`LEADERBOARD_DB`) while keeping proof orchestration in Durable Objects.

## Scope

- Moved to D1:
  - leaderboard events
  - leaderboard profiles
  - leaderboard ingestion state
- Kept in Durable Objects:
  - proof/job coordinator state machine
  - queue/alarm-based proof lifecycle

## Prerequisites

1. Create a D1 database:
   - `npx wrangler d1 create kalien-leaderboard`
2. Set the returned `database_id` in:
   - `wrangler.jsonc` (`d1_databases[].database_id`)
3. Deploy worker:
   - `npx wrangler deploy`

## Manual data operations (dev-only namespace)

Leaderboard operational endpoints live under `/dev/api/leaderboard/*` and are
guarded by:

- `Authorization: Bearer <DEV_API_KEY>`

Available dev endpoints:

- `POST /dev/api/leaderboard/sync`
- `POST /dev/api/leaderboard/reset`
- `POST /dev/api/leaderboard/seed`

## Verification

1. Trigger sync:
   - `POST /dev/api/leaderboard/sync` with bearer dev key
3. Validate API reads:
   - `GET /api/leaderboard?window=10m`
   - `GET /api/leaderboard?window=day`
   - `GET /api/leaderboard?window=all`
   - `GET /api/leaderboard/player/:claimantAddress`

## Rollback

If needed, keep using pre-migration deployment revision. Legacy data remains in DO storage until you explicitly remove it.

## Notes

- D1 schema is self-initialized by the worker on first access.
- Leaderboard reads remain cache-assisted (`ETag` + short TTL response cache), with rolling cache buckets for time-windowed views.
