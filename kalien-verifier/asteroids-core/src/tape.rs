use alloc::{vec, vec::Vec};
use serde::{Deserialize, Serialize};

use crate::constants::{RULES_TAG, TAPE_FOOTER_SIZE, TAPE_HEADER_SIZE, TAPE_MAGIC, TAPE_VERSION};
use crate::error::VerifyError;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TapeHeader {
    pub magic: u32,
    pub version: u8,
    pub rules_tag: u8,
    pub seed: u32,
    pub frame_count: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TapeFooter {
    pub final_score: u32,
    pub final_rng_state: u32,
    pub checksum: u32,
}

/// Parsed tape with unpacked inputs (one byte per frame, low nibble only).
///
/// `inputs` is owned because the body bytes are nibble-packed on disk and must
/// be expanded into individual frame bytes during parsing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TapeView {
    pub header: TapeHeader,
    pub inputs: Vec<u8>,
    pub footer: TapeFooter,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FrameInput {
    pub left: bool,
    pub right: bool,
    pub thrust: bool,
    pub fire: bool,
}

#[inline]
pub fn encode_input_byte(input: FrameInput) -> u8 {
    (if input.left { 0x01 } else { 0 })
        | (if input.right { 0x02 } else { 0 })
        | (if input.thrust { 0x04 } else { 0 })
        | (if input.fire { 0x08 } else { 0 })
}

#[inline]
pub fn decode_input_byte(byte: u8) -> FrameInput {
    FrameInput {
        left: (byte & 0x01) != 0,
        right: (byte & 0x02) != 0,
        thrust: (byte & 0x04) != 0,
        fire: (byte & 0x08) != 0,
    }
}

/// Returns the number of packed body bytes for a given frame count.
#[inline]
pub fn body_bytes(frame_count: usize) -> usize {
    (frame_count + 1) / 2
}

pub fn parse_tape(bytes: &[u8], max_frames: u32) -> Result<TapeView, VerifyError> {
    let min_len = TAPE_HEADER_SIZE + TAPE_FOOTER_SIZE;
    if bytes.len() < min_len {
        return Err(VerifyError::TapeTooShort {
            actual: bytes.len(),
            min: min_len,
        });
    }

    let magic = read_u32_le(bytes, 0);
    if magic != TAPE_MAGIC {
        return Err(VerifyError::InvalidMagic { found: magic });
    }

    let version = bytes[4];
    if version != TAPE_VERSION {
        return Err(VerifyError::UnsupportedVersion { found: version });
    }

    let rules_tag = bytes[5];
    if rules_tag != RULES_TAG {
        return Err(VerifyError::UnknownRulesTag { found: rules_tag });
    }
    if bytes[6] != 0 || bytes[7] != 0 {
        return Err(VerifyError::HeaderReservedNonZero);
    }

    let seed = read_u32_le(bytes, 8);
    let frame_count = read_u32_le(bytes, 12);

    if frame_count == 0 || frame_count > max_frames {
        return Err(VerifyError::FrameCountOutOfRange {
            frame_count,
            max_frames,
        });
    }

    let packed_len = body_bytes(frame_count as usize);
    let expected_len = TAPE_HEADER_SIZE + packed_len + TAPE_FOOTER_SIZE;
    if bytes.len() != expected_len {
        return Err(VerifyError::TapeLengthMismatch {
            expected: expected_len,
            actual: bytes.len(),
        });
    }

    let body_start = TAPE_HEADER_SIZE;
    let body_end = body_start + packed_len;

    // Verify CRC-32 over header + packed body.
    let computed = crc32(&bytes[..body_end]);
    let checksum = read_u32_le(bytes, body_end + 8);
    if checksum != computed {
        return Err(VerifyError::CrcMismatch {
            stored: checksum,
            computed,
        });
    }

    // Unpack nibbles into one byte per frame.
    let mut inputs = Vec::with_capacity(frame_count as usize);
    for i in 0..packed_len {
        let byte = bytes[body_start + i];
        inputs.push(byte & 0x0F); // low nibble = frame 2i
        if inputs.len() < frame_count as usize {
            inputs.push((byte >> 4) & 0x0F); // high nibble = frame 2i+1
        }
    }

    let final_score = read_u32_le(bytes, body_end);
    let final_rng_state = read_u32_le(bytes, body_end + 4);

    Ok(TapeView {
        header: TapeHeader {
            magic,
            version,
            rules_tag,
            seed,
            frame_count,
        },
        inputs,
        footer: TapeFooter {
            final_score,
            final_rng_state,
            checksum,
        },
    })
}

pub fn serialize_tape(seed: u32, inputs: &[u8], final_score: u32, final_rng_state: u32) -> Vec<u8> {
    let frame_count = inputs.len();
    let packed_len = body_bytes(frame_count);
    let total_len = TAPE_HEADER_SIZE + packed_len + TAPE_FOOTER_SIZE;
    let mut data = vec![0u8; total_len];

    write_u32_le(&mut data, 0, TAPE_MAGIC);
    data[4] = TAPE_VERSION;
    data[5] = RULES_TAG;
    data[6] = 0;
    data[7] = 0;
    write_u32_le(&mut data, 8, seed);
    write_u32_le(&mut data, 12, frame_count as u32);

    // Nibble-pack: low nibble = frame 2i, high nibble = frame 2i+1.
    let body_start = TAPE_HEADER_SIZE;
    for i in 0..packed_len {
        let lo = inputs[2 * i] & 0x0F;
        let hi = if 2 * i + 1 < frame_count {
            (inputs[2 * i + 1] & 0x0F) << 4
        } else {
            0
        };
        data[body_start + i] = lo | hi;
    }

    let body_end = body_start + packed_len;
    write_u32_le(&mut data, body_end, final_score);
    write_u32_le(&mut data, body_end + 4, final_rng_state);

    let checksum = crc32(&data[..body_end]);
    write_u32_le(&mut data, body_end + 8, checksum);

    data
}

#[inline]
fn read_u32_le(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes([
        bytes[offset],
        bytes[offset + 1],
        bytes[offset + 2],
        bytes[offset + 3],
    ])
}

#[inline]
fn write_u32_le(bytes: &mut [u8], offset: usize, value: u32) {
    bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

const CRC_TABLE: [u32; 256] = build_crc_table();

const fn build_crc_table() -> [u32; 256] {
    let mut table = [0u32; 256];
    let mut i = 0;

    while i < 256 {
        let mut c = i as u32;
        let mut j = 0;

        while j < 8 {
            c = if (c & 1) != 0 {
                0xEDB8_8320u32 ^ (c >> 1)
            } else {
                c >> 1
            };
            j += 1;
        }

        table[i] = c;
        i += 1;
    }

    table
}

pub fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;

    for byte in data {
        let idx = ((crc ^ (*byte as u32)) & 0xFF) as usize;
        crc = CRC_TABLE[idx] ^ (crc >> 8);
    }

    crc ^ 0xFFFF_FFFFu32
}

#[cfg(test)]
mod tests {
    use super::*;

    fn footer_offset(frame_count: usize) -> usize {
        TAPE_HEADER_SIZE + body_bytes(frame_count)
    }

    #[test]
    fn crc_matches_known_vector() {
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
    }

    #[test]
    fn input_byte_roundtrip_for_all_valid_bit_patterns() {
        for byte in 0u8..=0x0F {
            assert_eq!(encode_input_byte(decode_input_byte(byte)), byte);
        }
    }

    #[test]
    fn roundtrip_small_tape() {
        let inputs = [0x00u8, 0x09u8, 0x06u8];
        let bytes = serialize_tape(0xABCD_1234, &inputs, 777, 0x1111_2222);
        let tape = parse_tape(&bytes, 100).unwrap();

        assert_eq!(tape.header.seed, 0xABCD_1234);
        assert_eq!(tape.header.frame_count, 3);
        assert_eq!(tape.inputs, &inputs[..]);
        assert_eq!(tape.footer.final_score, 777);
        assert_eq!(tape.footer.final_rng_state, 0x1111_2222);
    }

    #[test]
    fn nibble_pack_even_frame_count() {
        // 4 frames → 2 packed bytes
        let inputs = [0x0Au8, 0x05u8, 0x03u8, 0x0Cu8];
        let bytes = serialize_tape(1, &inputs, 0, 0);
        assert_eq!(bytes.len(), TAPE_HEADER_SIZE + 2 + TAPE_FOOTER_SIZE);
        // byte 0: lo=0x0A, hi=0x05 → 0x5A
        assert_eq!(bytes[TAPE_HEADER_SIZE], 0x5A);
        // byte 1: lo=0x03, hi=0x0C → 0xC3
        assert_eq!(bytes[TAPE_HEADER_SIZE + 1], 0xC3);
        let tape = parse_tape(&bytes, 100).unwrap();
        assert_eq!(tape.inputs, &inputs[..]);
    }

    #[test]
    fn nibble_pack_odd_frame_count() {
        // 3 frames → 2 packed bytes (high nibble of last byte = 0)
        let inputs = [0x01u8, 0x02u8, 0x04u8];
        let bytes = serialize_tape(1, &inputs, 0, 0);
        assert_eq!(bytes.len(), TAPE_HEADER_SIZE + 2 + TAPE_FOOTER_SIZE);
        // byte 0: lo=0x01, hi=0x02 → 0x21
        assert_eq!(bytes[TAPE_HEADER_SIZE], 0x21);
        // byte 1: lo=0x04, hi=0x00 → 0x04
        assert_eq!(bytes[TAPE_HEADER_SIZE + 1], 0x04);
        let tape = parse_tape(&bytes, 100).unwrap();
        assert_eq!(tape.inputs, &inputs[..]);
    }

    #[test]
    fn rejects_tape_too_short() {
        let bytes = [0u8; TAPE_HEADER_SIZE + TAPE_FOOTER_SIZE - 1];
        assert!(matches!(
            parse_tape(&bytes, 100),
            Err(VerifyError::TapeTooShort { .. })
        ));
    }

    #[test]
    fn rejects_invalid_magic() {
        let mut bytes = serialize_tape(0xABCD_1234, &[0x00u8], 0, 0);
        bytes[0] ^= 0x01;
        assert!(matches!(
            parse_tape(&bytes, 100),
            Err(VerifyError::InvalidMagic { .. })
        ));
    }

    #[test]
    fn rejects_unsupported_version() {
        let mut bytes = serialize_tape(0xABCD_1234, &[0x00u8], 0, 0);
        bytes[4] = TAPE_VERSION + 1;
        assert!(matches!(
            parse_tape(&bytes, 100),
            Err(VerifyError::UnsupportedVersion { .. })
        ));
    }

    #[test]
    fn rejects_unknown_rules_tag() {
        let mut bytes = serialize_tape(0xABCD_1234, &[0x00u8], 0, 0);
        bytes[5] = 255;
        assert!(matches!(
            parse_tape(&bytes, 100),
            Err(VerifyError::UnknownRulesTag { found: 255 })
        ));
    }

    #[test]
    fn rejects_nonzero_header_reserved_bytes() {
        let mut bytes = serialize_tape(0xABCD_1234, &[0x00u8], 0, 0);
        bytes[6] = 1;
        assert!(matches!(
            parse_tape(&bytes, 100),
            Err(VerifyError::HeaderReservedNonZero)
        ));
    }

    #[test]
    fn rejects_zero_frame_count() {
        let mut bytes = serialize_tape(0xABCD_1234, &[0x00u8], 0, 0);
        bytes[12..16].copy_from_slice(&0u32.to_le_bytes());
        assert!(matches!(
            parse_tape(&bytes, 100),
            Err(VerifyError::FrameCountOutOfRange {
                frame_count: 0,
                max_frames: 100
            })
        ));
    }

    #[test]
    fn rejects_frame_count_above_max() {
        let bytes = serialize_tape(0xABCD_1234, &[0x00u8], 0, 0);
        assert!(matches!(
            parse_tape(&bytes, 0),
            Err(VerifyError::FrameCountOutOfRange {
                frame_count: 1,
                max_frames: 0
            })
        ));
    }

    #[test]
    fn rejects_trailing_bytes_beyond_declared_frame_count() {
        let mut bytes = serialize_tape(0xABCD_1234, &[0x00u8], 0, 0);
        bytes.push(0);
        assert!(matches!(
            parse_tape(&bytes, 100),
            Err(VerifyError::TapeLengthMismatch { .. })
        ));
    }

    #[test]
    fn rejects_shorter_than_declared_frame_count() {
        // 2 frames → 1 packed byte; pop a byte from the footer to trigger mismatch
        let mut bytes = serialize_tape(0xABCD_1234, &[0x00u8, 0x00u8], 0, 0);
        bytes.pop();
        assert!(matches!(
            parse_tape(&bytes, 100),
            Err(VerifyError::TapeLengthMismatch { .. })
        ));
    }

    #[test]
    fn rejects_crc_mismatch() {
        let mut bytes = serialize_tape(0xABCD_1234, &[0x00u8], 0, 0);
        let checksum_offset = footer_offset(1) + 8;
        bytes[checksum_offset] ^= 0x01;
        assert!(matches!(
            parse_tape(&bytes, 100),
            Err(VerifyError::CrcMismatch { .. })
        ));
    }

    #[test]
    fn serialize_tape_writes_crc_over_header_and_body() {
        let inputs = [0x01u8, 0x02u8, 0x04u8, 0x08u8];
        let bytes = serialize_tape(0xABCD_1234, &inputs, 77, 0xCAFEBABE);
        let checksum_offset = footer_offset(inputs.len()) + 8;
        let stored = u32::from_le_bytes([
            bytes[checksum_offset],
            bytes[checksum_offset + 1],
            bytes[checksum_offset + 2],
            bytes[checksum_offset + 3],
        ]);
        assert_eq!(stored, crc32(&bytes[..footer_offset(inputs.len())]));
    }
}
