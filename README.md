<img width="2816" height="1536" alt="kalien-meta-2" src="https://github.com/user-attachments/assets/0137c097-faa9-4e31-83d6-da108b214357" />

# Kalien

Kalien is a deterministic Asteroids stack with:
- a React client (`src/`)
- a Cloudflare Worker gateway/API (`worker/`)
- a RISC Zero prover service (`kalien-verifier/`)
- a Soroban score contract (`kalien-contract/`)
- an autopilot lab for tape generation and benchmarking (`autopilot/`)

## Component Map

- [docs/README.md](docs/README.md): canonical architecture and operations docs
- [worker/README.md](worker/README.md): Worker API, queues, and bindings
- [kalien-verifier/README.md](kalien-verifier/README.md): prover service setup and deployment
- [kalien-contract/README.md](kalien-contract/README.md): on-chain score contract and proof flow
- [autopilot/README.md](autopilot/README.md): deterministic tape generation lab
- [cli/README.md](cli/README.md): `kalien` terminal client
- [test-fixtures/README.md](test-fixtures/README.md): canonical tape/proof fixtures
- [shared/README.md](shared/README.md): shared cross-package utilities

## Quick Start

From repo root:

```bash
bun install
bun run dev
```

Type/lint/format checks:

```bash
bun run check
```

## Notes

- Local secrets/config live in `.env`, `.dev.vars`, and `.codex/` (ignored by git).
- This repo is multi-workspace; run commands from the README for each component to avoid path confusion.
