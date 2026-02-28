#![no_std]

use soroban_sdk::{
    address_payload::AddressPayload, contract, contracterror, contractevent, contractimpl,
    contracttype, token, Address, Bytes, BytesN, Env,
};

mod risc0_verifier {
    soroban_sdk::contractimport!(file = "risc0_verifier.wasm");
}

#[contracttype]
enum DataKey {
    Admin,
    VerifierId,
    ImageId,
    TokenId,
    Paused,
    ClaimedJournal(BytesN<32>),
    BestByClaimantSeedId(Address, u32),
    // temporary: key=seed_id, value=seed.
    SeedById(u32),
}

const RULES_DIGEST: u32 = 0x4153_5434; // "AST4"

const JOURNAL_SEED_ID_OFFSET: u32 = 0;
const JOURNAL_SEED_OFFSET: u32 = 4;
const JOURNAL_FRAME_COUNT_OFFSET: u32 = 8;
const JOURNAL_FINAL_SCORE_OFFSET: u32 = 12;
const JOURNAL_CLAIMANT_OFFSET: u32 = 16;
const JOURNAL_CLAIMANT_KIND_ACCOUNT: u8 = 0;
const JOURNAL_CLAIMANT_KIND_CONTRACT: u8 = 1;
const JOURNAL_CLAIMANT_ENCODED_LEN: usize = 33; // kind(1) + id(32)
const JOURNAL_LEN: u32 = JOURNAL_CLAIMANT_OFFSET + JOURNAL_CLAIMANT_ENCODED_LEN as u32;
const JOURNAL_LEN_USIZE: usize = JOURNAL_LEN as usize;
const JOURNAL_CLAIMANT_OFFSET_USIZE: usize = JOURNAL_CLAIMANT_OFFSET as usize;
const JOURNAL_CLAIMANT_END_USIZE: usize =
    JOURNAL_CLAIMANT_OFFSET_USIZE + JOURNAL_CLAIMANT_ENCODED_LEN;

const INSTANCE_TTL_THRESHOLD: u32 = 120_960; // 7 days  (at ~5s/ledger: 17280 ledgers/day)
const INSTANCE_TTL_BUMP: u32 = 172_800; // 10 days (at ~5s/ledger)
const TOKEN_DECIMALS_SCALE: i128 = 10_000_000;
const SEED_INTERVAL_SECONDS: u64 = 600; // 10 minutes in seconds
                                        // 24h fixed-window policy: now + previous 143 windows = 144 × 10 min.
const MAX_SEED_AGE_WINDOWS: u32 = 143;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum ScoreError {
    InvalidJournalFormat = 1,
    JournalAlreadyClaimed = 3,
    ZeroScoreNotAllowed = 4,
    ScoreNotImproved = 5,
    ContractPaused = 6,
    SeedNotActive = 7,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScoreSubmitted {
    pub seed_id: u32,
    pub seed: u32,
    pub frame_count: u32,
    pub final_score: u32,
    pub claimant: Address,
    pub previous_best: u32,
    pub new_best: u32,
    pub minted_delta: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CurrentSeed {
    pub seed_id: u32,
    pub seed: u32,
}

#[contract]
pub struct AsteroidsScoreContract;

#[contractimpl]
impl AsteroidsScoreContract {
    /// Initialize immutable and mutable configuration for the contract instance.
    ///
    /// Arguments:
    /// - `env`: Soroban execution environment.
    /// - `admin`: Address authorized for admin-only methods.
    /// - `verifier_id`: RISC Zero Groth16 verifier contract address.
    /// - `image_id`: Expected RISC Zero image ID for valid receipts.
    /// - `token_id`: Stellar asset contract used for reward minting.
    pub fn __constructor(
        env: Env,
        admin: Address,
        verifier_id: Address,
        image_id: BytesN<32>,
        token_id: Address,
    ) {
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::VerifierId, &verifier_id);
        env.storage().instance().set(&DataKey::ImageId, &image_id);
        env.storage().instance().set(&DataKey::TokenId, &token_id);
        extend_instance_ttl(&env);
    }

    /// Verify a RISC Zero proof and mint KALIEN tokens.
    ///
    /// - `seal`: variable-length proof seal bytes
    /// - `journal_raw`: raw 49-byte journal bytes:
    ///   - 4 x u32 LE fields (`seed_id`, `seed`, `frame_count`, `final_score`)
    ///   - claimant payload (kind + 32-byte id)
    ///
    /// Returns the claimant's new best score for this `seed_id`.
    ///
    /// Errors:
    /// - `ContractPaused` if submissions are disabled.
    /// - `InvalidJournalFormat` for malformed journal data.
    /// - `SeedNotActive` if the `(seed_id, seed)` pair is not active.
    /// - `JournalAlreadyClaimed` on replay.
    /// - `ZeroScoreNotAllowed` or `ScoreNotImproved` for policy violations.
    pub fn submit_score(env: Env, seal: Bytes, journal_raw: Bytes) -> Result<u32, ScoreError> {
        extend_instance_ttl(&env);

        if env
            .storage()
            .instance()
            .get::<_, bool>(&DataKey::Paused)
            .unwrap_or(false)
        {
            return Err(ScoreError::ContractPaused);
        }

        let journal = load_journal_bytes(&journal_raw)?;
        let parsed = parse_journal_fields(&journal);

        if !is_active_seed(&env, parsed.seed_id, parsed.seed) {
            return Err(ScoreError::SeedNotActive);
        }

        if parsed.final_score == 0 {
            return Err(ScoreError::ZeroScoreNotAllowed);
        }

        let journal_digest: BytesN<32> = env.crypto().sha256(&journal_raw).into();

        let claimed_key = DataKey::ClaimedJournal(journal_digest.clone());
        if env.storage().temporary().has(&claimed_key) {
            return Err(ScoreError::JournalAlreadyClaimed);
        }

        let claimant = read_claimant_address(&env, &journal)?;
        let best_key = DataKey::BestByClaimantSeedId(claimant.clone(), parsed.seed_id);
        let previous_best = env.storage().temporary().get(&best_key).unwrap_or(0u32);
        if parsed.final_score <= previous_best {
            return Err(ScoreError::ScoreNotImproved);
        }
        let minted_delta = parsed.final_score - previous_best;

        let verifier_id: Address = env.storage().instance().get(&DataKey::VerifierId).unwrap();
        let image_id: BytesN<32> = env.storage().instance().get(&DataKey::ImageId).unwrap();
        let token_id: Address = env.storage().instance().get(&DataKey::TokenId).unwrap();

        // CEI: write effects before cross-contract interactions.
        env.storage().temporary().set(&claimed_key, &());
        env.storage()
            .temporary()
            .set(&best_key, &parsed.final_score);

        let verifier_client = risc0_verifier::Client::new(&env, &verifier_id);
        verifier_client.verify(&seal, &image_id, &journal_digest);

        let token_client = token::StellarAssetClient::new(&env, &token_id);
        token_client.mint(&claimant, &(minted_delta as i128 * TOKEN_DECIMALS_SCALE));

        ScoreSubmitted {
            seed_id: parsed.seed_id,
            seed: parsed.seed,
            frame_count: parsed.frame_count,
            final_score: parsed.final_score,
            claimant,
            previous_best,
            new_best: parsed.final_score,
            minted_delta,
        }
        .publish(&env);

        Ok(parsed.final_score)
    }

    /// Check whether a journal digest has already been claimed.
    ///
    /// Arguments:
    /// - `env`: Soroban execution environment.
    /// - `journal_digest`: SHA-256 digest of the raw journal bytes.
    pub fn is_claimed(env: Env, journal_digest: BytesN<32>) -> bool {
        env.storage()
            .temporary()
            .has(&DataKey::ClaimedJournal(journal_digest))
    }

    /// Read a claimant's best score for a specific `seed_id`.
    ///
    /// Returns `0` when no prior score exists.
    pub fn best_score(env: Env, claimant: Address, seed_id: u32) -> u32 {
        env.storage()
            .temporary()
            .get(&DataKey::BestByClaimantSeedId(claimant, seed_id))
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

    /// Admin: update the RISC Zero verifier address.
    pub fn set_verifier_id(env: Env, new_verifier_id: Address) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        env.storage()
            .instance()
            .set(&DataKey::VerifierId, &new_verifier_id);
        extend_instance_ttl(&env);
    }

    /// Admin: update the token address.
    pub fn set_token_id(env: Env, new_token_id: Address) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        env.storage()
            .instance()
            .set(&DataKey::TokenId, &new_token_id);
        extend_instance_ttl(&env);
    }

    /// Read the currently configured image ID used for receipt verification.
    pub fn image_id(env: Env) -> BytesN<32> {
        env.storage().instance().get(&DataKey::ImageId).unwrap()
    }

    /// Read the configured RISC Zero verifier contract address.
    pub fn verifier_id(env: Env) -> Address {
        env.storage().instance().get(&DataKey::VerifierId).unwrap()
    }

    /// Read the configured reward token contract address.
    pub fn token_id(env: Env) -> Address {
        env.storage().instance().get(&DataKey::TokenId).unwrap()
    }

    /// Read the hard-coded rules digest for AST4 verifier policy.
    pub fn rules_digest(_env: Env) -> u32 {
        RULES_DIGEST
    }

    /// Return the current window's seed, materializing it on first call per window.
    ///
    /// This method writes only one deterministic key:
    /// `SeedById(seed_id) -> seed`.
    pub fn current_seed(env: Env) -> CurrentSeed {
        get_or_materialize_current_seed(&env)
    }

    /// Verify a RISC Zero proof without minting rewards or mutating claim state.
    ///
    /// Returns the `final_score` carried by the verified journal.
    pub fn verify_score(env: Env, seal: Bytes, journal_raw: Bytes) -> Result<u32, ScoreError> {
        let journal = load_journal_bytes(&journal_raw)?;
        let parsed = parse_journal_fields(&journal);

        let journal_digest: BytesN<32> = env.crypto().sha256(&journal_raw).into();
        let verifier_id: Address = env.storage().instance().get(&DataKey::VerifierId).unwrap();
        let image_id: BytesN<32> = env.storage().instance().get(&DataKey::ImageId).unwrap();

        let verifier_client = risc0_verifier::Client::new(&env, &verifier_id);
        verifier_client.verify(&seal, &image_id, &journal_digest);

        Ok(parsed.final_score)
    }
}

/// Return the current deterministic seed entry for the active window.
///
/// If the active `seed_id` has no stored seed yet, this function generates one and stores
/// `SeedById(seed_id) -> seed` in temporary storage.
fn get_or_materialize_current_seed(env: &Env) -> CurrentSeed {
    let seed_id = (env.ledger().timestamp() / SEED_INTERVAL_SECONDS) as u32;

    if let Some(seed) = env
        .storage()
        .temporary()
        .get::<_, u32>(&DataKey::SeedById(seed_id))
    {
        return CurrentSeed { seed_id, seed };
    }

    let seed = env.prng().gen_range::<u64>(0..=u32::MAX as u64) as u32;
    env.storage()
        .temporary()
        .set(&DataKey::SeedById(seed_id), &seed);

    CurrentSeed { seed_id, seed }
}

/// Check whether a `(seed_id, seed)` pair is active and still inside the fixed age window.
///
/// A seed is active only if:
/// - `seed_id` is not in the future,
/// - its age is at most `MAX_SEED_AGE_WINDOWS`,
/// - and storage contains the exact `SeedById(seed_id) == seed`.
fn is_active_seed(env: &Env, seed_id: u32, seed: u32) -> bool {
    let now_seed_id = (env.ledger().timestamp() / SEED_INTERVAL_SECONDS) as u32;

    if seed_id > now_seed_id {
        return false;
    }
    if now_seed_id - seed_id > MAX_SEED_AGE_WINDOWS {
        return false;
    }

    env.storage()
        .temporary()
        .get::<_, u32>(&DataKey::SeedById(seed_id))
        == Some(seed)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ParsedJournalFields {
    seed_id: u32,
    seed: u32,
    frame_count: u32,
    final_score: u32,
}

/// Load and validate raw journal bytes into a fixed-size stack array.
///
/// Validation includes:
/// - exact byte length,
/// - and supported claimant kind tag.
fn load_journal_bytes(journal_raw: &Bytes) -> Result<[u8; JOURNAL_LEN_USIZE], ScoreError> {
    if journal_raw.len() != JOURNAL_LEN {
        return Err(ScoreError::InvalidJournalFormat);
    }

    let mut journal = [0u8; JOURNAL_LEN_USIZE];
    journal_raw.copy_into_slice(&mut journal);
    let claimant_kind = journal[JOURNAL_CLAIMANT_OFFSET_USIZE];
    if claimant_kind != JOURNAL_CLAIMANT_KIND_ACCOUNT
        && claimant_kind != JOURNAL_CLAIMANT_KIND_CONTRACT
    {
        return Err(ScoreError::InvalidJournalFormat);
    }
    Ok(journal)
}

/// Parse policy-relevant fields from a validated journal byte array.
fn parse_journal_fields(journal: &[u8; JOURNAL_LEN_USIZE]) -> ParsedJournalFields {
    ParsedJournalFields {
        seed_id: read_u32_le_from_slice(journal, JOURNAL_SEED_ID_OFFSET as usize),
        seed: read_u32_le_from_slice(journal, JOURNAL_SEED_OFFSET as usize),
        frame_count: read_u32_le_from_slice(journal, JOURNAL_FRAME_COUNT_OFFSET as usize),
        final_score: read_u32_le_from_slice(journal, JOURNAL_FINAL_SCORE_OFFSET as usize),
    }
}

/// Decode claimant bytes from the journal into a Soroban `Address`.
///
/// Supports account (`G...`) and contract (`C...`) claimant kinds.
fn read_claimant_address(
    env: &Env,
    journal: &[u8; JOURNAL_LEN_USIZE],
) -> Result<Address, ScoreError> {
    let kind = journal[JOURNAL_CLAIMANT_OFFSET_USIZE];
    let raw: [u8; 32] = journal[JOURNAL_CLAIMANT_OFFSET_USIZE + 1..JOURNAL_CLAIMANT_END_USIZE]
        .try_into()
        .map_err(|_| ScoreError::InvalidJournalFormat)?;
    let payload = match kind {
        JOURNAL_CLAIMANT_KIND_ACCOUNT => {
            AddressPayload::AccountIdPublicKeyEd25519(BytesN::from_array(env, &raw))
        }
        JOURNAL_CLAIMANT_KIND_CONTRACT => {
            AddressPayload::ContractIdHash(BytesN::from_array(env, &raw))
        }
        _ => return Err(ScoreError::InvalidJournalFormat),
    };
    Ok(Address::from_payload(env, payload))
}

/// Read a little-endian `u32` from `bytes[offset..offset+4]`.
#[inline(always)]
fn read_u32_le_from_slice(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
}

/// Bump contract instance TTL to keep admin config/state alive.
fn extend_instance_ttl(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_BUMP);
}

mod test;
