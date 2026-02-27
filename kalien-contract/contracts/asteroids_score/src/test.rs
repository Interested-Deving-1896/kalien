#![cfg(test)]

extern crate std;

use crate::{
    AsteroidsScoreContract, AsteroidsScoreContractArgs, AsteroidsScoreContractClient, DataKey,
    ScoreError,
};
use soroban_sdk::{
    contract, contractimpl, contracttype,
    testutils::{Address as _, EnvTestConfig, Events as _, Ledger as _},
    token::StellarAssetClient,
    token::TokenClient,
    xdr, Address, Bytes, BytesN, Env,
};

const RULES_DIGEST_AST3: u32 = 0x4153_5433;
const TOKEN_DECIMALS_SCALE: i128 = 10_000_000;
const SEED_INTERVAL: u64 = 600;

// ---------------------------------------------------------------------------
// Mock routers
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

mod mock_router_fail {
    use soroban_sdk::{contract, contractimpl, Bytes, BytesN, Env};

    #[contract]
    pub struct MockRouterFail;

    #[contractimpl]
    impl MockRouterFail {
        pub fn verify(_env: Env, _seal: Bytes, _image_id: BytesN<32>, _journal: BytesN<32>) {
            panic!("proof verification failed");
        }
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
    for (i, byte) in buf.iter_mut().enumerate() {
        *byte = journal_raw_24.get(i as u32).unwrap();
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

fn current_window(env: &Env) -> u32 {
    (env.ledger().timestamp() / SEED_INTERVAL) as u32
}

fn materialize_and_index_seed(env: &Env, client: &AsteroidsScoreContractClient<'_>) -> u32 {
    let seed = client.current_seed();
    assert!(client.index_seed(&current_window(env), &seed));
    seed
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
    let seal = dummy_seal(&env);

    set_ledger_time(&env, SEED_INTERVAL);
    let seed = materialize_and_index_seed(&env, &client); // materialize and index
    let journal = make_journal(&env, seed, 42);
    let score = client.submit_score(&seal, &journal, &claimant);
    assert_eq!(score, 42);
    assert_eq!(client.best_score(&claimant, &seed), 42);

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
    let seal = dummy_seal(&env);

    set_ledger_time(&env, 7 * SEED_INTERVAL);
    let seed = materialize_and_index_seed(&env, &client);
    let journal = make_journal(&env, seed, 77);
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
    let seal = dummy_seal(&env);

    set_ledger_time(&env, 7 * SEED_INTERVAL);
    let seed = materialize_and_index_seed(&env, &client);
    let journal = make_journal(&env, seed, 77);
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
    let seed = materialize_and_index_seed(&env, &client);
    let journal_a = make_journal(&env, seed, 80);
    client.submit_score(&seal, &journal_a, &claimant);

    let journal_b = make_journal(&env, seed, 79);
    let result = client.try_submit_score(&seal, &journal_b, &claimant);
    assert_eq!(result, Err(Ok(ScoreError::ScoreNotImproved)));

    let token = TokenClient::new(&env, &token_addr);
    assert_eq!(token.balance(&claimant), 80 * TOKEN_DECIMALS_SCALE);
    assert_eq!(client.best_score(&claimant, &seed), 80);
}

#[test]
fn test_submit_score_improvement_mints_delta() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin, token_addr) = setup(&env);
    let claimant = Address::generate(&env);
    let seal = dummy_seal(&env);

    set_ledger_time(&env, 10 * SEED_INTERVAL);
    let seed = materialize_and_index_seed(&env, &client);
    let journal_a = make_journal(&env, seed, 10);
    assert_eq!(client.submit_score(&seal, &journal_a, &claimant), 10);

    let journal_b = make_journal(&env, seed, 25);
    assert_eq!(client.submit_score(&seal, &journal_b, &claimant), 25);
    assert_eq!(client.best_score(&claimant, &seed), 25);

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

    // Materialize seed for window 1
    set_ledger_time(&env, SEED_INTERVAL);
    let seed_a = materialize_and_index_seed(&env, &client);

    // Materialize seed for window 2 (different window → different random seed)
    set_ledger_time(&env, 2 * SEED_INTERVAL);
    let seed_b = materialize_and_index_seed(&env, &client);

    // seed_a is in ValidSeed(1), seed_b is in ValidSeed(2) — both valid from window 2
    assert_eq!(
        client.submit_score(&seal, &make_journal(&env, seed_a, 10), &claimant),
        10
    );
    assert_eq!(
        client.submit_score(&seal, &make_journal(&env, seed_b, 20), &claimant),
        20
    );

    assert_eq!(client.best_score(&claimant, &seed_a), 10);
    assert_eq!(client.best_score(&claimant, &seed_b), 20);

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

    set_ledger_time(&env, SEED_INTERVAL);
    let seed = materialize_and_index_seed(&env, &client);
    let journal = make_journal(&env, seed, 0);
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
    for (i, byte) in id_arr.iter_mut().enumerate() {
        *byte = id_bytes.get(i as u32).unwrap();
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

    // Inject the fixture's seed into temp storage for window 1 so submit_score accepts it.
    // Fixture proofs have hardcoded seeds; key=window_number, value=seed.
    let seed = read_seed_from_journal(&journal_raw);
    set_ledger_time(&env, SEED_INTERVAL); // window 1
    env.as_contract(&contract_id, || {
        env.storage()
            .temporary()
            .set(&DataKey::ValidSeed(1u32), &seed);
    });
    assert!(client.index_seed(&1u32, &seed));

    let score = client.submit_score(&seal, &journal_raw, &claimant);
    assert_eq!(score, expected_score);

    let token = TokenClient::new(&env, &token_addr);
    assert_eq!(
        token.balance(&claimant),
        expected_score as i128 * TOKEN_DECIMALS_SCALE
    );

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

    set_ledger_time(&env, 123 * SEED_INTERVAL);
    let seed = materialize_and_index_seed(&env, &client); // materialize and index
    let journal = make_journal(&env, seed, 4_567);
    let digest: BytesN<32> = env.crypto().sha256(&journal).into();

    let before = env.events().all().events().len();
    assert_eq!(client.submit_score(&seal, &journal, &claimant), 4_567);
    let all_events = env.events().all();
    let raw_events = all_events.events();
    assert!(raw_events.len() > before);

    let last_event = raw_events.last().expect("missing emitted event");
    let xdr::ContractEventBody::V0(body) = &last_event.body;
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
    assert_eq!(event_map_get_xdr_u32(event_map, "seed"), seed);
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
    let medium_seed = read_seed_from_journal(&medium_journal);

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
    let real_seed = read_seed_from_journal(&real_journal);

    // Inject both fixture seeds into temp storage as ValidSeed(window) entries.
    // medium_seed in window 2, real_seed in window 1.
    // Set ledger to window 2 so both are within the valid range (current and previous).
    env.ledger().with_mut(|li| {
        li.timestamp = 2 * SEED_INTERVAL;
    });
    env.as_contract(&contract_id, || {
        env.storage()
            .temporary()
            .set(&DataKey::ValidSeed(2u32), &medium_seed);
        env.storage()
            .temporary()
            .set(&DataKey::ValidSeed(1u32), &real_seed);
    });
    assert!(client.index_seed(&2u32, &medium_seed));
    assert!(client.index_seed(&1u32, &real_seed));

    assert_eq!(
        client.submit_score(&medium_seal, &medium_journal, &claimant),
        90
    );
    assert_eq!(token.balance(&claimant), 90 * TOKEN_DECIMALS_SCALE);

    assert_eq!(
        client.submit_score(&short_seal, &short_journal, &claimant),
        1030
    );
    assert_eq!(token.balance(&claimant), (90 + 940) * TOKEN_DECIMALS_SCALE);

    assert_eq!(
        client.submit_score(&real_seal, &real_journal, &claimant),
        32860
    );
    // 90 + 940 + 32860 = 33890 (not 33980: short only mints delta over medium)
    assert_eq!(
        token.balance(&claimant),
        (90 + 940 + 32860) * TOKEN_DECIMALS_SCALE
    );
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

    set_ledger_time(&env, SEED_INTERVAL);
    let seed = materialize_and_index_seed(&env, &client);

    // Pause the contract
    client.set_paused(&true);

    // Submissions should fail
    let journal = make_journal(&env, seed, 42);
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
// Seed validity tests
// ---------------------------------------------------------------------------

#[test]
fn test_submit_score_seed_not_materialized_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin, _token_addr) = setup(&env);
    let claimant = Address::generate(&env);
    let seal = dummy_seal(&env);

    set_ledger_time(&env, 1000 * SEED_INTERVAL);

    // An arbitrary seed that was never materialized via current_seed() is invalid
    let journal = make_journal(&env, 0xDEAD_C0DE, 42);
    let result = client.try_submit_score(&seal, &journal, &claimant);
    assert_eq!(result, Err(Ok(ScoreError::SeedExpired)));
}

#[test]
fn test_submit_score_prev_window_seed_still_valid() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin, _token_addr) = setup(&env);
    let claimant = Address::generate(&env);
    let seal = dummy_seal(&env);

    // Materialize seed for window 1
    set_ledger_time(&env, SEED_INTERVAL);
    let seed_window1 = materialize_and_index_seed(&env, &client);

    // Advance to window 2 and materialize a new seed
    set_ledger_time(&env, 2 * SEED_INTERVAL);
    let _seed_window2 = materialize_and_index_seed(&env, &client);

    // seed_window1 is in ValidSeed(1), still accessible from window 2 (current - 1)
    let journal = make_journal(&env, seed_window1, 42);
    let score = client.submit_score(&seal, &journal, &claimant);
    assert_eq!(score, 42);
}

#[test]
fn test_submit_score_seed_current_window_valid() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin, token_addr) = setup(&env);
    let claimant = Address::generate(&env);
    let seal = dummy_seal(&env);

    set_ledger_time(&env, 1000 * SEED_INTERVAL);
    let seed = materialize_and_index_seed(&env, &client);

    let journal = make_journal(&env, seed, 42);
    let score = client.submit_score(&seal, &journal, &claimant);
    assert_eq!(score, 42);

    let token = TokenClient::new(&env, &token_addr);
    assert_eq!(token.balance(&claimant), 42 * TOKEN_DECIMALS_SCALE);
}

#[test]
fn test_submit_score_seed_injected_via_storage_valid() {
    // Simulates the fixture test pattern: inject ValidSeed(window) = known_seed into temp storage.
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token_addr = sac.address();
    let router_addr = env.register(mock_router_ok::MockRouter, ());
    let image_id = dummy_image_id(&env);
    let contract_id = env.register(
        AsteroidsScoreContract,
        AsteroidsScoreContractArgs::__constructor(&admin, &router_addr, &image_id, &token_addr),
    );
    StellarAssetClient::new(&env, &token_addr).set_admin(&contract_id);
    let client = AsteroidsScoreContractClient::new(&env, &contract_id);

    let claimant = Address::generate(&env);
    let seal = dummy_seal(&env);

    let known_seed = 0x1234_5678u32;
    set_ledger_time(&env, SEED_INTERVAL); // window 1
    env.as_contract(&contract_id, || {
        env.storage()
            .temporary()
            .set(&DataKey::ValidSeed(1u32), &known_seed);
    });
    assert!(client.index_seed(&1u32, &known_seed));

    let journal = make_journal(&env, known_seed, 100);
    let score = client.submit_score(&seal, &journal, &claimant);
    assert_eq!(score, 100);

    let token = TokenClient::new(&env, &token_addr);
    assert_eq!(token.balance(&claimant), 100 * TOKEN_DECIMALS_SCALE);
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

    // First call in window 10 materializes a random seed
    set_ledger_time(&env, 6000); // 6000 / 600 = window 10
    let seed_a = client.current_seed();
    assert!(client.index_seed(&10u32, &seed_a));

    // Repeated call in the same window returns the cached seed (idempotent)
    set_ledger_time(&env, 6599); // still window 10
    let seed_b = client.current_seed();
    assert_eq!(seed_a, seed_b);

    // Advancing into window 11 generates a new seed
    set_ledger_time(&env, 6600); // 6600 / 600 = window 11
    let seed_c = client.current_seed();
    assert!(client.index_seed(&11u32, &seed_c));

    // The new seed is stored and consistent within the new window
    let seed_d = client.current_seed();
    assert_eq!(seed_c, seed_d);

    // seed_a is in ValidSeed(10), seed_c is in ValidSeed(11) — both valid from window 11
    let journal_a = make_journal(&env, seed_a, 10);
    let journal_c = make_journal(&env, seed_c, 20);
    let claimant = Address::generate(&env);
    let seal = dummy_seal(&env);
    assert_eq!(client.submit_score(&seal, &journal_a, &claimant), 10);
    assert_eq!(client.submit_score(&seal, &journal_c, &claimant), 20);
}

// ---------------------------------------------------------------------------
// New coverage tests added during audit
// ---------------------------------------------------------------------------

#[test]
fn test_submit_score_equal_score_rejected() {
    // The check is final_score <= previous_best; equal must also be rejected.
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin, _token_addr) = setup(&env);
    let claimant = Address::generate(&env);
    let seal = dummy_seal(&env);

    set_ledger_time(&env, SEED_INTERVAL);
    let seed = materialize_and_index_seed(&env, &client);

    // Establish a best score of 50.
    let journal_a = make_journal(&env, seed, 50);
    assert_eq!(client.submit_score(&seal, &journal_a, &claimant), 50);

    // Submit a different journal (different frame_count → different digest)
    // with the same final_score: must be rejected as ScoreNotImproved.
    let mut buf = [0u8; 24];
    buf[0..4].copy_from_slice(&seed.to_le_bytes());
    buf[4..8].copy_from_slice(&200u32.to_le_bytes()); // different frame_count
    buf[8..12].copy_from_slice(&50u32.to_le_bytes()); // same final_score
    buf[12..16].copy_from_slice(&99u32.to_le_bytes());
    buf[16..20].copy_from_slice(&0xDEADu32.to_le_bytes());
    buf[20..24].copy_from_slice(&RULES_DIGEST_AST3.to_le_bytes());
    let journal_b = Bytes::from_slice(&env, &buf);

    let result = client.try_submit_score(&seal, &journal_b, &claimant);
    assert_eq!(result, Err(Ok(ScoreError::ScoreNotImproved)));
}

#[test]
fn test_submit_score_seed_expired_outside_24h_window() {
    // Seeds are valid as long as their ValidSeed(w) entry exists and w >= now - 143
    // (144 windows × 10 min = 24 h hard cap).  The cap prevents externally-bumped
    // TTLs from keeping seeds valid indefinitely.
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token_addr = sac.address();
    let router_addr = env.register(mock_router_ok::MockRouter, ());
    let image_id = dummy_image_id(&env);
    let contract_id = env.register(
        AsteroidsScoreContract,
        AsteroidsScoreContractArgs::__constructor(&admin, &router_addr, &image_id, &token_addr),
    );
    StellarAssetClient::new(&env, &token_addr).set_admin(&contract_id);
    let client = AsteroidsScoreContractClient::new(&env, &contract_id);

    let claimant = Address::generate(&env);
    let seal = dummy_seal(&env);

    // At window 200: oldest valid window is 200 - 143 = 57.
    let now_window: u32 = 200;
    let seed_inside = 0xAA_00_00_01u32; // injected at window 57 (just inside cap)
    let seed_outside = 0xAA_00_00_02u32; // injected at window 56 (just outside cap)

    env.as_contract(&contract_id, || {
        env.storage()
            .temporary()
            .set(&DataKey::ValidSeed(now_window - 143), &seed_inside);
        env.storage()
            .temporary()
            .set(&DataKey::ValidSeed(now_window - 144), &seed_outside);
    });

    set_ledger_time(&env, now_window as u64 * SEED_INTERVAL);
    assert!(client.index_seed(&(now_window - 143), &seed_inside));
    assert!(!client.index_seed(&(now_window - 144), &seed_outside));

    // seed_inside is at exactly the boundary (w = now - 143) — must be accepted.
    let journal_inside = make_journal(&env, seed_inside, 42);
    assert_eq!(client.submit_score(&seal, &journal_inside, &claimant), 42);

    // seed_outside is one window beyond the cap (w = now - 144) — must be rejected.
    let journal_outside = make_journal(&env, seed_outside, 42);
    let result = client.try_submit_score(&seal, &journal_outside, &claimant);
    assert_eq!(result, Err(Ok(ScoreError::SeedExpired)));
}

#[test]
fn test_submit_score_two_claimants_same_seed_independent() {
    // Best(Alice, seed) and Best(Bob, seed) are independent — one player's
    // score must not block another player's independent submission.
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin, token_addr) = setup(&env);
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    let seal = dummy_seal(&env);

    set_ledger_time(&env, SEED_INTERVAL);
    let seed = materialize_and_index_seed(&env, &client);

    // Alice scores 80
    let journal_a = make_journal(&env, seed, 80);
    assert_eq!(client.submit_score(&seal, &journal_a, &alice), 80);

    // Bob scores 30 with a different proof — not blocked by Alice's 80
    let journal_b = make_journal(&env, seed, 30);
    assert_eq!(client.submit_score(&seal, &journal_b, &bob), 30);

    assert_eq!(client.best_score(&alice, &seed), 80);
    assert_eq!(client.best_score(&bob, &seed), 30);

    let token = TokenClient::new(&env, &token_addr);
    assert_eq!(token.balance(&alice), 80 * TOKEN_DECIMALS_SCALE);
    assert_eq!(token.balance(&bob), 30 * TOKEN_DECIMALS_SCALE);
}

#[test]
fn test_set_admin_admin_only() {
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

    let new_admin = Address::generate(&env);
    let result = client.try_set_admin(&new_admin);
    assert!(result.is_err());
}

#[test]
fn test_submit_score_verification_failure_does_not_claim_journal() {
    // When the router rejects a proof (panics), the transaction must revert
    // completely: no tokens minted, journal not marked as claimed.
    // This also validates the CEI ordering: writes happen before the
    // cross-contract call but are rolled back by the host on panic.
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let claimant = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token_addr = sac.address();
    let failing_router = env.register(mock_router_fail::MockRouterFail, ());
    let image_id = dummy_image_id(&env);

    let contract_id = env.register(
        AsteroidsScoreContract,
        AsteroidsScoreContractArgs::__constructor(&admin, &failing_router, &image_id, &token_addr),
    );
    StellarAssetClient::new(&env, &token_addr).set_admin(&contract_id);
    let client = AsteroidsScoreContractClient::new(&env, &contract_id);

    let seed = 0xCAFE_BABEu32;
    set_ledger_time(&env, SEED_INTERVAL); // window 1
    env.as_contract(&contract_id, || {
        env.storage()
            .temporary()
            .set(&DataKey::ValidSeed(1u32), &seed);
    });
    assert!(client.index_seed(&1u32, &seed));

    let seal = dummy_seal(&env);
    let journal = make_journal(&env, seed, 100);

    let result = client.try_submit_score(&seal, &journal, &claimant);
    assert!(result.is_err()); // router panic propagates as an error

    // All effects must be rolled back
    let token = TokenClient::new(&env, &token_addr);
    assert_eq!(token.balance(&claimant), 0);

    let journal_digest: BytesN<32> = env.crypto().sha256(&journal).into();
    assert!(!client.is_claimed(&journal_digest));
    assert_eq!(client.best_score(&claimant, &seed), 0);
}

#[test]
fn test_set_token_id_admin_only() {
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

    let new_token = Address::generate(&env);
    // Without mock_all_auths, admin auth is not provided — must fail
    let result = client.try_set_token_id(&new_token);
    assert!(result.is_err());
}

#[test]
fn test_set_token_id_updates_storage() {
    let env = Env::default();
    env.mock_all_auths();

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

    let new_token = Address::generate(&env);
    client.set_token_id(&new_token);
    assert_eq!(client.token_id(), new_token);
}

// ---------------------------------------------------------------------------
// Seed storage cost benchmark (instance vs persistent vs temporary)
// ---------------------------------------------------------------------------

const BENCH_RING_WINDOWS: u32 = 144;
const BENCH_MAX_AGE_WINDOWS: u32 = BENCH_RING_WINDOWS - 1;

#[derive(Clone)]
#[contracttype]
struct BenchSeedSlot {
    window: u32,
    seed: u32,
    valid: bool,
}

#[derive(Clone)]
#[contracttype]
struct BenchSeedRing {
    head: u32,
    slots: soroban_sdk::Vec<BenchSeedSlot>,
}

fn bench_seed_for_window(window: u32) -> u32 {
    // Stable deterministic seed generation for reproducible metering tests.
    window.wrapping_mul(1_664_525).wrapping_add(1_013_904_223)
}

fn bench_empty_ring(env: &Env) -> BenchSeedRing {
    let mut slots = soroban_sdk::Vec::new(env);
    for _ in 0..BENCH_RING_WINDOWS {
        slots.push_back(BenchSeedSlot {
            window: 0,
            seed: 0,
            valid: false,
        });
    }
    BenchSeedRing {
        head: BENCH_RING_WINDOWS - 1,
        slots,
    }
}

fn bench_ring_refresh(mut ring: BenchSeedRing, window: u32) -> (BenchSeedRing, u32) {
    let current = ring.slots.get(ring.head).unwrap();
    if current.valid && current.window == window {
        return (ring, current.seed);
    }

    let seed = bench_seed_for_window(window);
    let next = (ring.head + 1) % BENCH_RING_WINDOWS;
    ring.slots.set(
        next,
        BenchSeedSlot {
            window,
            seed,
            valid: true,
        },
    );
    ring.head = next;
    (ring, seed)
}

fn bench_ring_validate(ring: &BenchSeedRing, now_window: u32, seed: u32) -> bool {
    for i in 0..BENCH_RING_WINDOWS {
        let slot = ring.slots.get(i).unwrap();
        if !slot.valid || slot.seed != seed {
            continue;
        }
        if slot.window > now_window {
            return false;
        }
        return now_window - slot.window <= BENCH_MAX_AGE_WINDOWS;
    }
    false
}

#[contracttype]
enum BenchInstanceKey {
    Ring,
}

#[contract]
struct BenchInstanceRingStore;

#[contractimpl]
impl BenchInstanceRingStore {
    pub fn refresh(env: Env, window: u32) -> u32 {
        let ring = env
            .storage()
            .instance()
            .get::<_, BenchSeedRing>(&BenchInstanceKey::Ring)
            .unwrap_or_else(|| bench_empty_ring(&env));
        let (next, seed) = bench_ring_refresh(ring, window);
        env.storage().instance().set(&BenchInstanceKey::Ring, &next);
        seed
    }

    pub fn validate(env: Env, now_window: u32, seed: u32) -> bool {
        env.storage()
            .instance()
            .get::<_, BenchSeedRing>(&BenchInstanceKey::Ring)
            .map(|ring| bench_ring_validate(&ring, now_window, seed))
            .unwrap_or(false)
    }
}

#[contracttype]
enum BenchPersistentKey {
    Ring,
}

#[contract]
struct BenchPersistentRingStore;

#[contractimpl]
impl BenchPersistentRingStore {
    pub fn refresh(env: Env, window: u32) -> u32 {
        let ring = env
            .storage()
            .persistent()
            .get::<_, BenchSeedRing>(&BenchPersistentKey::Ring)
            .unwrap_or_else(|| bench_empty_ring(&env));
        let (next, seed) = bench_ring_refresh(ring, window);
        env.storage()
            .persistent()
            .set(&BenchPersistentKey::Ring, &next);
        seed
    }

    pub fn validate(env: Env, now_window: u32, seed: u32) -> bool {
        env.storage()
            .persistent()
            .get::<_, BenchSeedRing>(&BenchPersistentKey::Ring)
            .map(|ring| bench_ring_validate(&ring, now_window, seed))
            .unwrap_or(false)
    }
}

#[contracttype]
enum BenchTempKey {
    SeedByWindow(u32),
    WindowBySeed(u32),
}

#[contract]
struct BenchTemporaryKeyStore;

#[contractimpl]
impl BenchTemporaryKeyStore {
    pub fn refresh(env: Env, window: u32) -> u32 {
        let by_window = BenchTempKey::SeedByWindow(window);
        if let Some(existing) = env.storage().temporary().get::<_, u32>(&by_window) {
            return existing;
        }

        let seed = bench_seed_for_window(window);
        env.storage().temporary().set(&by_window, &seed);
        env.storage()
            .temporary()
            .set(&BenchTempKey::WindowBySeed(seed), &window);
        seed
    }

    pub fn validate(env: Env, now_window: u32, seed: u32) -> bool {
        env.storage()
            .temporary()
            .get::<_, u32>(&BenchTempKey::WindowBySeed(seed))
            .map(|seed_window| {
                seed_window <= now_window && now_window - seed_window <= BENCH_MAX_AGE_WINDOWS
            })
            .unwrap_or(false)
    }
}

#[derive(Copy, Clone)]
struct BenchCost {
    instructions: i64,
    mem_bytes: i64,
    memory_reads: u32,
    write_entries: u32,
    write_bytes: u32,
    disk_read_entries: u32,
    disk_read_bytes: u32,
    fee_total: i64,
    fee_write_entries: i64,
    fee_write_bytes: i64,
    budget_cpu: u64,
    budget_mem: u64,
}

#[derive(Copy, Clone)]
struct BenchScenario {
    refresh_same_window: BenchCost,
    refresh_new_window: BenchCost,
    validate_hit: BenchCost,
    validate_expired: BenchCost,
}

fn capture_bench_cost(env: &Env) -> BenchCost {
    let estimate = env.cost_estimate();
    let resources = estimate.resources();
    let fee = estimate.fee();
    let budget = estimate.budget();
    BenchCost {
        instructions: resources.instructions,
        mem_bytes: resources.mem_bytes,
        memory_reads: resources.memory_read_entries,
        write_entries: resources.write_entries,
        write_bytes: resources.write_bytes,
        disk_read_entries: resources.disk_read_entries,
        disk_read_bytes: resources.disk_read_bytes,
        fee_total: fee.total,
        fee_write_entries: fee.write_entries,
        fee_write_bytes: fee.write_bytes,
        budget_cpu: budget.cpu_instruction_cost(),
        budget_mem: budget.memory_bytes_cost(),
    }
}

fn print_cost_row(name: &str, label: &str, cost: BenchCost) {
    std::println!(
        "[seed-bench] {:<15} {:<18} instr={} mem={} mem_reads={} writes={} write_bytes={} disk_reads={} disk_read_bytes={} fee_total={} fee_write_entries={} fee_write_bytes={} budget_cpu={} budget_mem={}",
        name,
        label,
        cost.instructions,
        cost.mem_bytes,
        cost.memory_reads,
        cost.write_entries,
        cost.write_bytes,
        cost.disk_read_entries,
        cost.disk_read_bytes,
        cost.fee_total,
        cost.fee_write_entries,
        cost.fee_write_bytes,
        cost.budget_cpu,
        cost.budget_mem,
    );
}

fn print_scenario(name: &str, scenario: BenchScenario) {
    print_cost_row(name, "refresh_same_window", scenario.refresh_same_window);
    print_cost_row(name, "refresh_new_window", scenario.refresh_new_window);
    print_cost_row(name, "validate_hit", scenario.validate_hit);
    print_cost_row(name, "validate_expired", scenario.validate_expired);
}

fn new_bench_env() -> Env {
    Env::new_with_config(EnvTestConfig {
        capture_snapshot_at_drop: false,
    })
}

fn run_instance_ring_benchmark() -> BenchScenario {
    let env = new_bench_env();
    let contract_id = env.register(BenchInstanceRingStore, ());
    let client = BenchInstanceRingStoreClient::new(&env, &contract_id);

    for window in 1..=BENCH_RING_WINDOWS {
        client.refresh(&window);
    }

    let now_window = BENCH_RING_WINDOWS;
    let _same_seed = client.refresh(&now_window);
    let refresh_same_window = capture_bench_cost(&env);

    let next_window = now_window + 1;
    let next_seed = client.refresh(&next_window);
    let refresh_new_window = capture_bench_cost(&env);

    assert!(client.validate(&next_window, &next_seed));
    let validate_hit = capture_bench_cost(&env);

    let expired_window = next_window + BENCH_RING_WINDOWS;
    assert!(!client.validate(&expired_window, &next_seed));
    let validate_expired = capture_bench_cost(&env);

    BenchScenario {
        refresh_same_window,
        refresh_new_window,
        validate_hit,
        validate_expired,
    }
}

fn run_persistent_ring_benchmark() -> BenchScenario {
    let env = new_bench_env();
    let contract_id = env.register(BenchPersistentRingStore, ());
    let client = BenchPersistentRingStoreClient::new(&env, &contract_id);

    for window in 1..=BENCH_RING_WINDOWS {
        client.refresh(&window);
    }

    let now_window = BENCH_RING_WINDOWS;
    let _same_seed = client.refresh(&now_window);
    let refresh_same_window = capture_bench_cost(&env);

    let next_window = now_window + 1;
    let next_seed = client.refresh(&next_window);
    let refresh_new_window = capture_bench_cost(&env);

    assert!(client.validate(&next_window, &next_seed));
    let validate_hit = capture_bench_cost(&env);

    let expired_window = next_window + BENCH_RING_WINDOWS;
    assert!(!client.validate(&expired_window, &next_seed));
    let validate_expired = capture_bench_cost(&env);

    BenchScenario {
        refresh_same_window,
        refresh_new_window,
        validate_hit,
        validate_expired,
    }
}

fn run_temporary_keyed_benchmark() -> BenchScenario {
    let env = new_bench_env();
    let contract_id = env.register(BenchTemporaryKeyStore, ());
    let client = BenchTemporaryKeyStoreClient::new(&env, &contract_id);

    for window in 1..=BENCH_RING_WINDOWS {
        client.refresh(&window);
    }

    let now_window = BENCH_RING_WINDOWS;
    let _same_seed = client.refresh(&now_window);
    let refresh_same_window = capture_bench_cost(&env);

    let next_window = now_window + 1;
    let next_seed = client.refresh(&next_window);
    let refresh_new_window = capture_bench_cost(&env);

    assert!(client.validate(&next_window, &next_seed));
    let validate_hit = capture_bench_cost(&env);

    let expired_window = next_window + BENCH_RING_WINDOWS;
    assert!(!client.validate(&expired_window, &next_seed));
    let validate_expired = capture_bench_cost(&env);

    BenchScenario {
        refresh_same_window,
        refresh_new_window,
        validate_hit,
        validate_expired,
    }
}

#[test]
fn test_seed_storage_cost_benchmark_variants() {
    let instance = run_instance_ring_benchmark();
    let persistent = run_persistent_ring_benchmark();
    let temporary = run_temporary_keyed_benchmark();

    print_scenario("instance_ring", instance);
    print_scenario("persistent_ring", persistent);
    print_scenario("temporary_keyed", temporary);

    let mut best_name = "instance_ring";
    let mut best_fee = instance.validate_hit.fee_total;
    if persistent.validate_hit.fee_total < best_fee {
        best_name = "persistent_ring";
        best_fee = persistent.validate_hit.fee_total;
    }
    if temporary.validate_hit.fee_total < best_fee {
        best_name = "temporary_keyed";
        best_fee = temporary.validate_hit.fee_total;
    }

    std::println!(
        "[seed-bench] winner validate_hit fee_total: {} ({})",
        best_name,
        best_fee
    );

    // Sanity assertions so benchmark output can't silently degenerate.
    assert!(instance.validate_hit.instructions > 0);
    assert!(persistent.validate_hit.instructions > 0);
    assert!(temporary.validate_hit.instructions > 0);
}

#[test]
fn test_seed_indexed_submit_roundtrip_no_snapshot() {
    let env = new_bench_env();
    env.mock_all_auths();

    let (client, _admin, token_addr) = setup(&env);
    let claimant = Address::generate(&env);
    let seal = dummy_seal(&env);

    set_ledger_time(&env, 42 * SEED_INTERVAL);
    let seed = client.current_seed();
    assert!(client.index_seed(&42u32, &seed));

    let journal = make_journal(&env, seed, 321);
    assert_eq!(client.submit_score(&seal, &journal, &claimant), 321);

    let token = TokenClient::new(&env, &token_addr);
    assert_eq!(token.balance(&claimant), 321 * TOKEN_DECIMALS_SCALE);
}

#[test]
fn test_index_seed_rejects_stale_window_no_snapshot() {
    let env = new_bench_env();
    env.mock_all_auths();

    let (client, _admin, _token_addr) = setup(&env);
    let now_window: u32 = 200;
    let stale_window = now_window - (BENCH_MAX_AGE_WINDOWS + 1);
    set_ledger_time(&env, stale_window as u64 * SEED_INTERVAL);
    let stale_seed = client.current_seed();

    set_ledger_time(&env, now_window as u64 * SEED_INTERVAL);
    assert!(!client.index_seed(&stale_window, &stale_seed));
}
