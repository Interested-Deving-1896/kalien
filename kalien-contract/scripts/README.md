# Contract Script Operations

Scripts for fixture verification, fixture regeneration, and testnet deployment.

## Prerequisites

- `stellar` CLI (v25+)
- `bun` (for TypeScript proof tooling)
- network access to testnet and prover endpoint

## Scripts

- `verify-proofs.sh`
  - Verifies existing Groth16 fixtures against the router (read-only invocation).
- `regenerate-proofs.sh [prover-url]`
  - Rebuilds fixture proofs from tapes and re-verifies them on-chain.
- `deploy-and-test.sh`
  - Deploys test contracts and runs integration assertions.

## Usage

From `kalien-contract/`:

```bash
bash scripts/verify-proofs.sh
bash scripts/regenerate-proofs.sh https://risc0-kalien.stellar.buzz
bash scripts/deploy-and-test.sh --proof-mode all
```

## Shared Helpers

`_helpers.sh` centralizes paths, testnet constants, key setup, and journal/hash
helpers used by all script entry points.
