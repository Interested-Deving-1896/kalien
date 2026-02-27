# Autopilot Scripts

Operational script layer for benchmark suites and artifact maintenance.

## Core Files

- `bot-roster.sh`: canonical active roster variables.
- `sync-records.sh`: syncs promoted artifact metadata/keep-lists.
- `prune-artifacts.sh`: prunes non-kept local artifacts.

## Benchmark Suites

- `run-efficiency-elite-suite.sh`
- `run-omega-top3-deep.sh`
- `run-offline-alltime-parallel-hunt.sh`
- `run-runtime-nonoffline-parallel-suite.sh`
- `run-wrap-awareness-suite.sh`
- `run-30m-breakability-hunt.sh`
- `rebench-finalists.sh`

Additional suite scripts are available for objective-specific and full-run batches.

## Typical Usage

From repo root:

```bash
bash autopilot/scripts/run-efficiency-elite-suite.sh
bash autopilot/scripts/rebench-finalists.sh
bash autopilot/scripts/sync-records.sh
```

Use `prune-artifacts.sh --mode apply` only after validating keep-lists.
