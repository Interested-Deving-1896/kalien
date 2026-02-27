# Autopilot Lab

Rust autopilot programs for deterministic Asteroids tape generation,
verification, and benchmarking.

## Purpose

- Generate high-quality deterministic tapes.
- Benchmark bot rosters under fixed seeds.
- Promote AST4-compatible artifacts into `records/`.

## Canonical Roster Source

Active benchmark roster is defined in `scripts/bot-roster.sh`.

Current groups:
- Omega: `omega-marathon`, `omega-lurk-breaker`, `omega-ace`, `omega-alltime-hunter`, `omega-supernova`
- Offline: `offline-wrap-endurancex`, `offline-wrap-sniper30`, `offline-wrap-frugal-ace`, `offline-wrap-apex-score`, `offline-wrap-sureshot`, `offline-supernova-hunt`

## Layout

- `src/`: bot engines, CLI commands, benchmark/runner logic
- `records/`: promoted champions and keep-lists
- `scripts/`: benchmark and artifact maintenance scripts
- `codex-tuner/`: adaptive profile tuning loop
- `evolve/`: evolution loop artifacts

## Quick Start

From `autopilot/`:

```bash
cargo run --release -- list-bots
```

```bash
cargo run --release -- generate \
  --bot omega-marathon \
  --seed 0xDEADBEEF \
  --max-frames 18000 \
  --output checkpoints/omega-marathon-seeddeadbeef.tape
```

```bash
cargo run --release -- verify-tape \
  --input checkpoints/omega-marathon-seeddeadbeef.tape \
  --max-frames 108000
```

```bash
cargo run --release -- benchmark \
  --bots omega-marathon,omega-ace,offline-wrap-endurancex \
  --seed-start 0x00000001 \
  --seed-count 24 \
  --max-frames 108000 \
  --objective survival \
  --jobs 8
```

## Promotion and Checks

From `autopilot/`:

```bash
cargo run --release -- roster-manifest --output records/latest-roster-manifest.json
cargo test --release
AUTOPILOT_STRICT_ARTIFACTS=1 cargo test --release --test champion_registry
```

## Scripted Suites

See [autopilot/scripts/README.md](scripts/README.md) for script-by-script usage.
