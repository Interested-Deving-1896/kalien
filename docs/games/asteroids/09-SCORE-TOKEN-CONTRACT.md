# Asteroids Score Token Contract

## Goal

Soroban contract that:
1. Verifies a RISC Zero proof through the on-chain router.
2. Validates a fixed 49-byte AST4 journal.
3. Uses claimant encoded in the journal as the canonical reward recipient.
4. Tracks best score per `(claimant, seed_id)` and mints only the improvement delta.

## Storage

```rust
enum DataKey {
    Admin,
    RouterId,
    ImageId,
    TokenId,
    Paused,
    ClaimedJournal(BytesN<32>),
    BestByClaimantSeedId(Address, u32),
    SeedById(u32),
}
```

- `Admin`, `RouterId`, `ImageId`, `TokenId`, `Paused` are in instance storage.
- `ClaimedJournal`, `BestByClaimantSeedId`, and `SeedById` are in temporary storage.

## Errors

```rust
enum ScoreError {
    InvalidJournalFormat = 1,
    InvalidRulesDigest = 2,
    JournalAlreadyClaimed = 3,
    ZeroScoreNotAllowed = 4,
    ScoreNotImproved = 5,
    ContractPaused = 6,
    SeedNotActive = 7,
}
```

## Core Flow

### `submit_score(seal: Bytes, journal_raw: Bytes) -> Result<u32, ScoreError>`

1. Enforce exact 49-byte journal length.
2. Decode fixed-width journal bytes.
3. Enforce claimant kind is account or contract.
4. Parse journal fields.
5. Enforce `(seed_id, seed)` is active:
   - `seed_id <= now_seed_id`
   - `now_seed_id - seed_id <= 143` (24h at 10-minute windows)
   - `SeedById(seed_id) == seed`
6. Enforce `final_score > 0`.
7. Hash `journal_raw` and reject already-claimed digests.
8. Decode claimant from journal payload and enforce strict improvement for `(claimant, seed_id)`.
9. Call router verify with `(seal, image_id, journal_digest)`.
10. Mint delta only: `final_score - previous_best`.
11. Emit `ScoreSubmitted`.

## Seed API

### `current_seed() -> CurrentSeed`

- Computes `seed_id = ledger_timestamp / 600`.
- Returns existing `SeedById(seed_id)` if present.
- Otherwise materializes one new random seed and stores `SeedById(seed_id) -> seed`.

No separate indexing method exists.

## Journal Format

Fixed length: `49` bytes.

- 4 x `u32` little-endian fields at offsets `0..15`
  - `seed_id`
  - `seed`
  - `frame_count`
  - `final_score`
- claimant payload at `16..48`
  - byte `16`: claimant kind (`0 = account`, `1 = contract`)
  - bytes `17..48`: 32-byte address payload

## Read Methods

- `is_claimed(journal_digest) -> bool`
- `best_score(claimant, seed_id) -> u32`
- `image_id() -> BytesN<32>`
- `router_id() -> Address`
- `token_id() -> Address`
- `rules_digest() -> u32`

## Admin Methods

- `set_image_id(new_image_id)`
- `set_admin(new_admin)`
- `upgrade(new_wasm_hash)`
- `set_paused(paused)`
- `set_router_id(new_router_id)`
- `set_token_id(new_token_id)`

## Event

```rust
struct ScoreSubmitted {
    claimant: Address,
    seed: u32,
    seed_id: u32,
    frame_count: u32,
    final_score: u32,
    previous_best: u32,
    new_best: u32,
    minted_delta: u32,
}
```

## Source of Truth

`kalien-contract/contracts/asteroids_score/src/lib.rs`
