#![no_main]
#![no_std]

extern crate alloc;

use asteroids_verifier_core::{
    constants::JOURNAL_CLAIMANT_ENCODED_LEN, encode_journal_raw, verify_guest_input, GuestInput,
};
use risc0_zkvm::guest::env;

risc0_zkvm::guest::entry!(main);

/// Guest entrypoint.
///
/// Input layout (all little-endian where numeric):
/// - `max_frames: u32`
/// - `seed_id: u32`
/// - `claimant: [u8; 33]` (`kind(1) + id(32)`)
/// - `tape_len: u32`
/// - `tape_bytes` padded to 4-byte boundary
///
/// The guest verifies the tape and commits a fixed-width raw journal to the receipt.
fn main() {
    let mut max_frames_bytes = [0u8; 4];
    env::read_slice(&mut max_frames_bytes);
    let max_frames = u32::from_le_bytes(max_frames_bytes);

    let mut seed_id_bytes = [0u8; 4];
    env::read_slice(&mut seed_id_bytes);
    let seed_id = u32::from_le_bytes(seed_id_bytes);

    let mut claimant = [0u8; JOURNAL_CLAIMANT_ENCODED_LEN];
    env::read_slice(&mut claimant);

    let mut tape_len_bytes = [0u8; 4];
    env::read_slice(&mut tape_len_bytes);
    let tape_len = u32::from_le_bytes(tape_len_bytes) as usize;

    let padded_tape_len = (tape_len + 3) & !3;
    let mut tape = alloc::vec![0u8; padded_tape_len];
    env::read_slice(&mut tape);
    tape.truncate(tape_len);

    let guest_input = GuestInput {
        tape,
        max_frames,
        seed_id,
        claimant,
    };

    let journal = verify_guest_input(&guest_input).unwrap_or_else(|err| {
        panic!("guest verification failed: {err}");
    });

    let journal_raw = encode_journal_raw(&journal).unwrap_or_else(|err| {
        panic!("guest journal encoding failed: {err}");
    });
    env::commit_slice(&journal_raw);
}
