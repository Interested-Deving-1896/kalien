#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

pub mod constants;
pub mod error;
pub mod fixed_point;
pub mod rng;
pub mod sim;
pub mod tape;
pub mod verify;

pub use error::{RuleCode, VerifyError};
pub use verify::{
    decode_claimant_from_journal_bytes, decode_journal_raw, encode_claimant_for_journal,
    encode_journal_raw, normalize_claimant_strkey, verify_guest_input, verify_tape, GuestInput,
    VerificationJournal,
};
