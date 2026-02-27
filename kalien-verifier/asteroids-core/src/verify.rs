use alloc::{string::String, vec::Vec};
use serde::{Deserialize, Serialize};
use stellar_strkey::{ed25519, Contract, Strkey};

use crate::constants::{
    JOURNAL_CLAIMANT_ENCODED_LEN, JOURNAL_CLAIMANT_KIND_ACCOUNT, JOURNAL_CLAIMANT_KIND_CONTRACT,
    JOURNAL_LEN, MAX_FRAMES_DEFAULT, RULES_DIGEST,
};
use crate::error::VerifyError;
use crate::sim::{replay_strict, ReplayResult, ReplayViolation};
use crate::tape::parse_tape;

#[derive(Clone, Debug)]
pub struct GuestInput {
    pub tape: Vec<u8>,
    pub max_frames: u32,
    pub seed_id: u32,
    pub claimant: [u8; JOURNAL_CLAIMANT_ENCODED_LEN],
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct VerificationJournal {
    pub seed: u32,
    pub seed_id: u32,
    pub frame_count: u32,
    pub final_score: u32,
    pub final_rng_state: u32,
    pub tape_checksum: u32,
    pub rules_digest: u32,
    pub claimant: String,
}

const JOURNAL_SEED_OFFSET: usize = 0;
const JOURNAL_SEED_ID_OFFSET: usize = 4;
const JOURNAL_FRAME_COUNT_OFFSET: usize = 8;
const JOURNAL_FINAL_SCORE_OFFSET: usize = 12;
const JOURNAL_FINAL_RNG_STATE_OFFSET: usize = 16;
const JOURNAL_TAPE_CHECKSUM_OFFSET: usize = 20;
const JOURNAL_RULES_DIGEST_OFFSET: usize = 24;
const JOURNAL_CLAIMANT_OFFSET: usize = 28;
const JOURNAL_RESERVED_OFFSET: usize = JOURNAL_CLAIMANT_OFFSET + JOURNAL_CLAIMANT_ENCODED_LEN;

/// Verify guest input end-to-end and produce a canonical journal.
///
/// Behavior:
/// - applies default `MAX_FRAMES_DEFAULT` when `input.max_frames == 0`,
/// - normalizes claimant into canonical strkey form,
/// - parses/replays the tape under strict rule validation.
pub fn verify_guest_input(input: &GuestInput) -> Result<VerificationJournal, VerifyError> {
    let max_frames = if input.max_frames == 0 {
        MAX_FRAMES_DEFAULT
    } else {
        input.max_frames
    };
    let claimant = decode_claimant_from_journal_bytes(&input.claimant)?;
    verify_tape_with_replay(
        &input.tape,
        max_frames,
        input.seed_id,
        claimant,
        replay_strict,
    )
}

/// Verify a tape directly without claimant/seed metadata.
///
/// This helper is mainly used by tests and local validation flows that do not need
/// claimant binding in the resulting journal.
pub fn verify_tape(bytes: &[u8], max_frames: u32) -> Result<VerificationJournal, VerifyError> {
    verify_tape_with_replay(bytes, max_frames, 0, String::new(), replay_strict)
}

/// Shared verification implementation parameterized by replay function.
///
/// The function:
/// - parses the tape format,
/// - replays inputs against deterministic game logic,
/// - checks claimed frame count / score / RNG against replay results,
/// - emits canonical journal fields on success.
fn verify_tape_with_replay<F>(
    bytes: &[u8],
    max_frames: u32,
    seed_id: u32,
    claimant: String,
    replay_fn: F,
) -> Result<VerificationJournal, VerifyError>
where
    F: FnOnce(u32, &[u8]) -> Result<ReplayResult, ReplayViolation>,
{
    let tape = parse_tape(bytes, max_frames)?;
    let replay_result =
        replay_fn(tape.header.seed, tape.inputs).map_err(|err| VerifyError::RuleViolation {
            frame: err.frame_count,
            rule: err.rule,
        })?;

    if replay_result.frame_count != tape.header.frame_count {
        return Err(VerifyError::FrameCountMismatch {
            claimed: tape.header.frame_count,
            computed: replay_result.frame_count,
        });
    }

    if replay_result.final_score != tape.footer.final_score {
        return Err(VerifyError::ScoreMismatch {
            claimed: tape.footer.final_score,
            computed: replay_result.final_score,
        });
    }

    if replay_result.final_rng_state != tape.footer.final_rng_state {
        return Err(VerifyError::RngMismatch {
            claimed: tape.footer.final_rng_state,
            computed: replay_result.final_rng_state,
        });
    }

    Ok(VerificationJournal {
        seed: tape.header.seed,
        seed_id,
        frame_count: tape.header.frame_count,
        final_score: replay_result.final_score,
        final_rng_state: replay_result.final_rng_state,
        tape_checksum: tape.footer.checksum,
        rules_digest: RULES_DIGEST,
        claimant,
    })
}

/// Encode a journal into the fixed-width raw byte format committed by the guest.
///
/// Layout is stable and deterministic:
/// `7 * u32 LE` + `claimant(kind + 32-byte id)` + `3 reserved zero bytes`.
pub fn encode_journal_raw(journal: &VerificationJournal) -> Result<[u8; JOURNAL_LEN], VerifyError> {
    let claimant = encode_claimant_for_journal(&journal.claimant)?;
    let mut raw = [0u8; JOURNAL_LEN];
    raw[JOURNAL_SEED_OFFSET..JOURNAL_SEED_OFFSET + 4].copy_from_slice(&journal.seed.to_le_bytes());
    raw[JOURNAL_SEED_ID_OFFSET..JOURNAL_SEED_ID_OFFSET + 4]
        .copy_from_slice(&journal.seed_id.to_le_bytes());
    raw[JOURNAL_FRAME_COUNT_OFFSET..JOURNAL_FRAME_COUNT_OFFSET + 4]
        .copy_from_slice(&journal.frame_count.to_le_bytes());
    raw[JOURNAL_FINAL_SCORE_OFFSET..JOURNAL_FINAL_SCORE_OFFSET + 4]
        .copy_from_slice(&journal.final_score.to_le_bytes());
    raw[JOURNAL_FINAL_RNG_STATE_OFFSET..JOURNAL_FINAL_RNG_STATE_OFFSET + 4]
        .copy_from_slice(&journal.final_rng_state.to_le_bytes());
    raw[JOURNAL_TAPE_CHECKSUM_OFFSET..JOURNAL_TAPE_CHECKSUM_OFFSET + 4]
        .copy_from_slice(&journal.tape_checksum.to_le_bytes());
    raw[JOURNAL_RULES_DIGEST_OFFSET..JOURNAL_RULES_DIGEST_OFFSET + 4]
        .copy_from_slice(&journal.rules_digest.to_le_bytes());
    raw[JOURNAL_CLAIMANT_OFFSET..JOURNAL_CLAIMANT_OFFSET + JOURNAL_CLAIMANT_ENCODED_LEN]
        .copy_from_slice(&claimant);
    Ok(raw)
}

/// Decode and validate a raw journal byte slice into a structured journal.
///
/// Validation enforces exact length and zeroed reserved bytes.
pub fn decode_journal_raw(raw: &[u8]) -> Result<VerificationJournal, VerifyError> {
    if raw.len() != JOURNAL_LEN {
        return Err(VerifyError::JournalLengthMismatch {
            expected: JOURNAL_LEN,
            actual: raw.len(),
        });
    }
    if raw[JOURNAL_RESERVED_OFFSET] != 0
        || raw[JOURNAL_RESERVED_OFFSET + 1] != 0
        || raw[JOURNAL_RESERVED_OFFSET + 2] != 0
    {
        return Err(VerifyError::JournalReservedNonZero);
    }

    Ok(VerificationJournal {
        seed: read_u32_le(raw, JOURNAL_SEED_OFFSET),
        seed_id: read_u32_le(raw, JOURNAL_SEED_ID_OFFSET),
        frame_count: read_u32_le(raw, JOURNAL_FRAME_COUNT_OFFSET),
        final_score: read_u32_le(raw, JOURNAL_FINAL_SCORE_OFFSET),
        final_rng_state: read_u32_le(raw, JOURNAL_FINAL_RNG_STATE_OFFSET),
        tape_checksum: read_u32_le(raw, JOURNAL_TAPE_CHECKSUM_OFFSET),
        rules_digest: read_u32_le(raw, JOURNAL_RULES_DIGEST_OFFSET),
        claimant: decode_claimant_from_journal_bytes(
            &raw[JOURNAL_CLAIMANT_OFFSET..JOURNAL_CLAIMANT_OFFSET + JOURNAL_CLAIMANT_ENCODED_LEN],
        )?,
    })
}

/// Read a little-endian `u32` from `bytes[offset..offset+4]`.
fn read_u32_le(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
}

/// Convert a Stellar claimant strkey (`G...` or `C...`) into compact journal bytes.
///
/// Encoded form is `kind(1) + payload(32)`.
pub fn encode_claimant_for_journal(
    strkey: &str,
) -> Result<[u8; JOURNAL_CLAIMANT_ENCODED_LEN], VerifyError> {
    let parsed = parse_supported_claimant_strkey(strkey)?;

    let mut claimant = [0u8; JOURNAL_CLAIMANT_ENCODED_LEN];
    match parsed {
        Strkey::PublicKeyEd25519(ed25519::PublicKey(bytes)) => {
            claimant[0] = JOURNAL_CLAIMANT_KIND_ACCOUNT;
            claimant[1..].copy_from_slice(&bytes);
            Ok(claimant)
        }
        Strkey::Contract(Contract(bytes)) => {
            claimant[0] = JOURNAL_CLAIMANT_KIND_CONTRACT;
            claimant[1..].copy_from_slice(&bytes);
            Ok(claimant)
        }
        _ => Err(VerifyError::InvalidClaimant {
            reason: "claimant must be a Stellar account (G...) or contract (C...)",
        }),
    }
}

/// Convert compact journal claimant bytes back into canonical Stellar strkey text.
pub fn decode_claimant_from_journal_bytes(claimant: &[u8]) -> Result<String, VerifyError> {
    if claimant.len() != JOURNAL_CLAIMANT_ENCODED_LEN {
        return Err(VerifyError::JournalLengthMismatch {
            expected: JOURNAL_CLAIMANT_ENCODED_LEN,
            actual: claimant.len(),
        });
    }

    let payload: [u8; 32] = claimant[1..]
        .try_into()
        .map_err(|_| VerifyError::InvalidClaimant {
            reason: "unsupported claimant payload length",
        })?;

    let encoded = match claimant[0] {
        JOURNAL_CLAIMANT_KIND_ACCOUNT => {
            Strkey::PublicKeyEd25519(ed25519::PublicKey(payload)).to_string()
        }
        JOURNAL_CLAIMANT_KIND_CONTRACT => Strkey::Contract(Contract(payload)).to_string(),
        _ => {
            return Err(VerifyError::InvalidClaimant {
                reason: "unsupported claimant kind",
            })
        }
    };
    Ok(String::from(encoded.as_str()))
}

/// Normalize a claimant string into canonical Stellar strkey representation.
///
/// Accepts only account (`G...`) or contract (`C...`) addresses.
pub fn normalize_claimant_strkey(raw: &str) -> Result<String, VerifyError> {
    let parsed = parse_supported_claimant_strkey(raw)?;
    let canonical = parsed.to_string();
    Ok(String::from(canonical.as_str()))
}

fn parse_supported_claimant_strkey(raw: &str) -> Result<Strkey, VerifyError> {
    let parsed = Strkey::from_string(raw.trim()).map_err(|_| VerifyError::InvalidClaimant {
        reason: "claimant must be a valid Stellar G... or C... strkey",
    })?;

    match parsed {
        Strkey::PublicKeyEd25519(_) | Strkey::Contract(_) => Ok(parsed),
        _ => Err(VerifyError::InvalidClaimant {
            reason: "claimant must be a Stellar account (G...) or contract (C...)",
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::{TAPE_HEADER_SIZE, TAPE_MAGIC, TAPE_VERSION};
    use crate::error::RuleCode;
    use crate::sim::replay;
    use crate::tape::{crc32, serialize_tape};
    const TEST_CLAIMANT: &str = "GCTCPB732UZF72Q66RFUS44XIUJFWJA2JMR277KKGWMVDZBF44XKHL5M";

    fn footer_offset(frame_count: usize) -> usize {
        TAPE_HEADER_SIZE + frame_count
    }

    fn write_footer(bytes: &mut [u8], frame_count: usize, final_score: u32, final_rng_state: u32) {
        let offset = footer_offset(frame_count);
        let checksum = crc32(&bytes[..offset]);
        bytes[offset..offset + 4].copy_from_slice(&final_score.to_le_bytes());
        bytes[offset + 4..offset + 8].copy_from_slice(&final_rng_state.to_le_bytes());
        bytes[offset + 8..offset + 12].copy_from_slice(&checksum.to_le_bytes());
    }

    fn valid_tape(seed: u32, inputs: &[u8]) -> Vec<u8> {
        let replay_result = replay(seed, inputs);
        serialize_tape(
            seed,
            inputs,
            replay_result.final_score,
            replay_result.final_rng_state,
        )
    }

    #[test]
    fn rejects_reserved_input_bits() {
        let mut tape = serialize_tape(0xAABB_CCDD, &[0x10], 0, 0xAABB_CCDD);
        write_footer(&mut tape, 1, 0, 0xAABB_CCDD);

        let err = verify_tape(&tape, 10).unwrap_err();
        assert!(matches!(
            err,
            VerifyError::ReservedInputBitsNonZero {
                frame: 0,
                byte: 0x10
            }
        ));
    }

    #[test]
    fn detects_score_tampering() {
        let inputs = [0x00u8; 60];
        let seed = 0x1234_5678;
        let mut good_tape = valid_tape(seed, &inputs);
        let journal = verify_tape(&good_tape, 10_000).unwrap();

        let offset = footer_offset(inputs.len());
        let tampered_score = journal.final_score + 1;
        good_tape[offset..offset + 4].copy_from_slice(&tampered_score.to_le_bytes());

        let err = verify_tape(&good_tape, 10_000).unwrap_err();
        assert!(matches!(err, VerifyError::ScoreMismatch { .. }));
    }

    #[test]
    fn detects_rng_tampering() {
        let inputs = [0x00u8; 48];
        let seed = 0x1234_5678;
        let mut tape = valid_tape(seed, &inputs);
        let offset = footer_offset(inputs.len());
        let tampered_rng = 0xFFFF_FFFFu32;
        tape[offset + 4..offset + 8].copy_from_slice(&tampered_rng.to_le_bytes());

        let err = verify_tape(&tape, 10_000).unwrap_err();
        assert!(matches!(err, VerifyError::RngMismatch { .. }));
    }

    #[test]
    fn guest_input_uses_default_max_frames_when_zero() {
        let inputs = [0x00u8; 32];
        let replay_result = replay(0x4455_6677, &inputs);
        let tape = serialize_tape(
            0x4455_6677,
            &inputs,
            replay_result.final_score,
            replay_result.final_rng_state,
        );
        let guest_input = GuestInput {
            tape,
            max_frames: 0,
            seed_id: 0,
            claimant: encode_claimant_for_journal(TEST_CLAIMANT).unwrap(),
        };

        let journal = verify_guest_input(&guest_input).unwrap();
        assert_eq!(journal.frame_count, inputs.len() as u32);
        assert_eq!(journal.rules_digest, RULES_DIGEST);
    }

    #[test]
    fn guest_input_honors_explicit_max_frames() {
        let inputs = [0x00u8; 32];
        let tape = valid_tape(0x1122_3344, &inputs);
        let guest_input = GuestInput {
            tape,
            max_frames: 8,
            seed_id: 0,
            claimant: encode_claimant_for_journal(TEST_CLAIMANT).unwrap(),
        };

        let err = verify_guest_input(&guest_input).unwrap_err();
        assert!(matches!(
            err,
            VerifyError::FrameCountOutOfRange {
                frame_count: 32,
                max_frames: 8
            }
        ));
    }

    #[test]
    fn maps_replay_violation_to_verify_error() {
        let inputs = [0x00u8; 4];
        let tape = valid_tape(0xDEAD_BEEF, &inputs);
        let err = verify_tape_with_replay(&tape, 100, 0, String::new(), |_seed, _inputs| {
            Err(ReplayViolation {
                frame_count: 3,
                rule: RuleCode::ShipBounds,
            })
        })
        .unwrap_err();

        assert!(matches!(
            err,
            VerifyError::RuleViolation {
                frame: 3,
                rule: RuleCode::ShipBounds
            }
        ));
    }

    #[test]
    fn detects_frame_count_mismatch_when_replay_disagrees() {
        let inputs = [0x00u8; 4];
        let tape = valid_tape(0xDEAD_BEEF, &inputs);
        let expected = replay(0xDEAD_BEEF, &inputs);
        let err = verify_tape_with_replay(&tape, 100, 0, String::new(), |_seed, _inputs| {
            Ok(ReplayResult {
                frame_count: expected.frame_count + 1,
                ..expected
            })
        })
        .unwrap_err();

        assert!(matches!(
            err,
            VerifyError::FrameCountMismatch {
                claimed: 4,
                computed: 5
            }
        ));
    }

    #[test]
    fn single_byte_tampering_is_rejected() {
        let inputs = [0x01u8, 0x02, 0x04, 0x08, 0x03, 0x0C, 0x00, 0x07];
        let good_tape = valid_tape(0xFEED_BEEF, &inputs);
        assert!(verify_tape(&good_tape, 100).is_ok());

        for idx in 0..good_tape.len() {
            let mut tampered = good_tape.clone();
            tampered[idx] ^= 0x01;
            assert!(
                verify_tape(&tampered, 100).is_err(),
                "tampering byte index {idx} must fail verification"
            );
        }
    }

    #[test]
    fn parse_checks_happen_before_replay() {
        let mut tape = valid_tape(0xDEAD_BEEF, &[0x00u8; 4]);
        tape[0..4].copy_from_slice(&TAPE_MAGIC.wrapping_add(1).to_le_bytes());
        tape[4] = TAPE_VERSION + 1;

        let err = verify_tape_with_replay(&tape, 10, 0, String::new(), |_seed, _inputs| {
            panic!("replay must not run when parse fails")
        })
        .unwrap_err();

        assert!(matches!(err, VerifyError::InvalidMagic { .. }));
    }

    #[test]
    fn claimant_roundtrip_bytes_and_strkey() {
        let encoded = encode_claimant_for_journal(TEST_CLAIMANT).unwrap();
        let decoded = decode_claimant_from_journal_bytes(&encoded).unwrap();
        assert_eq!(decoded, TEST_CLAIMANT);
    }

    #[test]
    fn journal_raw_roundtrip() {
        let journal = VerificationJournal {
            seed: 0xDEAD_BEEF,
            seed_id: 123,
            frame_count: 456,
            final_score: 789,
            final_rng_state: 0xAABB_CCDD,
            tape_checksum: 0x1122_3344,
            rules_digest: RULES_DIGEST,
            claimant: TEST_CLAIMANT.to_string(),
        };
        let raw = encode_journal_raw(&journal).unwrap();
        assert_eq!(raw.len(), JOURNAL_LEN);
        let decoded = decode_journal_raw(&raw).unwrap();
        assert_eq!(decoded, journal);
    }

    #[test]
    fn decode_journal_rejects_non_zero_reserved() {
        let journal = VerificationJournal {
            seed: 1,
            seed_id: 2,
            frame_count: 3,
            final_score: 4,
            final_rng_state: 5,
            tape_checksum: 6,
            rules_digest: RULES_DIGEST,
            claimant: TEST_CLAIMANT.to_string(),
        };
        let mut raw = encode_journal_raw(&journal).unwrap();
        raw[JOURNAL_RESERVED_OFFSET] = 1;
        let err = decode_journal_raw(&raw).unwrap_err();
        assert_eq!(err, VerifyError::JournalReservedNonZero);
    }
}
