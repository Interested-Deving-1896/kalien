# codex-tuner

Autopilot tuning lab for improving `codex-potential-adaptive` profiles without
growing the core autopilot crate.

## What It Does

- Mutates adaptive profile scales.
- Evaluates candidates on deterministic seeds.
- Promotes best candidates across iterations.
- Produces reusable champion profiles.

## Layout

- `profiles/base.json`: baseline profile.
- `profiles/champion.json`: current promoted profile.
- `profiles/SWITCHING.md`: profile reset/activation workflow.
- `seeds/`: seed sets used by iterative search.
- `scripts/iterative-search.py`: core tuning engine.
- `scripts/run-super-score-loop.sh`: one-command tuning loop.
- `runs/`: generated run artifacts (created on first run, gitignored).

Runtime note:
- `autopilot/codex-/state/adaptive-profile.json` is generated local state and
  should remain untracked.

## Quick Run

From repo root:

```bash
./autopilot/codex-tuner/scripts/run-super-score-loop.sh
```

Custom run:

```bash
./autopilot/codex-tuner/scripts/iterative-search.py \
  --iterations 8 \
  --candidates 8 \
  --max-frames 108000 \
  --selection-metric insane \
  --anchor-mode core \
  --install-mode champion \
  --jobs 8
```

Keep archived `champion-*.json` only when validated under the current ruleset.
