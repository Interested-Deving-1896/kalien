# claude-autopilot (ARCHIVED)

> **ARCHIVED** — This code targets the retired AST3 ruleset (`rules_digest = 0x41535433`).
> The active ruleset is AST4 (`0x41535434`). See `autopilot/` for the current autopilot.

Action-search autopilot tuned against the shared `asteroids-verifier-core` game + verifier.

## Parity assumptions (at time of archival)

- Ruleset: `AST3` (`rules_digest = 0x41535433`) — **retired**
- Default run horizon: `108000` frames (30 minutes)
- Tape generation is strict-legal and verified before reporting results

## Commands

From repo root:

```bash
cargo run --release --manifest-path autopilot/archive/claude-autopilot/Cargo.toml -- run --seed 0xDEADBEEF
```

```bash
cargo run --release --manifest-path autopilot/archive/claude-autopilot/Cargo.toml -- bench --seed-count 12 --out-dir autopilot/archive/claude-autopilot/bench-output
```

```bash
cargo run --release --manifest-path autopilot/archive/claude-autopilot/Cargo.toml -- evolve --generations 5 --seed-count 12 --out-dir autopilot/archive/claude-autopilot/evolve-output
```

## Presets

- `marathon`
- `hunter`
- `supernova`

Use with `--preset <name>` on `run`, `bench`, or `evolve`.
