# Frontend App (`src/`)

React application for gameplay, wallet flow, proof submission, and leaderboard UX.

## Layout

- `src/components/`: UI components (game, leaderboard, proof, wallet, shared/ui).
- `src/game/`: core game runtime and tape handling.
- `src/chain/`: chain-facing utilities (seed and contract access).
- `src/proof/`: proof request/response client logic.
- `src/leaderboard/`: leaderboard data layer.
- `src/hooks/`, `src/contexts/`, `src/lib/`, `src/wallet/`: app support modules.

## Common Commands

From repo root:

```bash
bun run dev
bun run typecheck:app
bun run lint
```
