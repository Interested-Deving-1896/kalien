# asteroids-score Bindings

TypeScript bindings for the `asteroids_score` Soroban contract used by this
repository.

## Regenerate

From repo root:

```bash
bun run generate:score-bindings
```

This runs `scripts/generate-score-bindings.sh`, which by default builds local
WASM and regenerates this package under
`shared/stellar/bindings/asteroids-score/`.

## Usage

```ts
import { Client } from "asteroids-score";

const client = new Client({
  contractId: "CA...", // score contract ID
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
});

const tx = await client.rules_digest();
console.log(tx.result);
```

For claimant journal packing/parsing utilities, see
[shared/stellar/README.md](../../README.md).
