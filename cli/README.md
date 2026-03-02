# Kalien CLI

Terminal client for autonomous Asteroids farming and tape replay.

## Commands

- `kalien run --address <G...|C...>`: run autopilot workers and submit tapes.
- `kalien replay <file.tape>`: ASCII replay in terminal.
- `kalien ps`: list active `kalien run` processes.
- `kalien cleanup [options]`: terminate stale `kalien run` processes.

### Cleanup options

- `--dry-run`: show what would be terminated without killing processes.
- `--orphan-only`: only target orphaned runs (`PPID=1`, default unless `--all`).
- `--all`: target all matching `kalien run` processes.
- `--older-than <dur>`: only target older processes (`30s`, `10m`, `2h`, `1d`).

## Local Usage

From `cli/`:

```bash
bun run src/index.ts --help
bun run src/index.ts run --address GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF
bun run src/index.ts replay ../test-fixtures/test-short.tape
bun run src/index.ts ps
bun run src/index.ts cleanup --dry-run
bun run src/index.ts cleanup --orphan-only --older-than 5m
```

## Network Defaults And Preflight

- Default network is `testnet`.
- Per-network defaults are applied for API URL, RPC URL, score contract, and token contract.
- Current defaults:
  - testnet API: `https://testnet.kalien.xyz`
  - mainnet API: `https://kalien.xyz`
  - mainnet score contract: `CDDAYXNY6MMA47Q54VSHG2WV445ZUOJ354NOLSFRC7ZUDTD6OTS4A7PE`
- `kalien run` performs preflight checks before workers start:
  - `C...` claimant must exist as a deployed contract on the selected network.
  - `G...` claimant must exist as an account on the selected network and have the KALIEN trustline for that network’s token contract.
  - Score contract must be readable on the selected network.
  - API seed must match RPC seed for the same `seed_id`.

## Build

From `cli/`:

```bash
bun run build
```

Cross-target builds:

```bash
bun run build:all
```

Outputs are written to `cli/dist/`.
