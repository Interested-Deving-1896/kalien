# Contract Script Operations

Scripts for fixture verification, fixture regeneration, and testnet deployment.

## Prerequisites

- `stellar` CLI (v25+)
- `bun` (for TypeScript proof tooling)
- network access to testnet and prover endpoint

## Scripts

- `verify-proofs.sh`
  - Verifies existing Groth16 fixtures against the verifier (read-only invocation).
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

## Environment And State

Contract scripts load env values with this precedence (later wins):

1. repo root `.env`
2. repo root `.dev.vars`
3. `kalien-contract/.env`

Reusable deployment state for `deploy-and-test.sh --deploy-mode reuse` and
`cost-analysis.sh --deploy-mode reuse` is stored in `kalien-contract/.env`.
