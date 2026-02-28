#![cfg(test)]

use crate::{
    AsteroidsScoreContract, AsteroidsScoreContractArgs, AsteroidsScoreContractClient, CurrentSeed,
    ScoreError, JOURNAL_CLAIMANT_ENCODED_LEN, JOURNAL_CLAIMANT_KIND_ACCOUNT,
    JOURNAL_CLAIMANT_KIND_CONTRACT, JOURNAL_CLAIMANT_OFFSET, JOURNAL_FINAL_SCORE_OFFSET,
    JOURNAL_FRAME_COUNT_OFFSET, JOURNAL_LEN, JOURNAL_SEED_ID_OFFSET, JOURNAL_SEED_OFFSET,
    MAX_SEED_AGE_WINDOWS, RULES_DIGEST, SEED_INTERVAL_SECONDS, TOKEN_DECIMALS_SCALE,
};
use soroban_sdk::{
    address_payload::AddressPayload,
    testutils::{Address as _, Ledger as _},
    token::StellarAssetClient,
    token::TokenClient,
    Address, Bytes, BytesN, Env,
};

mod mock_verifier_ok {
    use soroban_sdk::{contract, contractimpl, Bytes, BytesN, Env};

    #[contract]
    pub struct MockVerifier;

    #[contractimpl]
    impl MockVerifier {
        pub fn verify(_env: Env, _seal: Bytes, _image_id: BytesN<32>, _journal: BytesN<32>) {}
    }
}

mod mock_verifier_fail {
    use soroban_sdk::{contract, contractimpl, Bytes, BytesN, Env};

    #[contract]
    pub struct MockVerifierReject;

    #[contractimpl]
    impl MockVerifierReject {
        pub fn verify(_env: Env, _seal: Bytes, _image_id: BytesN<32>, _journal: BytesN<32>) {
            panic!("proof verification failed");
        }
    }
}

fn dummy_image_id(env: &Env) -> BytesN<32> {
    BytesN::from_array(env, &[0xAA; 32])
}

fn dummy_seal(env: &Env) -> Bytes {
    Bytes::from_slice(env, &[0u8; 64])
}

fn setup(env: &Env) -> (AsteroidsScoreContractClient<'_>, Address, Address) {
    let admin = Address::generate(env);

    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token_addr = sac.address();
    let verifier_addr = env.register(mock_verifier_ok::MockVerifier, ());
    let image_id = dummy_image_id(env);

    let contract_id = env.register(
        AsteroidsScoreContract,
        AsteroidsScoreContractArgs::__constructor(&admin, &verifier_addr, &image_id, &token_addr),
    );

    let sac_admin = StellarAssetClient::new(env, &token_addr);
    sac_admin.set_admin(&contract_id);

    let client = AsteroidsScoreContractClient::new(env, &contract_id);
    (client, admin, token_addr)
}

fn setup_with_failing_verifier(env: &Env) -> (AsteroidsScoreContractClient<'_>, Address) {
    let admin = Address::generate(env);

    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token_addr = sac.address();
    let verifier_addr = env.register(mock_verifier_fail::MockVerifierReject, ());
    let image_id = dummy_image_id(env);

    let contract_id = env.register(
        AsteroidsScoreContract,
        AsteroidsScoreContractArgs::__constructor(&admin, &verifier_addr, &image_id, &token_addr),
    );

    let sac_admin = StellarAssetClient::new(env, &token_addr);
    sac_admin.set_admin(&contract_id);

    let client = AsteroidsScoreContractClient::new(env, &contract_id);
    (client, token_addr)
}

fn set_ledger_time(env: &Env, timestamp: u64) {
    env.ledger().with_mut(|li| {
        li.timestamp = timestamp;
    });
}

fn make_journal(
    env: &Env,
    seed: u32,
    seed_id: u32,
    frame_count: u32,
    final_score: u32,
    claimant: &Address,
) -> Bytes {
    let mut buf = [0u8; JOURNAL_LEN as usize];

    buf[JOURNAL_SEED_ID_OFFSET as usize..JOURNAL_SEED_ID_OFFSET as usize + 4]
        .copy_from_slice(&seed_id.to_le_bytes());
    buf[JOURNAL_SEED_OFFSET as usize..JOURNAL_SEED_OFFSET as usize + 4]
        .copy_from_slice(&seed.to_le_bytes());
    buf[JOURNAL_FRAME_COUNT_OFFSET as usize..JOURNAL_FRAME_COUNT_OFFSET as usize + 4]
        .copy_from_slice(&frame_count.to_le_bytes());
    buf[JOURNAL_FINAL_SCORE_OFFSET as usize..JOURNAL_FINAL_SCORE_OFFSET as usize + 4]
        .copy_from_slice(&final_score.to_le_bytes());

    let mut claimant_raw = [0u8; JOURNAL_CLAIMANT_ENCODED_LEN];
    match claimant
        .to_payload()
        .expect("claimant payload must be account or contract")
    {
        AddressPayload::AccountIdPublicKeyEd25519(bytes) => {
            claimant_raw[0] = JOURNAL_CLAIMANT_KIND_ACCOUNT;
            let mut payload = [0u8; 32];
            bytes.copy_into_slice(&mut payload);
            claimant_raw[1..].copy_from_slice(&payload);
        }
        AddressPayload::ContractIdHash(bytes) => {
            claimant_raw[0] = JOURNAL_CLAIMANT_KIND_CONTRACT;
            let mut payload = [0u8; 32];
            bytes.copy_into_slice(&mut payload);
            claimant_raw[1..].copy_from_slice(&payload);
        }
    }
    buf[JOURNAL_CLAIMANT_OFFSET as usize
        ..JOURNAL_CLAIMANT_OFFSET as usize + JOURNAL_CLAIMANT_ENCODED_LEN]
        .copy_from_slice(&claimant_raw);

    Bytes::from_slice(env, &buf)
}

#[test]
fn test_initialize() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin, token_addr) = setup(&env);

    assert_eq!(client.image_id(), dummy_image_id(&env));
    assert_eq!(client.token_id(), token_addr);
    assert_eq!(client.rules_digest(), RULES_DIGEST);
    let _ = client.verifier_id();
}

#[test]
fn test_journal_layout_constants_are_stable() {
    assert_eq!(JOURNAL_SEED_ID_OFFSET, 0);
    assert_eq!(JOURNAL_SEED_OFFSET, 4);
    assert_eq!(JOURNAL_FRAME_COUNT_OFFSET, 8);
    assert_eq!(JOURNAL_FINAL_SCORE_OFFSET, 12);
    assert_eq!(JOURNAL_CLAIMANT_OFFSET, 16);
    assert_eq!(JOURNAL_LEN, 49);
}

#[test]
fn test_current_seed_materializes_single_key_per_seed_id() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin, _token_addr) = setup(&env);

    set_ledger_time(&env, 10 * SEED_INTERVAL_SECONDS);
    let a: CurrentSeed = client.current_seed();

    set_ledger_time(&env, 10 * SEED_INTERVAL_SECONDS + 42);
    let b: CurrentSeed = client.current_seed();
    assert_eq!(a, b);

    set_ledger_time(&env, 11 * SEED_INTERVAL_SECONDS);
    let c: CurrentSeed = client.current_seed();
    assert_eq!(c.seed_id, a.seed_id + 1);
    assert_ne!(c.seed, a.seed);
}

#[test]
fn test_submit_score_success_reads_claimant_from_journal() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin, token_addr) = setup(&env);
    let claimant = Address::generate(&env);
    let seal = dummy_seal(&env);

    set_ledger_time(&env, 77 * SEED_INTERVAL_SECONDS);
    let current = client.current_seed();
    let journal = make_journal(&env, current.seed, current.seed_id, 100, 42, &claimant);

    assert_eq!(client.submit_score(&seal, &journal), 42);
    assert_eq!(client.best_score(&claimant, &current.seed_id), 42);

    let token = TokenClient::new(&env, &token_addr);
    assert_eq!(token.balance(&claimant), 42 * TOKEN_DECIMALS_SCALE);

    let digest: BytesN<32> = env.crypto().sha256(&journal).into();
    assert!(client.is_claimed(&digest));
}

#[test]
fn test_submit_score_rejects_duplicate_journal() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin, _token_addr) = setup(&env);
    let claimant = Address::generate(&env);
    let seal = dummy_seal(&env);

    set_ledger_time(&env, 42 * SEED_INTERVAL_SECONDS);
    let current = client.current_seed();
    let journal = make_journal(&env, current.seed, current.seed_id, 100, 10, &claimant);

    client.submit_score(&seal, &journal);
    let result = client.try_submit_score(&seal, &journal);
    assert_eq!(result, Err(Ok(ScoreError::JournalAlreadyClaimed)));
}

#[test]
fn test_submit_score_rejects_non_improvement() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin, _token_addr) = setup(&env);
    let claimant = Address::generate(&env);
    let seal = dummy_seal(&env);

    set_ledger_time(&env, 50 * SEED_INTERVAL_SECONDS);
    let current = client.current_seed();

    let low = make_journal(&env, current.seed, current.seed_id, 100, 100, &claimant);
    let same = make_journal(&env, current.seed, current.seed_id, 101, 100, &claimant);

    assert_eq!(client.submit_score(&seal, &low), 100);
    assert_eq!(
        client.try_submit_score(&seal, &same),
        Err(Ok(ScoreError::ScoreNotImproved))
    );
}

#[test]
fn test_submit_score_rejects_invalid_journal_length() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin, _token_addr) = setup(&env);
    let seal = dummy_seal(&env);
    let short_journal = Bytes::from_slice(&env, &[0u8; JOURNAL_LEN as usize - 1]);
    let long_journal = Bytes::from_slice(&env, &[0u8; JOURNAL_LEN as usize + 1]);

    assert_eq!(
        client.try_submit_score(&seal, &short_journal),
        Err(Ok(ScoreError::InvalidJournalFormat))
    );
    assert_eq!(
        client.try_submit_score(&seal, &long_journal),
        Err(Ok(ScoreError::InvalidJournalFormat))
    );
}

#[test]
fn test_submit_score_rejects_invalid_claimant_kind() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin, _token_addr) = setup(&env);
    let claimant = Address::generate(&env);
    let seal = dummy_seal(&env);

    set_ledger_time(&env, 80 * SEED_INTERVAL_SECONDS);
    let current = client.current_seed();
    let journal = make_journal(&env, current.seed, current.seed_id, 100, 5, &claimant);
    let mut raw = [0u8; JOURNAL_LEN as usize];
    journal.copy_into_slice(&mut raw);
    raw[JOURNAL_CLAIMANT_OFFSET as usize] = 0xFF;
    let invalid = Bytes::from_slice(&env, &raw);

    assert_eq!(
        client.try_submit_score(&seal, &invalid),
        Err(Ok(ScoreError::InvalidJournalFormat))
    );
}

#[test]
fn test_submit_score_rejects_seed_not_materialized() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin, _token_addr) = setup(&env);
    let claimant = Address::generate(&env);
    let seal = dummy_seal(&env);

    set_ledger_time(&env, 60 * SEED_INTERVAL_SECONDS);
    let journal = make_journal(&env, 0xDEAD_BEEF, 60, 100, 5, &claimant);

    assert_eq!(
        client.try_submit_score(&seal, &journal),
        Err(Ok(ScoreError::SeedNotActive))
    );
}

#[test]
fn test_submit_score_rejects_seed_outside_24h_window() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin, _token_addr) = setup(&env);
    let claimant = Address::generate(&env);
    let seal = dummy_seal(&env);

    set_ledger_time(&env, SEED_INTERVAL_SECONDS);
    let old = client.current_seed();

    let now_seed_id = old.seed_id + MAX_SEED_AGE_WINDOWS + 1;
    set_ledger_time(&env, now_seed_id as u64 * SEED_INTERVAL_SECONDS);

    let journal = make_journal(&env, old.seed, old.seed_id, 100, 7, &claimant);
    assert_eq!(
        client.try_submit_score(&seal, &journal),
        Err(Ok(ScoreError::SeedNotActive))
    );
}

#[test]
fn test_submit_score_verification_failure_rolls_back_claimed() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _token_addr) = setup_with_failing_verifier(&env);
    let claimant = Address::generate(&env);
    let seal = dummy_seal(&env);

    set_ledger_time(&env, 80 * SEED_INTERVAL_SECONDS);
    let current = client.current_seed();
    let journal = make_journal(&env, current.seed, current.seed_id, 100, 20, &claimant);

    let result = client.try_submit_score(&seal, &journal);
    assert!(result.is_err());

    let digest: BytesN<32> = env.crypto().sha256(&journal).into();
    assert!(!client.is_claimed(&digest));
}
