# Asteroids Deterministic Verification Spec

## Acceptance Criteria
A tape is valid only if all conditions hold:
1. Tape format and checksum are valid.
2. Replay executes exactly `frameCount` frames.
3. Canonical transition order is preserved.
4. All invariant groups pass.
5. Final score matches footer claim.

## Tape Rules
### Header (16 bytes)
- `magic == 0x5A4B5450` (`ZKTP`)
- `version == 4`
- `rules_tag == 4` (`AST4`)
- header reserved bytes `[6..7] == 0`
- `frameCount > 0`
- `frameCount <= configured max` (default 18,000)

### Body (nibble-packed)
- `ceil(frameCount / 2)` bytes.
- Each byte holds two frames: low nibble = frame 2i, high nibble = frame 2i+1.
- Each nibble encodes: bit0=left, bit1=right, bit2=thrust, bit3=fire.
- If frameCount is odd, the high nibble of the last byte is zero.

### Footer (8 bytes)
- Contains `finalScore`, `checksum` (each u32 LE).
- `checksum` must equal CRC-32 of header + body.

## Canonical Transition Order
1. Increment frame counter.
2. Read frame input.
3. Update ship.
4. Update asteroids.
5. Update player bullets.
6. Update saucers.
7. Update saucer bullets.
8. Resolve collisions.
9. Prune destroyed entities.
10. Update progression timers.
11. Advance input cursor.
12. Spawn wave when progression conditions are met.

Any reorder is invalid.

## Rule Groups
- `TAPE_*`: parsing, limits, checksum, reserved bits.
- `GLOBAL_*`: frame monotonicity, mode transitions, RNG consistency.
- `SHIP_*`: turn/thrust/drag/clamp/position step.
- `PLAYER_BULLET_*`: cap/fire-gate/spawn/lifetime.
- `ASTEROID_*`: motion/split/caps/wave spawn count.
- `SAUCER_*`: spawn cadence/count/fire behavior.
- `COLLISION_*`: canonical collision order and side effects.
- `PROGRESSION_*`: score deltas, extra life, wave advance, lives/game-over.

## RNG Integrity
- Gameplay RNG algorithm and call sequence are consensus-critical.
- Visual RNG must be isolated and non-authoritative.

## Required Verification Output
On success, verifier returns/commits the canonical 64-byte journal (all fields u32 LE unless noted):

| Offset | Field | Size | Type |
|--------|-------|------|------|
| 0 | `seed` | 4 | u32 LE |
| 4 | `seed_id` | 4 | u32 LE |
| 8 | `frame_count` | 4 | u32 LE |
| 12 | `final_score` | 4 | u32 LE |
| 16 | `reserved` | 4 | must be 0x00000000 |
| 20 | `reserved` | 4 | must be 0x00000000 |
| 24 | `rules_digest` | 4 | u32 LE (`0x4153_5434`, `AST4`) |
| 28 | `claimant_kind` | 1 | u8 (0=account, 1=contract) |
| 29 | `claimant_id` | 32 | raw bytes |
| 61 | `reserved` | 3 | must be 0x000000 |

`seed_id` is provided out-of-band (not embedded in the tape) and binds the proof to a specific on-chain game seed epoch.

On failure, verifier returns a deterministic `VerifyError` variant (parse error,
rule violation, or footer mismatch class).
