# Cloudflare Worker

Gateway/API layer for proof jobs, claim submission, and leaderboard services.

## Responsibilities

- Receives proof job submissions from clients.
- Validates tapes and enqueues work (`PROOF_QUEUE`, `VAST_QUEUE`).
- Coordinates job lifecycle via `ProofCoordinatorDO`.
- Stores artifacts in R2 and leaderboard data in D1.
- Exposes leaderboard profile/auth endpoints.

## Entry Points

- `worker/index.ts`: router wiring, queue handlers, cron jobs.
- `worker/api/routes.ts`: proof/seed/relay API routes.
- `worker/api/leaderboard-routes.ts`: leaderboard and profile APIs.
- `worker/queue/consumer.ts`: queue consumer orchestration.
- `worker/durable/coordinator.ts`: durable job state.

## API Surfaces

- `/api/health`
- `/api/seed/current`, `/api/seed/refresh`
- `/api/proofs/jobs` (+ status/list/delete/retry endpoints)
- `/api/relay`
- `/api/leaderboard/*` (public and profile routes)

Dev leaderboard endpoints are under `/dev/api/leaderboard/*` and should be
protected with `DEV_API_KEY`.
Key maintenance routes:

- `/dev/api/leaderboard/storage-status`
- `/dev/api/leaderboard/backfill-tape-mappings` (+ `/status`)
- `/dev/api/leaderboard/prune-stale-tape-mappings`
- `/dev/api/leaderboard/cleanup-legacy-storage`

## Configuration

Bindings and env interface are defined in `worker/env.ts` and configured via
`wrangler.jsonc`.

## Verification

From repo root:

```bash
bun run typecheck:worker
bun test tests/worker
```
