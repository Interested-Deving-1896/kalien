# ZK Asteroids Proof Gateway Spec

Last updated: 2026-03-02

## Purpose

Defines the current API/queue/DO behavior for proof submission, prover dispatch,
artifact storage, and claim relay.

## Runtime Shape

Browser -> `POST /api/proofs/jobs?seed_id=<u32>&claimant=<G...|C...>` -> Worker

Worker components:
- API router (`worker/api/routes.ts`)
- Proof routes (`worker/api/routes-proofs.ts`)
- Durable Object coordinator (`worker/durable/coordinator.ts`)
- Queue consumers (`worker/queue/consumer.ts`)
- Tape parser/validator (`worker/tape.ts`)
- Artifact storage in R2 (`PROOF_ARTIFACTS`)

Queues/backends:
- `PROOF_QUEUE`: Boundless path (parallel)
- `VAST_QUEUE`: Vast path (serial 1-at-a-time)
- `CLAIM_QUEUE`: on-chain `submit_score` relay after proof success

## Public API

### `GET /api/health`
Returns worker and prover compatibility status.

### `POST /api/proofs/jobs`
Request body: raw tape bytes (`application/octet-stream`).
Required query params:
- `seed_id` (u32)
- `claimant` (Stellar `G...` or `C...`)

Ingress checks:
- tape format/version/rules tag/checksum
- size <= `MAX_TAPE_BYTES`
- `final_score > 0`
- sliding-window rate limit (IP + claimant)

Success response (`202`) returns `status_url` and public job snapshot.

### `GET /api/proofs/jobs/:jobId`
Returns current job status and attempt history.
Includes timeout diagnostics (`errorCode`, `timeoutPhase`) and phase timing
fields (`queue.waitElapsedMs`, `prover.runElapsedMs`) when present.

### `POST /api/proofs/jobs/:jobId/retry-proof`
Manual retry for failed proof jobs.

Query params:
- `backend=auto|boundless|vast` (default: `auto`)

Returns updated job snapshot after re-queue.

### `POST /api/proofs/jobs/:jobId/retry-claim`
Manual retry for failed claim submission after a succeeded proof.

Returns updated job snapshot after re-queue.

### `GET /api/proofs/jobs/:jobId/result`
Returns `ProofArtifactV4` when job succeeded.

## Status Model

Coordinator statuses:
- `queued`
- `dispatching`
- `prover_running`
- `retrying`
- `succeeded`
- `failed`

Claim statuses:
- `queued`
- `submitting`
- `retrying`
- `succeeded`
- `failed`

## Coordinator Behavior

- Multiple active jobs are tracked via `ACTIVE_JOBS_KEY = "active_job_ids"`.
- Durable Object alarm drives polling and retries.
- Terminal jobs are retained by retention/max-count policy.
- Result artifacts are kept in R2; DO record cleanup does not immediately delete result artifacts.
- Timeout attribution is explicit:
  - `job_total_wall_timeout` (`timeoutPhase=total_wall`)
  - `vast_slot_wait_timeout` (`timeoutPhase=vast_wait`)
  - `prover_run_timeout` (`timeoutPhase=prover_run`)

## Backend Selection

Submission queue is selected at ingress:
- Boundless configured -> enqueue to `PROOF_QUEUE`
- else if `PROVER_BASE_URL` configured -> enqueue to `VAST_QUEUE`
- else reject with `503` (`prover backend is not configured`)

Retry/fallback is handled in coordinator/consumer logic and can span multiple
attempts/backends (not single-attempt only).

## Artifact Contract

Successful proofs are stored as `ProofArtifactV4` in R2:
- `version: "v4"`
- `backend: "boundless" | "vast"`
- `seal_hex`
- `journal_raw_hex`
- `journal_digest_hex`
- `requested_receipt_kind`
- `produced_receipt_kind`

## Key Config

Worker:
- `MAX_TAPE_BYTES`
- `MAX_PROOF_TOTAL_WALL_TIME_MS`
- `MAX_PROVER_RUN_TIME_MS`
- `PROVER_POLL_INTERVAL_MS`
- `PROVER_POLL_BUDGET_MS`
- `PROVER_POLL_TIMEOUT_MS`
- `MAX_COMPLETED_JOBS`
- `COMPLETED_JOB_RETENTION_MS`

Prover API (`kalien-verifier/api-server`):
- `MAX_FRAMES`
- `MAX_JOBS`
- `RUNNING_JOB_TIMEOUT_SECS`
- `TIMED_OUT_PROOF_KILL_SECS`
- `API_KEY`

## Security And Correctness Guarantees

- `seed_id` + `claimant` are mandatory and validated at gateway and prover ingress.
- Prover `proof_mode` is policy-controlled (`RISC0_DEV_MODE`), not client-controlled.
- Contract verifies journal digest + image ID and enforces claimant/seed-scoped score policy.

## Source Of Truth Files

- `worker/api/routes.ts`
- `worker/api/routes-proofs.ts`
- `worker/durable/coordinator.ts`
- `worker/queue/consumer.ts`
- `worker/types.ts`
- `worker/constants.ts`
- `kalien-verifier/api-server/src/main.rs`
- `kalien-verifier/api-server/src/handlers.rs`
