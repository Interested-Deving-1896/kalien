# Test Fixtures Status

Last reviewed: 2026-02-27

## Canonical Tape Fixtures (v3 format — nibble-packed)

- `test-short.tape`
  - Seed: `0xdeadbeef`
  - Frames: `700`
  - Score: `1480`
- `test-medium.tape`
  - Seed: `0xdeadbeef`
  - Frames: `5000`
  - Score: `11190`
- `test-long.tape`
  - Seed: `0x7f80916e`
  - Frames: `36000`
  - Score: `92820`
- `test-real-game.tape`
  - Seed: `0x43c9c6cd`
  - Frames: `6643`
  - Score: `14870`

## Additional Validated Tape (Not Canonical)

- `test-real-game-26360.tape`
  - Seed: `0x4dbd5fb7`
  - Frames: `7328`
  - Score: `15200`
  - Replay verification: `bun run verify-tape test-fixtures/test-real-game-26360.tape`

## Groth16 Proof Fixtures

**Note:** Proof fixtures (`proof-short-groth16.*`, `proof-medium-groth16.*`,
`proof-real-game-groth16.*`) are **stale** — they were generated from v2 tapes
and need to be regenerated via:

```
bash kalien-contract/scripts/regenerate-proofs.sh https://risc0-kalien.stellar.buzz
```

## Tape Format v3 (current)

All tapes use the nibble-packed v3 format:
- Version: 3
- Body: `ceil(frameCount/2)` bytes (2 frames per byte, low nibble first)
- Footer: `finalScore(4) + finalRngState(4) + checksum(4)` = 12 bytes
- Size reduction: ~50% vs v2

## Candidate Tape Promotion Guidance

If you consider replacing `test-real-game.tape`, treat it as a breaking fixture change:

1. Verify tape determinism:
   - `bun run verify-tape <candidate.tape>`
2. Replace `test-real-game.tape`.
3. Regenerate Groth16 fixtures:
   - `bash kalien-contract/scripts/regenerate-proofs.sh https://risc0-kalien.stellar.buzz`
4. Update score expectations in tests and scripts.
5. Re-run contract and gateway test suites.
