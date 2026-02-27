# Shared Stellar Utilities

Utilities shared across worker and scripts for AST4 journal and claimant handling.

## Files

- `journal.ts`
  - Packs/unpacks 64-byte AST4 journal payloads.
  - Encodes claimant as `kind(1) + id(32)`.
  - Enforces reserved-byte invariants.
- `strkey.ts`
  - Normalizes claimant input.
  - Validates Stellar `G...` (account) and `C...` (contract) StrKeys.

## Consumers

Used by:

- `worker/` API validation and claim flow
- `kalien-contract/scripts/generate-proof.ts`
- other scripts that submit prover jobs or verify journal payloads

## Invariants

- Journal length is exactly 64 bytes.
- Claimant encoding length is exactly 33 bytes.
- Rules digest and journal structure must match contract expectations.
