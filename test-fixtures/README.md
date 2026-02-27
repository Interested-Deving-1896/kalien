# Test Fixtures Status

Last reviewed: 2026-02-27

## Canonical Tape Fixtures (v3 nibble-packed)

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

## Verification Commands

`bun run verify-tape` uses a default frame cap of `18000`, so it works for
short/medium/real fixtures but not `test-long.tape`.

```bash
bun run verify-tape test-fixtures/test-real-game-26360.tape
```

For long tapes, use autopilot verifier with explicit max frames:

```bash
cargo run --release --manifest-path autopilot/Cargo.toml -- verify-tape \
  --input test-fixtures/test-long.tape \
  --max-frames 108000
```

## Groth16 Proof Fixtures

`proof-*-groth16.seal` fixtures exist. Some historical `journal_raw` files were
removed when stale AST3 artifacts were retired.

Regenerate proof fixtures for the current prover/ruleset:

```bash
bash kalien-contract/scripts/regenerate-proofs.sh https://risc0-kalien.stellar.buzz
```

## Tape Format v3

- Version: `3`
- Body: `ceil(frameCount/2)` bytes (2 frames per byte, low nibble first)
- Footer: `finalScore(4) + finalRngState(4) + checksum(4)` = 12 bytes

## Candidate Promotion Checklist

1. Verify determinism.
2. Replace target tape fixture.
3. Regenerate Groth16 fixtures.
4. Update score expectations in tests/scripts.
5. Re-run contract and gateway tests.
