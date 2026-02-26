#![cfg(test)]

use crate::{
    AsteroidsScoreContract, AsteroidsScoreContractArgs, AsteroidsScoreContractClient, ScoreError,
};
use soroban_sdk::{
    testutils::{Address as _, Events as _, Ledger as _},
    token::StellarAssetClient,
    token::TokenClient,
    xdr, Address, Bytes, BytesN, Env,
};

const RULES_DIGEST_AST3: u32 = 0x4153_5433;
const TOKEN_DECIMALS_SCALE: i128 = 10_000_000;
const SEED_INTERVAL: u64 = 600;

// ---------------------------------------------------------------------------
// Mock router: always accepts verify
// ---------------------------------------------------------------------------
mod mock_router_ok {
    use soroban_sdk::{contract, contractimpl, Bytes, BytesN, Env};

    #[contract]
    pub struct MockRouter;

    #[contractimpl]
    impl MockRouter {
        pub fn verify(_env: Env, _seal: Bytes, _image_id: BytesN<32>, _journal: BytesN<32>) {}
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn base_journal_24(seed: u32, final_score: u32, rules_digest: u32) -> [u8; 24] {
    let mut buf = [0u8; 24];
    buf[0..4].copy_from_slice(&seed.to_le_bytes());
    buf[4..8].copy_from_slice(&100u32.to_le_bytes());
    buf[8..12].copy_from_slice(&final_score.to_le_bytes());
    buf[12..16].copy_from_slice(&99u32.to_le_bytes());
    buf[16..20].copy_from_slice(&0xDEADu32.to_le_bytes());
    buf[20..24].copy_from_slice(&rules_digest.to_le_bytes());
    buf
}

fn make_journal(env: &Env, seed: u32, final_score: u32) -> Bytes {
    Bytes::from_slice(env, &base_journal_24(seed, final_score, RULES_DIGEST_AST3))
}

fn force_ast3_rules_digest(env: &Env, journal_raw_24: &Bytes) -> Bytes {
    let mut buf = [0u8; 24];
    for i in 0..24 {
        buf[i] = journal_raw_24.get(i as u32).unwrap();
    }
    buf[20..24].copy_from_slice(&RULES_DIGEST_AST3.to_le_bytes());
    Bytes::from_slice(env, &buf)
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
    let router_addr = env.register(mock_router_ok::MockRouter, ());
    let image_id = dummy_image_id(env);

    let contract_id = env.register(
        AsteroidsScoreContract,
        AsteroidsScoreContractArgs::__constructor(&admin, &router_addr, &image_id, &token_addr),
    );

    let sac_admin = StellarAssetClient::new(env, &token_addr);
    sac_admin.set_admin(&contract_id);

    let client = AsteroidsScoreContractClient::new(env, &contract_id);
    (client, admin, token_addr)
}

fn set_ledger_time(env: &Env, timestamp: u64) {
    env.ledger().with_mut(|li| {
        li.timestamp = timestamp;
    });
}

fn read_seed_from_journal(journal: &Bytes) -> u32 {
    let b0 = journal.get(0).unwrap() as u32;
    let b1 = journal.get(1).unwrap() as u32;
    let b2 = journal.get(2).unwrap() as u32;
    let b3 = journal.get(3).unwrap() as u32;
    b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[test]
fn test_initialize() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin, token_addr) = setup(&env);

    assert_eq!(client.image_id(), dummy_image_id(&env));
    assert_eq!(client.token_id(), token_addr);
    assert_eq!(client.rules_digest(), RULES_DIGEST_AST3);
    let _ = client.router_id();
}

#[test]
fn test_submit_score_success() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin, token_addr) = setup(&env);
    let claimant = Address::generate(&env);
    let journal = make_journal(&env, 1, 42);
    let seal = dummy_seal(&env);

    set_ledger_time(&env, 1 * SEED_INTERVAL);
    let score = client.submit_score(&seal, &journal, &claimant);
    assert_eq!(score, 42);
    assert_eq!(client.best_score(&claimant, &1), 42);

    let token = TokenClient::new(&env, &token_addr);
    assert_eq!(token.balance(&claimant), 42 * TOKEN_DECIMALS_SCALE);

    let digest: BytesN<32> = env.crypto().sha256(&journal).into();
    assert!(client.is_claimed(&digest));
}

#[test]
fn test_submit_score_duplicate_journal_rejected_same_claimant() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin, _token_addr) = setup(&env);
    let claimant = Address::generate(&env);
    let journal = make_journal(&env, 7, 77);
    let seal = dummy_seal(&env);

    set_ledger_time(&env, 7 * SEED_INTERVAL);
    client.submit_score(&seal, &journal, &claimant);
    let result = client.try_submit_score(&seal, &journal, &claimant);
    assert_eq!(result, Err(Ok(ScoreError::JournalAlreadyClaimed)));
}

#[test]
fn test_submit_score_duplicate_journal_rejected_different_claimant() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin, _token_addr) = setup(&env);
    let claimant_a = Address::generate(&env);
    let claimant_b = Address::generate(&env);
    let journal = make_journal(&env, 7, 77);
    let seal = dummy_seal(&env);

    set_ledger_time(&env, 7 * SEED_INTERVAL);
    client.submit_score(&seal, &journal, &claimant_a);
    let result = client.try_submit_score(&seal, &journal, &claimant_b);
    assert_eq!(result, Err(Ok(ScoreError::JournalAlreadyClaimed)));
}

#[test]
fn test_submit_score_not_improved_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin, token_addr) = setup(&env);
    let claimant = Address::generate(&env);
    let seal = dummy_seal(&env);

    set_ledger_time(&env, 9 * SEED_INTERVAL);
    let journal_a = make_journal(&env, 9, 80);
    client.submit_score(&seal, &journal_a, &claimant);

    let journal_b = make_journal(&env, 9, 79);
    let result = client.try_submit_score(&seal, &journal_b, &claimant);
    assert_eq!(result, Err(Ok(ScoreError::ScoreNotImproved)));

    let token = TokenClient::new(&env, &token_addr);
    assert_eq!(token.balance(&claimant), 80 * TOKEN_DECIMALS_SCALE);
    assert_eq!(client.best_score(&claimant, &9), 80);
}

#[test]
fn test_submit_score_improvement_mints_delta() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin, token_addr) = setup(&env);
    let claimant = Address::generate(&env);
    let seal = dummy_seal(&env);

    set_ledger_time(&env, 10 * SEED_INTERVAL);
    let journal_a = make_journal(&env, 10, 10);
    assert_eq!(client.submit_score(&seal, &journal_a, &claimant), 10);

    let journal_b = make_journal(&env, 10, 25);
    assert_eq!(client.submit_score(&seal, &journal_b, &claimant), 25);
    assert_eq!(client.best_score(&claimant, &10), 25);

    let token = TokenClient::new(&env, &token_addr);
    assert_eq!(token.balance(&claimant), 25 * TOKEN_DECIMALS_SCALE); // 10 + (25 - 10)
}

#[test]
fn test_submit_score_different_seeds_track_independently() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin, token_addr) = setup(&env);
    let claimant = Address::generate(&env);
    let seal = dummy_seal(&env);

    // bucket=2, min_bucket=0 — both seeds 1 and 2 are valid
    set_ledger_time(&env, 2 * SEED_INTERVAL);
    assert_eq!(
        client.submit_score(&seal, &make_journal(&env, 1, 10), &claimant),
        10
    );
    assert_eq!(
        client.submit_score(&seal, &make_journal(&env, 2, 20), &claimant),
        20
    );

    assert_eq!(client.best_score(&claimant, &1), 10);
    assert_eq!(client.best_score(&claimant, &2), 20);

    let token = TokenClient::new(&env, &token_addr);
    assert_eq!(token.balance(&claimant), 30 * TOKEN_DECIMALS_SCALE);
}

#[test]
fn test_submit_score_invalid_journal_length() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin, _token_addr) = setup(&env);
    let claimant = Address::generate(&env);
    let seal = dummy_seal(&env);

    let short_journal = Bytes::from_slice(&env, &[0u8; 20]);
    let result = client.try_submit_score(&seal, &short_journal, &claimant);
    assert_eq!(result, Err(Ok(ScoreError::InvalidJournalLength)));

    let long_journal = Bytes::from_slice(&env, &[0u8; 32]);
    let result = client.try_submit_score(&seal, &long_journal, &claimant);
    assert_eq!(result, Err(Ok(ScoreError::InvalidJournalLength)));
}

#[test]
fn test_submit_score_wrong_rules_digest() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin, _token_addr) = setup(&env);
    let claimant = Address::generate(&env);
    let seal = dummy_seal(&env);
    let bad = Bytes::from_slice(&env, &base_journal_24(1, 42, 0xBAAD_F00D));

    let result = client.try_submit_score(&seal, &bad, &claimant);
    assert_eq!(result, Err(Ok(ScoreError::InvalidRulesDigest)));
}

#[test]
fn test_submit_score_zero_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin, token_addr) = setup(&env);
    let claimant = Address::generate(&env);
    let seal = dummy_seal(&env);
    let journal = make_journal(&env, 1, 0);

    set_ledger_time(&env, 1 * SEED_INTERVAL);
    let result = client.try_submit_score(&seal, &journal, &claimant);
    assert_eq!(result, Err(Ok(ScoreError::ZeroScoreNotAllowed)));

    let token = TokenClient::new(&env, &token_addr);
    assert_eq!(token.balance(&claimant), 0);
}

#[test]
fn test_set_image_id_admin_only() {
    let env = Env::default();

    let admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token_addr = sac.address();
    let router_addr = env.register(mock_router_ok::MockRouter, ());
    let image_id = dummy_image_id(&env);

    let contract_id = env.register(
        AsteroidsScoreContract,
        AsteroidsScoreContractArgs::__constructor(&admin, &router_addr, &image_id, &token_addr),
    );
    let client = AsteroidsScoreContractClient::new(&env, &contract_id);

    let new_image_id = BytesN::from_array(&env, &[0xBB; 32]);
    let result = client.try_set_image_id(&new_image_id);
    assert!(result.is_err());
}

#[test]
fn test_set_image_id_success() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin, _token_addr) = setup(&env);
    let new_image_id = BytesN::from_array(&env, &[0xBB; 32]);
    client.set_image_id(&new_image_id);
    assert_eq!(client.image_id(), new_image_id);
}

#[test]
fn test_set_admin() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin, _token_addr) = setup(&env);
    let new_admin = Address::generate(&env);
    client.set_admin(&new_admin);

    let new_image_id = BytesN::from_array(&env, &[0xCC; 32]);
    client.set_image_id(&new_image_id);
    assert_eq!(client.image_id(), new_image_id);
}

#[test]
fn test_upgrade_admin_only() {
    let env = Env::default();

    let admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token_addr = sac.address();
    let router_addr = env.register(mock_router_ok::MockRouter, ());
    let image_id = dummy_image_id(&env);

    let contract_id = env.register(
        AsteroidsScoreContract,
        AsteroidsScoreContractArgs::__constructor(&admin, &router_addr, &image_id, &token_addr),
    );
    let client = AsteroidsScoreContractClient::new(&env, &contract_id);

    let upgraded_wasm = Bytes::from_slice(&env, include_bytes!("../risc0_router.wasm"));
    let upgraded_wasm_hash = env.deployer().upload_contract_wasm(upgraded_wasm);
    let result = client.try_upgrade(&upgraded_wasm_hash);
    assert!(result.is_err());
}

#[test]
fn test_upgrade_success() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin, _token_addr) = setup(&env);
    let upgraded_wasm = Bytes::from_slice(&env, include_bytes!("../risc0_router.wasm"));
    let upgraded_wasm_hash = env.deployer().upload_contract_wasm(upgraded_wasm);

    client.upgrade(&upgraded_wasm_hash);
    assert!(client.try_rules_digest().is_err());
}

// ---------------------------------------------------------------------------
// Integration tests with real proof fixture data
// ---------------------------------------------------------------------------

fn hex_nibble(b: u8) -> u8 {
    match b {
        b'0'..=b'9' => b - b'0',
        b'a'..=b'f' => b - b'a' + 10,
        b'A'..=b'F' => b - b'A' + 10,
        _ => panic!("invalid hex char"),
    }
}

fn hex_to_soroban_bytes(env: &Env, hex: &str) -> Bytes {
    let hex = hex.trim().as_bytes();
    let len = hex.len() / 2;
    let mut result = Bytes::new(env);
    for i in 0..len {
        let byte = (hex_nibble(hex[i * 2]) << 4) | hex_nibble(hex[i * 2 + 1]);
        result.push_back(byte);
    }
    result
}

fn parse_image_id(env: &Env, hex: &str) -> BytesN<32> {
    let id_bytes = hex_to_soroban_bytes(env, hex);
    let mut id_arr = [0u8; 32];
    for i in 0..32 {
        id_arr[i] = id_bytes.get(i as u32).unwrap();
    }
    BytesN::from_array(env, &id_arr)
}

fn event_map_get_xdr<'a>(map: &'a xdr::ScMap, key: &str) -> &'a xdr::ScVal {
    for entry in map.iter() {
        if let xdr::ScVal::Symbol(symbol) = &entry.key {
            if symbol.0.to_utf8_string().expect("invalid symbol").as_str() == key {
                return &entry.val;
            }
        }
    }
    panic!("missing event key: {key}");
}

fn event_map_get_xdr_u32(map: &xdr::ScMap, key: &str) -> u32 {
    match event_map_get_xdr(map, key) {
        xdr::ScVal::U32(value) => *value,
        _ => panic!("event key '{key}' is not u32"),
    }
}

fn run_fixture_test(
    seal_hex: &str,
    journal_raw_hex: &str,
    image_id_hex: &str,
    expected_score: u32,
) {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let claimant = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token_addr = sac.address();
    let router_addr = env.register(mock_router_ok::MockRouter, ());
    let image_id = parse_image_id(&env, image_id_hex);

    let contract_id = env.register(
        AsteroidsScoreContract,
        AsteroidsScoreContractArgs::__constructor(&admin, &router_addr, &image_id, &token_addr),
    );
    StellarAssetClient::new(&env, &token_addr).set_admin(&contract_id);
    let client = AsteroidsScoreContractClient::new(&env, &contract_id);

    let seal = hex_to_soroban_bytes(&env, seal_hex);
    let journal_raw = force_ast3_rules_digest(&env, &hex_to_soroban_bytes(&env, journal_raw_hex));

    // Set ledger time so the fixture seed is in the valid bucket window
    let seed = read_seed_from_journal(&journal_raw);
    set_ledger_time(&env, seed as u64 * SEED_INTERVAL);

    let score = client.submit_score(&seal, &journal_raw, &claimant);
    assert_eq!(score, expected_score);

    let token = TokenClient::new(&env, &token_addr);
    assert_eq!(token.balance(&claimant), expected_score as i128 * TOKEN_DECIMALS_SCALE);

    let journal_digest: BytesN<32> = env.crypto().sha256(&journal_raw).into();
    assert!(client.is_claimed(&journal_digest));

    let result = client.try_submit_score(&seal, &journal_raw, &claimant);
    assert_eq!(result, Err(Ok(ScoreError::JournalAlreadyClaimed)));
}

#[test]
fn test_submit_score_event_contains_journal_and_reward_context() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin, _token_addr) = setup(&env);
    let claimant = Address::generate(&env);
    let seal = dummy_seal(&env);
    let journal = make_journal(&env, 123, 4_567);
    let digest: BytesN<32> = env.crypto().sha256(&journal).into();

    set_ledger_time(&env, 123 * SEED_INTERVAL);
    let before = env.events().all().events().len();
    assert_eq!(client.submit_score(&seal, &journal, &claimant), 4_567);
    let all_events = env.events().all();
    let raw_events = all_events.events();
    assert!(raw_events.len() > before);

    let last_event = raw_events.last().expect("missing emitted event");
    let body = match &last_event.body {
        xdr::ContractEventBody::V0(v0) => v0,
    };
    let event_name = match body.topics.iter().next() {
        Some(xdr::ScVal::Symbol(symbol)) => {
            symbol.0.to_utf8_string().expect("invalid event symbol")
        }
        _ => panic!("missing score_submitted topic"),
    };
    assert_eq!(event_name, "score_submitted");

    let event_map = match &body.data {
        xdr::ScVal::Map(Some(map)) => map,
        _ => panic!("score_submitted data is not a map"),
    };
    match event_map_get_xdr(event_map, "claimant") {
        xdr::ScVal::Address(_) => {}
        _ => panic!("claimant field is not an address"),
    }
    assert_eq!(event_map_get_xdr_u32(event_map, "seed"), 123);
    assert_eq!(event_map_get_xdr_u32(event_map, "frame_count"), 100);
    assert_eq!(event_map_get_xdr_u32(event_map, "final_score"), 4_567);
    assert_eq!(event_map_get_xdr_u32(event_map, "final_rng_state"), 99);
    assert_eq!(event_map_get_xdr_u32(event_map, "tape_checksum"), 0xDEAD);
    assert_eq!(
        event_map_get_xdr_u32(event_map, "rules_digest"),
        RULES_DIGEST_AST3
    );
    assert_eq!(event_map_get_xdr_u32(event_map, "previous_best"), 0);
    assert_eq!(event_map_get_xdr_u32(event_map, "new_best"), 4_567);
    assert_eq!(event_map_get_xdr_u32(event_map, "minted_delta"), 4_567);

    match event_map_get_xdr(event_map, "journal_digest") {
        xdr::ScVal::Bytes(bytes) => {
            assert_eq!(bytes.len(), 32);
            let expected_digest = digest.to_array();
            for (index, value) in bytes.iter().enumerate() {
                assert_eq!(*value, expected_digest[index]);
            }
        }
        _ => panic!("journal_digest field is not bytes"),
    }
}

#[test]
fn test_fixture_short_tape_score_1030() {
    run_fixture_test(
        include_str!("../../../../test-fixtures/proof-short-groth16.seal"),
        include_str!("../../../../test-fixtures/proof-short-groth16.journal_raw"),
        include_str!("../../../../test-fixtures/proof-short-groth16.image_id"),
        1030,
    );
}

#[test]
fn test_fixture_medium_tape_score_90() {
    run_fixture_test(
        include_str!("../../../../test-fixtures/proof-medium-groth16.seal"),
        include_str!("../../../../test-fixtures/proof-medium-groth16.journal_raw"),
        include_str!("../../../../test-fixtures/proof-medium-groth16.image_id"),
        90,
    );
}

#[test]
fn test_fixture_real_game_score_32860() {
    run_fixture_test(
        include_str!("../../../../test-fixtures/proof-real-game-groth16.seal"),
        include_str!("../../../../test-fixtures/proof-real-game-groth16.journal_raw"),
        include_str!("../../../../test-fixtures/proof-real-game-groth16.image_id"),
        32860,
    );
}

#[test]
fn test_fixture_all_three_cumulative() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let claimant = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token_addr = sac.address();
    let router_addr = env.register(mock_router_ok::MockRouter, ());
    let image_id = parse_image_id(
        &env,
        include_str!("../../../../test-fixtures/proof-medium-groth16.image_id"),
    );

    let contract_id = env.register(
        AsteroidsScoreContract,
        AsteroidsScoreContractArgs::__constructor(&admin, &router_addr, &image_id, &token_addr),
    );
    StellarAssetClient::new(&env, &token_addr).set_admin(&contract_id);
    let client = AsteroidsScoreContractClient::new(&env, &contract_id);
    let token = TokenClient::new(&env, &token_addr);

    // medium first (score 90, seed 0xDEADBEEF) — must come before short
    // because both share the same seed and short's score (1030) is higher
    let medium_seal = hex_to_soroban_bytes(
        &env,
        include_str!("../../../../test-fixtures/proof-medium-groth16.seal"),
    );
    let medium_journal = force_ast3_rules_digest(
        &env,
        &hex_to_soroban_bytes(
            &env,
            include_str!("../../../../test-fixtures/proof-medium-groth16.journal_raw"),
        ),
    );
    set_ledger_time(&env, read_seed_from_journal(&medium_journal) as u64 * SEED_INTERVAL);
    assert_eq!(
        client.submit_score(&medium_seal, &medium_journal, &claimant),
        90
    );
    assert_eq!(token.balance(&claimant), 90 * TOKEN_DECIMALS_SCALE);

    // short (score 1030, same seed 0xDEADBEEF — mints delta 1030-90=940)
    let short_seal = hex_to_soroban_bytes(
        &env,
        include_str!("../../../../test-fixtures/proof-short-groth16.seal"),
    );
    let short_journal = force_ast3_rules_digest(
        &env,
        &hex_to_soroban_bytes(
            &env,
            include_str!("../../../../test-fixtures/proof-short-groth16.journal_raw"),
        ),
    );
    assert_eq!(
        client.submit_score(&short_seal, &short_journal, &claimant),
        1030
    );
    assert_eq!(token.balance(&claimant), (90 + 940) * TOKEN_DECIMALS_SCALE);

    // real game (score 32860, different seed 0x43C9C6CD)
    let real_seal = hex_to_soroban_bytes(
        &env,
        include_str!("../../../../test-fixtures/proof-real-game-groth16.seal"),
    );
    let real_journal = force_ast3_rules_digest(
        &env,
        &hex_to_soroban_bytes(
            &env,
            include_str!("../../../../test-fixtures/proof-real-game-groth16.journal_raw"),
        ),
    );
    set_ledger_time(&env, read_seed_from_journal(&real_journal) as u64 * SEED_INTERVAL);
    assert_eq!(
        client.submit_score(&real_seal, &real_journal, &claimant),
        32860
    );
    // 90 + 940 + 32860 = 33890 (not 33980: short only mints delta over medium)
    assert_eq!(token.balance(&claimant), (90 + 940 + 32860) * TOKEN_DECIMALS_SCALE);
}

// ---------------------------------------------------------------------------
// Security tests
// ---------------------------------------------------------------------------

#[test]
fn test_pause_blocks_submissions() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin, _token_addr) = setup(&env);
    let claimant = Address::generate(&env);
    let seal = dummy_seal(&env);

    set_ledger_time(&env, 1 * SEED_INTERVAL);

    // Pause the contract
    client.set_paused(&true);

    // Submissions should fail
    let journal = make_journal(&env, 1, 42);
    let result = client.try_submit_score(&seal, &journal, &claimant);
    assert_eq!(result, Err(Ok(ScoreError::ContractPaused)));

    // Unpause
    client.set_paused(&false);

    // Submissions should work again
    let score = client.submit_score(&seal, &journal, &claimant);
    assert_eq!(score, 42);
}

#[test]
fn test_set_paused_admin_only() {
    let env = Env::default();

    let admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token_addr = sac.address();
    let router_addr = env.register(mock_router_ok::MockRouter, ());
    let image_id = dummy_image_id(&env);

    let contract_id = env.register(
        AsteroidsScoreContract,
        AsteroidsScoreContractArgs::__constructor(&admin, &router_addr, &image_id, &token_addr),
    );
    let client = AsteroidsScoreContractClient::new(&env, &contract_id);

    // Without auth, set_paused should fail
    let result = client.try_set_paused(&true);
    assert!(result.is_err());
}

#[test]
fn test_set_router_id() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin, _token_addr) = setup(&env);
    let new_router = Address::generate(&env);
    client.set_router_id(&new_router);
    assert_eq!(client.router_id(), new_router);
}

#[test]
fn test_set_router_id_admin_only() {
    let env = Env::default();

    let admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token_addr = sac.address();
    let router_addr = env.register(mock_router_ok::MockRouter, ());
    let image_id = dummy_image_id(&env);

    let contract_id = env.register(
        AsteroidsScoreContract,
        AsteroidsScoreContractArgs::__constructor(&admin, &router_addr, &image_id, &token_addr),
    );
    let client = AsteroidsScoreContractClient::new(&env, &contract_id);

    let new_router = Address::generate(&env);
    let result = client.try_set_router_id(&new_router);
    assert!(result.is_err());
}

// ---------------------------------------------------------------------------
// Seed bucket validation tests
// ---------------------------------------------------------------------------

#[test]
fn test_submit_score_seed_expired_future() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin, _token_addr) = setup(&env);
    let claimant = Address::generate(&env);
    let seal = dummy_seal(&env);

    let current_bucket = 1000u32;
    set_ledger_time(&env, current_bucket as u64 * SEED_INTERVAL);

    // seed one bucket in the future
    let journal = make_journal(&env, current_bucket + 1, 42);
    let result = client.try_submit_score(&seal, &journal, &claimant);
    assert_eq!(result, Err(Ok(ScoreError::SeedExpired)));
}

#[test]
fn test_submit_score_seed_expired_too_old() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin, _token_addr) = setup(&env);
    let claimant = Address::generate(&env);
    let seal = dummy_seal(&env);

    let current_bucket = 1000u32;
    set_ledger_time(&env, current_bucket as u64 * SEED_INTERVAL);

    // seed 144 buckets old (max_age is 143, so this is just outside the window)
    let journal = make_journal(&env, current_bucket - 144, 42);
    let result = client.try_submit_score(&seal, &journal, &claimant);
    assert_eq!(result, Err(Ok(ScoreError::SeedExpired)));
}

#[test]
fn test_submit_score_seed_boundary_current() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin, token_addr) = setup(&env);
    let claimant = Address::generate(&env);
    let seal = dummy_seal(&env);

    let current_bucket = 1000u32;
    set_ledger_time(&env, current_bucket as u64 * SEED_INTERVAL);

    // seed = current bucket (should succeed)
    let journal = make_journal(&env, current_bucket, 42);
    let score = client.submit_score(&seal, &journal, &claimant);
    assert_eq!(score, 42);

    let token = TokenClient::new(&env, &token_addr);
    assert_eq!(token.balance(&claimant), 42 * TOKEN_DECIMALS_SCALE);
}

#[test]
fn test_submit_score_seed_boundary_oldest_valid() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin, token_addr) = setup(&env);
    let claimant = Address::generate(&env);
    let seal = dummy_seal(&env);

    let current_bucket = 1000u32;
    set_ledger_time(&env, current_bucket as u64 * SEED_INTERVAL);

    // seed = current - 143 (oldest valid bucket)
    let journal = make_journal(&env, current_bucket - 143, 42);
    let score = client.submit_score(&seal, &journal, &claimant);
    assert_eq!(score, 42);

    let token = TokenClient::new(&env, &token_addr);
    assert_eq!(token.balance(&claimant), 42 * TOKEN_DECIMALS_SCALE);
}

// ---------------------------------------------------------------------------
// verify_score tests
// ---------------------------------------------------------------------------

#[test]
fn test_verify_score_success() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, _token_addr) = setup(&env);
    let seal = dummy_seal(&env);
    let journal = make_journal(&env, 999, 42);

    let score = client.verify_score(&seal, &journal);
    assert_eq!(score, 42);
}

#[test]
fn test_verify_score_invalid_journal() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, _token_addr) = setup(&env);
    let seal = dummy_seal(&env);
    let short_journal = Bytes::from_slice(&env, &[0u8; 20]);

    let result = client.try_verify_score(&seal, &short_journal);
    assert_eq!(result, Err(Ok(ScoreError::InvalidJournalLength)));
}

#[test]
fn test_verify_score_wrong_rules_digest() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, _token_addr) = setup(&env);
    let seal = dummy_seal(&env);
    let bad = Bytes::from_slice(&env, &base_journal_24(1, 42, 0xBAAD_F00D));

    let result = client.try_verify_score(&seal, &bad);
    assert_eq!(result, Err(Ok(ScoreError::InvalidRulesDigest)));
}

#[test]
fn test_current_seed() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, _token_addr) = setup(&env);

    set_ledger_time(&env, 6000);
    assert_eq!(client.current_seed(), 10); // 6000 / 600 = 10

    set_ledger_time(&env, 6599);
    assert_eq!(client.current_seed(), 10); // 6599 / 600 = 10 (truncated)

    set_ledger_time(&env, 6600);
    assert_eq!(client.current_seed(), 11); // 6600 / 600 = 11
}
