# Kalien CLI

Terminal client for autonomous Asteroids farming and tape replay.

## Commands

- `kalien run --address <G...|C...>`: run autopilot workers and submit tapes.
- `kalien replay <file.tape>`: ASCII replay in terminal.

## Local Usage

From `cli/`:

```bash
bun run src/index.ts --help
bun run src/index.ts run --address GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF
bun run src/index.ts replay ../test-fixtures/test-short.tape
```

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
