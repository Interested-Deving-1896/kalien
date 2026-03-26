# Asteroids Tape Reuse And Replay Policy

## Purpose

Document the current replay/claim uniqueness model, what the journal contains, and what would be required to block identical tape reuse across different claimants.

## Current Behavior

- Tapes are not single-use on-chain.
- Journals are single-use by digest.
- Best-score tracking is per `(claimant, seed_id)`.
- Proofs are bound to the journal, and the journal includes the claimant.

In practice, this means:

- Same tape + same claimant + same `seed_id` + same score: rejected after the first successful claim.
- Same tape + new proof + same journal: still rejected.
- Same tape + different claimant + new proof: currently allowed.
- Same exact proof cannot be reused to pay a different claimant, because the proof is bound to the journal digest and the journal encodes the claimant.

## What The Journal Contains Today

The public journal is a fixed 49-byte payload:

- `seed_id` (`u32`)
- `seed` (`u32`)
- `frame_count` (`u32`)
- `final_score` (`u32`)
- `claimant_kind` (`u8`)
- `claimant_id` (`32 bytes`)

It does not contain:

- tape bytes
- tape hash
- replay hash
- proof hash
- submission nonce

## Why The Current Contract Allows Tape Reuse Across Claimants

The score contract only receives `seal` and `journal_raw` and verifies the proof against `sha256(journal_raw)`.

It stores two relevant keys:

- `ClaimedJournal(BytesN<32>)`
- `BestByClaimantSeedId(Address, u32)`

So the contract enforces uniqueness for the journal digest and improvement policy for a claimant/seed bucket. It does not enforce uniqueness for the tape or replay trace itself.

Because claimant bytes are part of the journal, changing the claimant changes the journal digest. The same tape can therefore produce a different valid journal/proof pair for a different claimant.

## What Is Actually Single-Use

- Not single-use: tape bytes, gameplay trace, proof backend invocation.
- Single-use: exact claimed journal digest.
- Claim-scoped policy: best score for a given `(claimant, seed_id)`.

## Constraint: What Cannot Be Solved With The Existing Journal Alone

With the current 49-byte journal, the contract cannot trustlessly detect that two different claims came from the same tape.

Reason:

- the contract never sees tape bytes
- the contract never sees a tape hash or replay commitment
- the proof only exposes the current journal fields as public output

So a contract-only fix that keeps the current journal exactly unchanged cannot implement true tape-level global replay protection.

## Options To Prevent Same-Tape Reuse Across Different Claimants

### 1. Add A Replay Hash To The Public Output

Best trustless option.

Add a new public field such as:

- `replay_hash = sha256(canonical replay bytes)`

Good canonical input shape:

- domain tag
- `seed`
- `frame_count`
- canonical packed inputs

Then store `ClaimedReplayHash(replay_hash)` on-chain and reject repeats globally.

Properties:

- blocks same tape/replay reuse across all claimants
- does not depend on proof byte uniqueness
- keeps the rule fully on-chain and trustless

Tradeoff:

- requires a proof/journal format migration

### 2. Add An Extra Public Input Equivalent To A Replay Hash

Conceptually the same as option 1, but implemented as an additional verifier-exposed public value rather than an appended journal field.

Properties:

- same security outcome as option 1
- still requires proof format and contract/verifier integration changes

Tradeoff:

- not a small contract-only change with the current verifier call shape

### 3. Make Tapes Claimant-Bound

Bind claimant identity to the replay payload before proving, for example by:

- including claimant metadata in the tape statement, or
- requiring a claimant signature that the guest verifies

Properties:

- stops direct reuse of the same claimant-bound tape file by another claimant
- works with the existing journal shape if the guest still emits the same claimant field

Tradeoff:

- does not stop someone from reproducing the same input sequence in a newly claimant-bound submission
- this is anti-file-reuse, not true anti-replay

### 4. Use A Heuristic Derived Only From Existing Journal Fields

Example uniqueness keys:

- `(seed_id, seed, frame_count, final_score)`
- hash of journal-without-claimant

Properties:

- possible with contract changes while keeping the current journal fields

Tradeoff:

- not tape uniqueness
- can create false positives for distinct tapes that land on the same public tuple
- effectively changes policy to "first claimant wins this public result shape"

This is only acceptable if the false-positive risk is an intentional product choice.

### 5. Enforce Replay Uniqueness In A Trusted Gateway Or Relayer

The worker computes a replay hash off-chain, records it in a global index, and rejects duplicates before proof/claim submission.

Properties:

- can keep the existing journal unchanged
- can block duplicate tapes operationally

Tradeoff:

- centralized trust unless the contract forces all claims through the relayer
- bypassable if users can call the contract directly with valid proofs

## Recommendation

If the product rule is "a gameplay trace can only be claimed once globally," the correct design is:

1. Add a canonical `replay_hash` to the proof public output.
2. Store `ClaimedReplayHash(replay_hash)` on-chain.
3. Keep claimant-specific best-score accounting as a separate rule.

If a smaller change is needed temporarily, the next best option is a trusted relayer-side replay registry, with the understanding that it is an operational control rather than a trustless protocol rule.

## Code And Docs Reviewed

- `kalien-contract/contracts/asteroids_score/src/lib.rs`
- `kalien-contract/contracts/asteroids_score/src/test.rs`
- `worker/boundless/sdk/client.ts`
- `worker/queue/consumer.ts`
- `docs/games/asteroids/00-OVERVIEW.md`
- `docs/games/asteroids/02-VERIFICATION-SPEC.md`
- `docs/games/asteroids/09-SCORE-TOKEN-CONTRACT.md`
- `docs/games/asteroids/10-PROOF-GATEWAY-SPEC.md`
