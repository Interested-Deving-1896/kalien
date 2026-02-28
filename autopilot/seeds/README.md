# Autopilot Seed Sets

Deterministic seed lists for reproducible benchmarking.

## Files

- `score-seeds.txt`: score-focused benchmark seeds.
- `survival-seeds.txt`: survival-focused benchmark seeds.

## Usage

From `autopilot/`:

```bash
cargo run --release -- benchmark \
  --seed-file seeds/score-seeds.txt \
  --seed-count 12 \
  --objective score
```

Keep seed lists stable unless intentionally rotating benchmark baselines.
