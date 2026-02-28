# Test Suite

Test coverage is split by module surface.

## Layout

- `tests/src/`: frontend/shared utility tests.
- `tests/worker/`: worker API, queue, leaderboard, and prover integration tests.
- `tests/shared/`: shared helper tests.

## Running

From repo root:

```bash
bun test tests/src tests/shared tests/worker
```

For type checks before tests:

```bash
bun run typecheck
```
