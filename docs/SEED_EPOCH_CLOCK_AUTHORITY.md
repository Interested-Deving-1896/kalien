# Seed Epoch Authority Gap (Deferred)

## Status

Deferred for a follow-up implementation pass.

Last reviewed: 2026-02-28

## Problem

The CLI currently derives `seed_id` from local wall-clock time in multiple places.
The score contract derives active seed windows from ledger time. This can drift near
epoch boundaries or under host clock skew.

## Why This Matters

- Can reduce liveness/throughput (skipped or dropped best tapes).
- Can cause workers to farm a seed window that is already stale on-chain.
- Does not bypass contract safety checks: invalid seed windows are rejected.

## Current Behavior References

- Worker local epoch derivation: `cli/src/worker/game-worker.ts`
- CLI seed fetch helper uses local epoch: `src/chain/seed.ts`
- Relayer fallback probes `now` and `now-1`: `cli/src/relayer.ts`
- Run loop submit gating by epoch: `cli/src/commands/run.ts`
- Contract seed-window enforcement: `kalien-contract/contracts/asteroids_score/src/lib.rs`

## Proposed Follow-Up

1. Make chain/ledger time the source of truth for epoch selection in CLI.
2. Resolve seed context as `{ seed_id, seed }` and propagate it end-to-end.
3. Submit tapes with the resolved seed context, not recomputed local epoch.
4. Keep a skew guardrail log/metric when local-vs-chain epoch delta is large.

## Acceptance Criteria For Future Fix

- No local wall-clock recomputation of submit `seed_id`.
- Worker and submit path use the same resolved `seed_id`.
- Boundary tests pass for epoch rollovers and `seed_id-1` fallback.
- No dropped best-tape submissions caused solely by local/chain epoch mismatch.
