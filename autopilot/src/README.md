# Autopilot Source Layout

Core Rust implementation for autopilot CLI and benchmark engine.

## Key Modules

- `main.rs`: CLI surface (`list-bots`, `generate`, `verify-tape`, `benchmark`, `roster-manifest`, tuning/evolution helpers).
- `benchmark.rs`: multi-seed benchmark orchestration and report output.
- `runner.rs`: single-run execution and tape writing.
- `bots/`: bot implementations and roster construction.
- `claude/`, `codex_lab.rs`: experimentation/tuning modules.
- `util.rs`: seed parsing and common helpers.

## Adding a Bot

1. Implement logic in `bots/`.
2. Register in `bots/roster.rs`.
3. Verify with `cargo run --release -- list-bots` and benchmark runs.
