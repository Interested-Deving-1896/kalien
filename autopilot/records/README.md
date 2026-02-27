# Records Registry

This folder is the source of truth for retained autopilot artifacts.

## Files

- `champions.json`: promoted champion runs for the current ruleset.
- `keep-checkpoints.txt`: checkpoint basenames to retain locally.
- `keep-benchmarks.txt`: benchmark directories to retain locally.
- `latest-roster-manifest.json`: exported roster and config fingerprints.

## Policy

- Promote only artifacts that parse and verify under the current ruleset.
- Legacy/incompatible artifacts are not retained as canonical records.

## Workflow

Run from `autopilot/`:

```bash
cargo run --release -- roster-manifest --output records/latest-roster-manifest.json
cargo test --release
AUTOPILOT_STRICT_ARTIFACTS=1 cargo test --release --test champion_registry
```
