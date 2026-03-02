# Provisioning & Timeout Reference (Current)

Last reviewed: 2026-03-02

This document is the source-of-truth reference for proof/claim timeout behavior in
production.

## Scope

- Worker gateway: `worker/`
- Prover API server: `kalien-verifier/api-server/`
- Queue consumers: `PROOF_QUEUE`, `VAST_QUEUE`, `CLAIM_QUEUE`

## Worker Timeout Model

The worker now uses two explicit wall-time controls:

- `MAX_PROOF_TOTAL_WALL_TIME_MS` (default/deployed: `3900000`, 65 min)
  - End-to-end cap for a proof job lifetime in the gateway (queued + retries + proving + writes).
  - Also the queue-wait cap for jobs waiting on a busy VAST slot.
- `MAX_PROVER_RUN_TIME_MS` (default/deployed: `660000`, 11 min)
  - Cap for a single active prover run occupying the slot.
  - Used for stale VAST slot recovery and alarm-time run timeout checks.

`MAX_JOB_WALL_TIME_MS` is legacy and should not be used in active configs/docs.

### Worker timeout + retry inventory

| Setting | Current value | Env var | Source |
|---|---:|---|---|
| Poll interval | 3000 ms | `PROVER_POLL_INTERVAL_MS` | `worker/constants.ts`, `wrangler.jsonc` |
| Poll budget per alarm run | 45000 ms | `PROVER_POLL_BUDGET_MS` | `worker/constants.ts`, `wrangler.jsonc` |
| Absolute poll timeout | 660000 ms (11 min) | `PROVER_POLL_TIMEOUT_MS` | `worker/constants.ts`, `wrangler.jsonc` |
| Per-request prover HTTP timeout | 30000 ms | `PROVER_REQUEST_TIMEOUT_MS` | `worker/constants.ts`, `wrangler.jsonc` |
| Total proof wall-time cap | 3900000 ms (65 min) | `MAX_PROOF_TOTAL_WALL_TIME_MS` | `worker/constants.ts`, `wrangler.jsonc` |
| Active prover run cap | 660000 ms (11 min) | `MAX_PROVER_RUN_TIME_MS` | `worker/constants.ts`, `wrangler.jsonc` |
| Max queue retries (Boundless queue) | 10 | queue `max_retries` + `MAX_QUEUE_RETRIES` | `wrangler.jsonc`, `worker/constants.ts` |
| Max queue retries (VAST queue) | 30 | queue `max_retries` + `MAX_VAST_QUEUE_RETRIES` | `wrangler.jsonc`, `worker/constants.ts` |
| VAST slot-busy retry delay | 30 s | (constant) | `worker/constants.ts` |
| Retry backoff ceiling | 60 s | (constant) | `worker/constants.ts` |

### Timeout attribution on jobs

Job records expose both `errorCode` and `timeoutPhase` to clarify what timed out:

| Condition | `errorCode` | `timeoutPhase` | Trigger path |
|---|---|---|---|
| Job exceeded total wall clock | `job_total_wall_timeout` | `total_wall` | queue pre-submit + DO alarm loop |
| VAST queue wait exceeded total wall cap | `vast_slot_wait_timeout` | `vast_wait` | VAST consumer slot-busy path |
| Active run exceeded run cap | `prover_run_timeout` | `prover_run` | stale-slot recovery + DO alarm |

The public job response can also include:

- `queue.waitStartedAt`, `queue.waitElapsedMs`
- `prover.runStartedAt`, `prover.runElapsedMs`

## Queue Behavior

### Boundless (`PROOF_QUEUE`)

- Parallel queue consumer (`max_concurrency: 5`)
- Submission is blocked when `jobAge > MAX_PROOF_TOTAL_WALL_TIME_MS`
- Retry/backoff is bounded by queue retries + `MAX_RETRY_DELAY_SECONDS`

### VAST (`VAST_QUEUE`)

- Serial queue consumer (`max_concurrency: 1`)
- If slot busy:
  - retry after 30s
  - fail with `vast_slot_wait_timeout` if total wall time cap is exceeded
- Stale slot recovery:
  - if active VAST job appears stale past run cap, `kickAlarm()` is attempted
  - if still stale, active job is failed with `prover_run_timeout`

### Claims (`CLAIM_QUEUE`)

- Claim retries are independent from proof retries
- Manual retry endpoints are available:
  - `POST /api/proofs/jobs/:jobId/retry-proof?backend=auto|boundless|vast`
  - `POST /api/proofs/jobs/:jobId/retry-claim`

## Prover API Server Inventory

| Setting | Current value | Env var | Source |
|---|---:|---|---|
| Running job timeout | 600 s (10 min) | `RUNNING_JOB_TIMEOUT_SECS` | `.env.example`, `src/main.rs` |
| Timed-out proof kill grace | 60 s | `TIMED_OUT_PROOF_KILL_SECS` | `.env.example`, `src/main.rs` |
| Job TTL | 86400 s (24h) | `JOB_TTL_SECS` | `.env.example`, `src/main.rs` |
| Job sweep interval | 60 s | `JOB_SWEEP_SECS` | `.env.example`, `src/main.rs` |
| Max jobs stored | 64 | `MAX_JOBS` | `.env.example`, `src/main.rs` |
| Max frames | 36000 | `MAX_FRAMES` | `.env.example`, `src/main.rs` |
| Max tape bytes | 2097152 (2 MiB) | `MAX_TAPE_BYTES` | `.env.example`, `src/main.rs` |
| HTTP max connections | 25000 | `HTTP_MAX_CONNECTIONS` | `.env.example`, `src/main.rs` |
| HTTP keep alive | 75 s | `HTTP_KEEP_ALIVE_SECS` | `.env.example`, `src/main.rs` |

## Operational Expectations

- Typical successful proofs: around ~1-5 minutes, depending on workload and GPU conditions.
- Active prover run should not occupy the slot past ~11 minutes in worker tracking.
- VAST queue wait can legitimately be much longer than 30 minutes when backlog exists, up to the 65-minute total wall cap.
- If you observe repeated `prover_run_timeout` or `vast_slot_wait_timeout`, treat this as capacity or stuck-job pressure, not a normal transient.

## Current Deployed Worker Vars (wrangler)

```jsonc
"PROVER_POLL_INTERVAL_MS": "3000",
"PROVER_POLL_TIMEOUT_MS": "660000",
"PROVER_POLL_BUDGET_MS": "45000",
"PROVER_REQUEST_TIMEOUT_MS": "30000",
"MAX_PROOF_TOTAL_WALL_TIME_MS": "3900000",
"MAX_PROVER_RUN_TIME_MS": "660000"
```

## Validation Checklist

1. Confirm deployed worker vars match this doc.
2. Submit a proof and verify job payload includes expected timeout fields when failures occur.
3. For VAST backlog scenarios, verify failures classify as:
   - `vast_slot_wait_timeout` for queue wait expiry
   - `prover_run_timeout` for stale active run expiry
4. Verify prover health still reports expected accelerator and image compatibility.

## Source-of-Truth Files

- `worker/constants.ts`
- `worker/env.ts`
- `worker/queue/consumer.ts`
- `worker/durable/coordinator.ts`
- `worker/types.ts`
- `worker/api/routes-proofs.ts`
- `wrangler.jsonc`
- `kalien-verifier/api-server/src/main.rs`
- `kalien-verifier/api-server/.env.example`
