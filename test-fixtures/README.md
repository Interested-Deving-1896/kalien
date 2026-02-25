# Test Fixtures Status

Last reviewed: 2026-02-24

## Canonical Tape Fixtures

- `test-short.tape`
  - Seed: `0xdeadbeef`
  - Frames: `500`
  - Score: `1030`
- `test-medium.tape`
  - Seed: `0xdeadbeef`
  - Frames: `3980`
  - Score: `90`
- `test-real-game.tape`
  - Seed: `0x43c9c6cd`
  - Frames: `13829`
  - Score: `32860`
  - SHA-256: `60f7d595dcf7ebc288723ffb2cf115668d1a95bbaa85530eec62cea36fe67775`

## Additional Validated Tape (Not Canonical)

- `test-real-game-26360.tape`
  - Source: `/Users/kalepail/Downloads/asteroids-19c4dbd5fb7-26360.tape`
  - Seed: `0x4dbd5fb7`
  - Frames: `13001`
  - Score: `26360`
  - SHA-256: `9126d02488bfad307aa2e0caf9537d998df99d8d0868a71387d0e44d4998ee5e`
  - Replay verification: `bun run verify-tape test-fixtures/test-real-game-26360.tape`

## Canonical Groth16 Proof Fixtures

All three proof fixture sets are current:
- `proof-short-groth16.*`, `proof-medium-groth16.*`, `proof-real-game-groth16.*`
  - Rules digest: `0x41535433` (`AST3`)
  - Image ID: `c2d61eb93372c44376c6c46eea2656d3c88a67eba4998456d014908d24d5e3a0`

## Candidate Tape Promotion Guidance

If you consider replacing `test-real-game.tape`, treat it as a breaking fixture change:

1. Verify tape determinism:
   - `bun run verify-tape <candidate.tape>`
2. Replace `test-real-game.tape`.
3. Regenerate Groth16 fixtures:
   - `bash kalien-contract/scripts/regenerate-proofs.sh https://risc0-kalien.stellar.buzz`
4. Update score expectations in tests and scripts (for example `32860` references).
5. Re-run contract and gateway test suites.

Recommendation: keep `test-real-game.tape` as canonical (it already has matching proof fixtures and test expectations) and treat downloaded tapes as additional regression fixtures unless you explicitly want to re-baseline scores and regenerate proofs.
