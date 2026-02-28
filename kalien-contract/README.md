# Kalien Soroban Contract

`kalien-contract/` contains the `asteroids_score` Soroban contract used to verify
RISC Zero receipts and mint score rewards.

## Layout

- `contracts/asteroids_score/`: contract source (`lib.rs`) and tests.
- `scripts/`: deployment, proof regeneration, and verification scripts.
- `target/`: build artifacts.

## Contract Surface

Primary methods in `asteroids_score`:

- `submit_score(seal, journal_raw)`: verifies proof, enforces policy, mints delta rewards.
- `verify_score(seal, journal_raw)`: verifies proof without minting or state mutation.
- `current_seed()`: returns active seed window materialized on-chain.
- `best_score(claimant, seed_id)`: claimant best score for a seed window.
- Admin methods: `set_image_id`, `set_verifier_id`, `set_token_id`, `set_admin`, `set_paused`, `upgrade`.

Rules digest is currently fixed to `AST4` (`0x41535434`).

## Quick Start

From `kalien-contract/contracts/asteroids_score/`:

```bash
stellar contract build
cargo test
```

## Scripted Workflows

From `kalien-contract/`:

```bash
bash scripts/verify-proofs.sh
bash scripts/deploy-and-test.sh
bash scripts/regenerate-proofs.sh https://risc0-kalien.stellar.buzz
```

Script details and prerequisites are documented in
[kalien-contract/scripts/README.md](scripts/README.md).
