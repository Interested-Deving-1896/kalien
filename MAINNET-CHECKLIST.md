# Mainnet Go-Live Checklist (Current)

Last reviewed: 2026-02-28

This is the active, execution-oriented checklist for current architecture.

---

## 1. Release Inputs Frozen

- [ ] Freeze one release commit for worker, prover, contract, and frontend.
- [ ] Pin deployment scripts/toolchains to immutable versions (no floating `main/latest`).
- [ ] Freeze one production `IMAGE_ID_HEX` and verify it matches:
  - prover health output,
  - worker compatibility expectations,
  - score contract config.
- [ ] Freeze canonical mainnet contract IDs and relayer endpoints in env docs.

## 2. Security And Access

- [ ] Set strong prover `API_KEY` and matching worker `PROVER_API_KEY`.
- [ ] Keep `RISC0_DEV_MODE=0` in production proving.
- [ ] Keep prover transport secure (`PROVER_BASE_URL` over HTTPS, `ALLOW_INSECURE_PROVER_URL=0`).
- [ ] Restrict prover exposure via Cloudflare Tunnel/Access and set `CORS_ALLOWED_ORIGIN` deliberately.
- [ ] Keep destructive prover API actions authenticated (delete path only usable when auth is enabled).
- [ ] Protect dev-only worker endpoints with strong `DEV_API_KEY` (Bearer).

## 3. Worker + Prover Runtime Readiness

- [ ] Choose one active proving path for deployment intent:
  - Boundless configured, or
  - Vast configured.
- [ ] If Boundless is enabled, verify required secrets/config (`BOUNDLESS_PRIVATE_KEY`, `PINATA_JWT`, chain/image settings).
- [ ] Align timeout guardrails across worker + prover:
  - `RUNNING_JOB_TIMEOUT_SECS`
  - `TIMED_OUT_PROOF_KILL_SECS`
  - `PROVER_POLL_*`
  - `MAX_PROOF_TOTAL_WALL_TIME_MS`
  - `MAX_PROVER_RUN_TIME_MS`
- [ ] Verify queue retry ceilings and DO alarm polling behavior in production config.
- [ ] Verify retention cleanup:
  - DO pruning (`MAX_COMPLETED_JOBS`, `COMPLETED_JOB_RETENTION_MS`)
  - R2 lifecycle for `proof-jobs/` artifacts.
- [ ] Run prover under supervisor autorestart and verify crash recovery behavior.

## 4. Contract + Token Readiness

- [ ] Create/use a true mainnet contract deploy path (not testnet-default scripts/config).
- [ ] Confirm and pin mainnet RISC0 verifier addresses.
- [ ] Deploy mainnet SAC `KALIEN`; record canonical `TOKEN_ID`.
- [ ] Deploy score contract with correct verifier/image/token IDs; record canonical contract ID.
- [ ] Transfer token admin to score contract and verify mint authority works.
- [ ] Move admin control to multisig/cold custody and document emergency admin operations.
- [ ] Finalize and document token governance/supply policy.

## 5. Frontend + Relay Integration

- [ ] Set production frontend envs:
  - `VITE_RPC_URL`
  - `VITE_NETWORK_PASSPHRASE`
  - `VITE_ACCOUNT_WASM_HASH`
  - `VITE_WEBAUTHN_VERIFIER_ADDRESS`
  - `VITE_RELAYER_PROXY_URL`
  - `VITE_SCORE_CONTRACT_ID`
- [ ] Verify seed flow uses live epoch source (`/api/seed/current`, fallback `/api/seed/refresh`).
- [ ] Verify proof submits use:
  - `POST /api/proofs/jobs?seed_id=<u32>&claimant=<G...|C...>`
  - `application/octet-stream` body.
- [ ] Verify proof -> claim lifecycle UX:
  - status polling,
  - restore in-progress jobs,
  - retry claim on failed claim state.
- [ ] Verify relay path uses `/api/relay` (or `VITE_RELAYER_PROXY_URL`) with strict request validation.

## 6. Determinism + Correctness

- [ ] Run TS↔Rust parity checks for score/checksum determinism.
- [ ] Confirm `RULES_DIGEST`/ruleset consistency across worker, prover, and contract (`AST4`).
- [ ] Confirm known seed-epoch authority gap is tracked and risk-accepted for launch if not fixed yet (`docs/SEED_EPOCH_CLOCK_AUTHORITY.md`).
- [ ] Verify contract journal checks and claimant binding behavior with current proof artifacts.

## 7. End-to-End Rehearsal

- [ ] Run preflight checks:
  - `bash kalien-contract/scripts/deploy-and-test.sh --proof-mode all`
  - `bash scripts/smoke-test-prover.sh --url "$PROVER_BASE_URL"`
- [ ] Run core test gates:
  - `bun run typecheck`
  - `bun test tests/src tests/shared tests/worker`
- [ ] Run UI E2E (`bun scripts/e2e-ui.ts`).
- [ ] Run pipeline E2E (`bun scripts/e2e-leaderboard.ts`).
- [ ] Validate one full real flow: play -> prove -> claim -> mint -> leaderboard visibility.

## 8. Go/No-Go Signoff

- [ ] Engineering signoff
- [ ] Security signoff
- [ ] Ops signoff
- [ ] Product signoff
- [ ] Launch window + rollback owner assigned
