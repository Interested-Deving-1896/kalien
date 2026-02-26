#![no_std]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, token, Address, Bytes,
    BytesN, Env,
};

mod risc0_router {
    soroban_sdk::contractimport!(file = "risc0_router.wasm");
}

#[contracttype]
enum DataKey {
    Admin,
    RouterId,
    ImageId,
    TokenId,
    Paused,
    Claimed(BytesN<32>),
    Best(Address, u32),
}

const RULES_DIGEST: u32 = 0x4153_5433; // "AST3"
const JOURNAL_BASE_LEN: u32 = 24; // 6 x u32 (seed..rules_digest)
const INSTANCE_TTL_THRESHOLD: u32 = 120_960; // 14 days
const INSTANCE_TTL_BUMP: u32 = 172_800; // 20 days
const TEMP_TTL_THRESHOLD: u32 = 25_920; // ~36h
const TEMP_TTL_BUMP: u32 = 34_560; // ~48h
const TOKEN_DECIMALS_SCALE: i128 = 10_000_000;
const SEED_INTERVAL: u64 = 600; // 10 minutes in seconds
const MAX_SEED_AGE: u32 = 143; // current bucket + 143 previous = 144 total (24h)

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum ScoreError {
    InvalidJournalLength = 1,
    InvalidRulesDigest = 2,
    JournalAlreadyClaimed = 3,
    ZeroScoreNotAllowed = 4,
    ScoreNotImproved = 5,
    ContractPaused = 6,
    SeedExpired = 7,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScoreSubmitted {
    pub claimant: Address,
    pub seed: u32,
    pub frame_count: u32,
    pub final_score: u32,
    pub final_rng_state: u32,
    pub tape_checksum: u32,
    pub rules_digest: u32,
    pub previous_best: u32,
    pub new_best: u32,
    pub minted_delta: u32,
    pub journal_digest: BytesN<32>,
}

#[contract]
pub struct AsteroidsScoreContract;

#[contractimpl]
impl AsteroidsScoreContract {
    pub fn __constructor(
        env: Env,
        admin: Address,
        router_id: Address,
        image_id: BytesN<32>,
        token_id: Address,
    ) {
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::RouterId, &router_id);
        env.storage().instance().set(&DataKey::ImageId, &image_id);
        env.storage().instance().set(&DataKey::TokenId, &token_id);
        extend_instance_ttl(&env);
    }

    /// Verify a RISC Zero proof and mint KALIEN tokens to the claimant address.
    ///
    /// - `seal`: variable-length proof seal bytes
    /// - `journal_raw`: raw 24-byte journal bytes (6 × u32 LE)
    /// - `claimant`: recipient address for KALIEN minting and best-score tracking
    ///
    /// Returns the claimant's new best score for this seed.
    pub fn submit_score(
        env: Env,
        seal: Bytes,
        journal_raw: Bytes,
        claimant: Address,
    ) -> Result<u32, ScoreError> {
        extend_instance_ttl(&env);

        if env
            .storage()
            .instance()
            .get::<_, bool>(&DataKey::Paused)
            .unwrap_or(false)
        {
            return Err(ScoreError::ContractPaused);
        }

        if journal_raw.len() != JOURNAL_BASE_LEN {
            return Err(ScoreError::InvalidJournalLength);
        }

        // Decode seed and score.
        let seed = read_u32_le(&journal_raw, 0);
        let frame_count = read_u32_le(&journal_raw, 4);
        let final_score = read_u32_le(&journal_raw, 8);
        let final_rng_state = read_u32_le(&journal_raw, 12);
        let tape_checksum = read_u32_le(&journal_raw, 16);

        // Decode rules_digest from bytes 20..24 and validate
        let rules_digest = read_u32_le(&journal_raw, 20);
        if rules_digest != RULES_DIGEST {
            return Err(ScoreError::InvalidRulesDigest);
        }

        // Validate seed is a recent 10-minute time bucket
        let current_bucket = (env.ledger().timestamp() / SEED_INTERVAL) as u32;
        let min_bucket = current_bucket.saturating_sub(MAX_SEED_AGE);
        if seed > current_bucket || seed < min_bucket {
            return Err(ScoreError::SeedExpired);
        }

        // Enforce non-zero minting.
        if final_score == 0 {
            return Err(ScoreError::ZeroScoreNotAllowed);
        }

        // Compute journal digest (SHA-256 of raw journal bytes)
        let journal_digest: BytesN<32> = env.crypto().sha256(&journal_raw).into();

        // Replay protection: reject duplicate journal digests
        let claimed_key = DataKey::Claimed(journal_digest.clone());
        if env.storage().temporary().has(&claimed_key) {
            return Err(ScoreError::JournalAlreadyClaimed);
        }

        // Per-claimant per-seed best score policy.
        let best_key = DataKey::Best(claimant.clone(), seed);
        let previous_best = env.storage().temporary().get(&best_key).unwrap_or(0u32);
        if final_score <= previous_best {
            return Err(ScoreError::ScoreNotImproved);
        }
        let minted_delta = final_score - previous_best;

        // Load config
        let router_id: Address = env.storage().instance().get(&DataKey::RouterId).unwrap();
        let image_id: BytesN<32> = env.storage().instance().get(&DataKey::ImageId).unwrap();
        let token_id: Address = env.storage().instance().get(&DataKey::TokenId).unwrap();

        // Cross-contract call to RISC Zero router to verify the proof
        let router_client = risc0_router::Client::new(&env, &router_id);
        router_client.verify(&seal, &image_id, &journal_digest);

        // Mark journal as claimed
        env.storage().temporary().set(&claimed_key, &());
        env.storage().temporary().set(&best_key, &final_score);
        env.storage()
            .temporary()
            .extend_ttl(&claimed_key, TEMP_TTL_THRESHOLD, TEMP_TTL_BUMP);
        env.storage()
            .temporary()
            .extend_ttl(&best_key, TEMP_TTL_THRESHOLD, TEMP_TTL_BUMP);

        // Mint only the improvement delta to the claimant.
        let token_client = token::StellarAssetClient::new(&env, &token_id);
        token_client.mint(&claimant, &(minted_delta as i128 * TOKEN_DECIMALS_SCALE));

        // Emit event
        ScoreSubmitted {
            claimant,
            seed,
            frame_count,
            final_score,
            final_rng_state,
            tape_checksum,
            rules_digest,
            previous_best,
            new_best: final_score,
            minted_delta,
            journal_digest,
        }
        .publish(&env);

        Ok(final_score)
    }

    /// Check whether a journal digest has already been claimed.
    pub fn is_claimed(env: Env, journal_digest: BytesN<32>) -> bool {
        env.storage()
            .temporary()
            .has(&DataKey::Claimed(journal_digest))
    }

    /// Read a claimant's best score for a seed.
    pub fn best_score(env: Env, claimant: Address, seed: u32) -> u32 {
        env.storage()
            .temporary()
            .get(&DataKey::Best(claimant, seed))
            .unwrap_or(0u32)
    }

    /// Admin: update the image ID (for program upgrades).
    pub fn set_image_id(env: Env, new_image_id: BytesN<32>) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        env.storage()
            .instance()
            .set(&DataKey::ImageId, &new_image_id);
        extend_instance_ttl(&env);
    }

    /// Admin: transfer admin role.
    pub fn set_admin(env: Env, new_admin: Address) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &new_admin);
        extend_instance_ttl(&env);
    }

    /// Admin: upgrade this contract to a new wasm hash.
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
        extend_instance_ttl(&env);
    }

    /// Admin: pause or unpause score submissions.
    pub fn set_paused(env: Env, paused: bool) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        env.storage().instance().set(&DataKey::Paused, &paused);
        extend_instance_ttl(&env);
    }

    /// Admin: update the RISC Zero router address.
    pub fn set_router_id(env: Env, new_router_id: Address) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        env.storage()
            .instance()
            .set(&DataKey::RouterId, &new_router_id);
        extend_instance_ttl(&env);
    }

    /// Read the current image ID.
    pub fn image_id(env: Env) -> BytesN<32> {
        env.storage().instance().get(&DataKey::ImageId).unwrap()
    }

    /// Read the router address.
    pub fn router_id(env: Env) -> Address {
        env.storage().instance().get(&DataKey::RouterId).unwrap()
    }

    /// Read the token address.
    pub fn token_id(env: Env) -> Address {
        env.storage().instance().get(&DataKey::TokenId).unwrap()
    }

    /// Read the expected rules digest.
    pub fn rules_digest(_env: Env) -> u32 {
        RULES_DIGEST
    }

    /// Read the current seed bucket derived from the ledger timestamp.
    pub fn current_seed(env: Env) -> u32 {
        (env.ledger().timestamp() / SEED_INTERVAL) as u32
    }

    /// Verify a RISC Zero proof without minting or modifying state.
    pub fn verify_score(env: Env, seal: Bytes, journal_raw: Bytes) -> Result<u32, ScoreError> {
        if journal_raw.len() != JOURNAL_BASE_LEN {
            return Err(ScoreError::InvalidJournalLength);
        }

        let rules_digest = read_u32_le(&journal_raw, 20);
        if rules_digest != RULES_DIGEST {
            return Err(ScoreError::InvalidRulesDigest);
        }

        let final_score = read_u32_le(&journal_raw, 8);

        let journal_digest: BytesN<32> = env.crypto().sha256(&journal_raw).into();
        let router_id: Address = env.storage().instance().get(&DataKey::RouterId).unwrap();
        let image_id: BytesN<32> = env.storage().instance().get(&DataKey::ImageId).unwrap();

        let router_client = risc0_router::Client::new(&env, &router_id);
        router_client.verify(&seal, &image_id, &journal_digest);

        Ok(final_score)
    }
}

/// Read a u32 from bytes at the given offset in little-endian order.
fn read_u32_le(bytes: &Bytes, offset: u32) -> u32 {
    let b0 = bytes.get(offset).unwrap() as u32;
    let b1 = bytes.get(offset + 1).unwrap() as u32;
    let b2 = bytes.get(offset + 2).unwrap() as u32;
    let b3 = bytes.get(offset + 3).unwrap() as u32;
    b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)
}

fn extend_instance_ttl(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_BUMP);
}

mod test;
