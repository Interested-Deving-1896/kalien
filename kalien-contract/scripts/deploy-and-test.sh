#!/usr/bin/env bash
# deploy-and-test.sh
#
# End-to-end integration test against Stellar testnet.
# Deploys contracts, submits proof fixtures via the mock verifier path,
# and verifies token minting + replay protection.
#
# Uses the mock verifier (registered in the RISC Zero router) to generate
# valid seals without requiring Groth16 proof compatibility. This tests
# the full contract logic: auth, journal parsing, replay protection, minting.
#
# Prerequisites:
#   - `stellar` CLI v25+
#   - Contract built: `stellar contract build` in workspace root
#   - Proof fixtures in test-fixtures/ (for journal_raw + image_id)
#
# Usage:
#   ./scripts/deploy-and-test.sh                    # full deploy + test (mock verifier)
#   ./scripts/deploy-and-test.sh --proof-mode all   # mock tests + real Groth16 tests
#   ./scripts/deploy-and-test.sh --deploy-mode reuse # reuse existing deployment
#   ./scripts/deploy-and-test.sh --deployer <name>  # custom deployer key name

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/_helpers.sh"

require_cmds stellar python3 xxd

DEPLOY_MODE="fresh" # fresh|reuse
PROOF_MODE="mock" # mock|all
# Use unique key names per run to avoid token admin conflicts
RUN_ID=$(date +%s | tail -c 7)
DEPLOYER_NAME="ast-deploy-${RUN_ID}"
PLAYER_NAME="ast-player-${RUN_ID}"

# Shared state/env file (also loaded by _helpers.sh env chain)
STATE_FILE="${KALIEN_CONTRACT_STATE_FILE:-$CONTRACT_ENV_FILE}"

# Test counters
PASSED=0
FAILED=0
TOTAL=0

usage() {
  cat <<'USAGE_EOF'
Usage: kalien-contract/scripts/deploy-and-test.sh [options]

Options:
  --deploy-mode <mode>  fresh|reuse (default: fresh)
  --proof-mode <mode>   mock|all (default: mock)
  --deployer <name>     Custom deployer key name
  -h, --help            Show this help
USAGE_EOF
}

# ---------------------------------------------------------------------------
# Parse args
# ---------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --deploy-mode)
      DEPLOY_MODE="$(echo "${2:-}" | tr '[:upper:]' '[:lower:]')"
      shift 2
      ;;
    --proof-mode)
      PROOF_MODE="$(echo "${2:-}" | tr '[:upper:]' '[:lower:]')"
      shift 2
      ;;
    --deployer)
      DEPLOYER_NAME="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown arg: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ "$DEPLOY_MODE" != "fresh" && "$DEPLOY_MODE" != "reuse" ]]; then
  err "--deploy-mode must be fresh or reuse"
  exit 1
fi

if [[ "$PROOF_MODE" != "mock" && "$PROOF_MODE" != "all" ]]; then
  err "--proof-mode must be mock or all"
  exit 1
fi

# ---------------------------------------------------------------------------
# Test assertions
# ---------------------------------------------------------------------------
assert_eq() {
  local label="$1" expected="$2" actual="$3"
  TOTAL=$((TOTAL + 1))
  if [[ "$expected" == "$actual" ]]; then
    PASSED=$((PASSED + 1))
    ok "$label: $actual"
  else
    FAILED=$((FAILED + 1))
    err "$label: expected '$expected', got '$actual'"
  fi
}

assert_fail() {
  local label="$1" exit_code="$2"
  TOTAL=$((TOTAL + 1))
  if [[ "$exit_code" -ne 0 ]]; then
    PASSED=$((PASSED + 1))
    ok "$label (rejected as expected)"
  else
    FAILED=$((FAILED + 1))
    err "$label: expected failure but succeeded"
  fi
}

# ---------------------------------------------------------------------------
# Seed helpers (for live seed_id + seed materialization)
# ---------------------------------------------------------------------------

u32_to_le_hex() {
  local value="$1"
  local be_hex
  be_hex=$(printf '%08x' "$value")
  echo "${be_hex:6:2}${be_hex:4:2}${be_hex:2:2}${be_hex:0:2}"
}

set_journal_seed_hex() {
  local journal_hex="$1"
  local seed="$2"
  local seed_id="${3:-$CURRENT_SEED_ID}"
  local seed_le
  local seed_id_le
  seed_le=$(u32_to_le_hex "$seed")
  seed_id_le=$(u32_to_le_hex "$seed_id")
  # AST4 journal layout starts with:
  # [0..3] seed_id (u32 LE), [4..7] seed (u32 LE)
  echo "${seed_id_le}${seed_le}${journal_hex:16}"
}

materialize_current_seed() {
  local contract_id="$1"
  local current_seed_json seed seed_id

  current_seed_json=$(stellar contract invoke -q \
    --id "$contract_id" \
    --source "$DEPLOYER_NAME" \
    --network "$NETWORK" \
    -- \
    current_seed 2>&1) || return 1

  seed=$(echo "$current_seed_json" | jq -r '.seed // empty' 2>/dev/null || true)
  seed_id=$(echo "$current_seed_json" | jq -r '.seed_id // empty' 2>/dev/null || true)

  if [[ -z "$seed" || -z "$seed_id" ]]; then
    err "failed to parse current_seed response: $current_seed_json"
    return 1
  fi

  CURRENT_SEED="$seed"
  CURRENT_SEED_ID="$seed_id"
  return 0
}

# ---------------------------------------------------------------------------
# State persistence
# ---------------------------------------------------------------------------
save_state() {
  save_state_vars "$STATE_FILE" \
    SCORE_CONTRACT_ID "$SCORE_CONTRACT_ID" \
    TOKEN_ID "$TOKEN_ID" \
    DEPLOYER_NAME "$DEPLOYER_NAME" \
    PLAYER_NAME "$PLAYER_NAME" \
    IMAGE_ID_HEX "$IMAGE_ID_HEX"
}

# ---------------------------------------------------------------------------
# Deploy
# ---------------------------------------------------------------------------
deploy() {
  info "Building contract..."
  (cd "$CONTRACT_DIR" && stellar contract build)
  ok "WASM built: $(wc -c < "$WASM" | tr -d ' ') bytes"

  ensure_funded_key "$DEPLOYER_NAME"
  ensure_funded_key "$PLAYER_NAME"

  DEPLOYER_ADDR=$(stellar keys address "$DEPLOYER_NAME")
  PLAYER_ADDR=$(stellar keys address "$PLAYER_NAME")
  info "Deployer address: $DEPLOYER_ADDR"
  info "Player address:   $PLAYER_ADDR"

  # Read image_id from fixtures
  read_image_id
  info "Image ID: $IMAGE_ID_HEX"

  # Deploy SAC token (KALIEN token)
  info "Deploying KALIEN token (Stellar Asset Contract)..."
  local token_output
  token_output=$(stellar contract asset deploy \
    --asset "KALIEN:$DEPLOYER_ADDR" \
    --source "$DEPLOYER_NAME" \
    --network "$NETWORK" 2>&1) || {
    token_output=$(stellar contract id asset \
      --asset "KALIEN:$DEPLOYER_ADDR" \
      --network "$NETWORK" 2>&1)
  }
  TOKEN_ID=$(echo "$token_output" | grep -oE '^C[A-Z0-9]{55}$' | tail -1)
  ok "Token ID: $TOKEN_ID"

  # Deploy score contract
  info "Deploying score contract..."
  local deploy_output
  deploy_output=$(stellar contract deploy \
    --wasm "$WASM" \
    --source "$DEPLOYER_NAME" \
    --network "$NETWORK" \
    -- \
    --admin "$DEPLOYER_ADDR" \
    --router_id "$RISC0_ROUTER" \
    --image_id "${IMAGE_ID_HEX}" \
    --token_id "$TOKEN_ID" \
    2>&1)
  SCORE_CONTRACT_ID=$(echo "$deploy_output" | grep -oE '^C[A-Z0-9]{55}$' | tail -1)
  ok "Score contract ID: $SCORE_CONTRACT_ID"

  # Transfer token admin to score contract so it can mint
  info "Transferring token mint authority to score contract..."
  stellar contract invoke -q \
    --id "$TOKEN_ID" \
    --source "$DEPLOYER_NAME" \
    --network "$NETWORK" \
    -- \
    set_admin \
    --new_admin "$SCORE_CONTRACT_ID" >/dev/null 2>&1
  ok "Token admin transferred"

  # Player needs a trustline to hold the KALIEN token
  info "Creating KALIEN trustline for player..."
  stellar tx new change-trust \
    --source "$PLAYER_NAME" \
    --line "KALIEN:$DEPLOYER_ADDR" \
    --network "$NETWORK" >/dev/null 2>&1
  ok "Player trustline created"

  save_state

  echo ""
  info "Deployment summary:"
  echo "  Score contract: $SCORE_CONTRACT_ID"
  echo "  Token:          $TOKEN_ID"
  echo "  Router:         $RISC0_ROUTER"
  echo "  Image ID:       $IMAGE_ID_HEX"
  echo "  Deployer:       $DEPLOYER_ADDR"
  echo "  Player:         $PLAYER_ADDR"
  echo ""
  echo "  State saved to: $STATE_FILE"
}

# ---------------------------------------------------------------------------
# Test: Read-only contract queries
# ---------------------------------------------------------------------------
test_read_functions() {
  info "--- Test: read-only contract functions ---"

  local img_result
  img_result=$(stellar contract invoke -q \
    --id "$SCORE_CONTRACT_ID" \
    --source "$DEPLOYER_NAME" \
    --network "$NETWORK" \
    -- \
    image_id 2>&1) || true
  img_result=$(echo "$img_result" | tr -d '"')
  assert_eq "image_id matches fixture" "${IMAGE_ID_HEX}" "$img_result"

  local router_result
  router_result=$(stellar contract invoke -q \
    --id "$SCORE_CONTRACT_ID" \
    --source "$DEPLOYER_NAME" \
    --network "$NETWORK" \
    -- \
    router_id 2>&1) || true
  router_result=$(echo "$router_result" | tr -d '"')
  assert_eq "router_id matches" "$RISC0_ROUTER" "$router_result"

  local token_result
  token_result=$(stellar contract invoke -q \
    --id "$SCORE_CONTRACT_ID" \
    --source "$DEPLOYER_NAME" \
    --network "$NETWORK" \
    -- \
    token_id 2>&1) || true
  token_result=$(echo "$token_result" | tr -d '"')
  assert_eq "token_id matches" "$TOKEN_ID" "$token_result"

  local rules_digest_result
  rules_digest_result=$(stellar contract invoke -q \
    --id "$SCORE_CONTRACT_ID" \
    --source "$DEPLOYER_NAME" \
    --network "$NETWORK" \
    -- \
    rules_digest 2>&1) || true
  assert_eq "rules_digest matches AST4" "$((0x41535434))" "$rules_digest_result"
}

# ---------------------------------------------------------------------------
# Test: Submit a single proof fixture via mock verifier
# ---------------------------------------------------------------------------
test_submit_fixture() {
  local label="$1" fixture_prefix="$2" expected_score="$3"

  info "--- Test: submit $label (expected score: $expected_score) ---"

  local journal_file="$FIXTURES_DIR/${fixture_prefix}.journal_raw"

  if [[ ! -f "$journal_file" ]]; then
    err "fixture file not found: $journal_file"
    TOTAL=$((TOTAL + 1))
    FAILED=$((FAILED + 1))
    return
  fi

  local journal_hex
  journal_hex=$(tr -d '[:space:]' < "$journal_file")
  if ! assert_compact_journal_hex "$journal_hex" "$fixture_prefix"; then
    err "$label fixture is not the expected 49-byte compact journal format"
    TOTAL=$((TOTAL + 1))
    FAILED=$((FAILED + 1))
    return
  fi

  if ! materialize_current_seed "$SCORE_CONTRACT_ID"; then
    err "failed to materialize live seed for $label"
    TOTAL=$((TOTAL + 1))
    FAILED=$((FAILED + 1))
    return
  fi
  info "Materialized live seed $CURRENT_SEED at seed_id $CURRENT_SEED_ID"
  journal_hex=$(set_journal_seed_hex "$journal_hex" "$CURRENT_SEED")

  PLAYER_ADDR=$(stellar keys address "$PLAYER_NAME")

  # Compute journal digest and generate mock seal
  local journal_digest_hex
  journal_digest_hex=$(sha256_of_hex "$journal_hex")

  info "Generating mock seal..."
  local seal_hex
  seal_hex=$(mock_seal "$IMAGE_ID_HEX" "$journal_digest_hex")

  info "Seal: ${#seal_hex} hex chars ($(( ${#seal_hex} / 2 )) bytes)"

  # Submit score (player signs via --source)
  info "Submitting proof..."
  local result
  result=$(stellar contract invoke -q \
    --id "$SCORE_CONTRACT_ID" \
    --source "$PLAYER_NAME" \
    --network "$NETWORK" \
    -- \
    submit_score \
    --seal "$seal_hex" \
    --journal_raw "$journal_hex" \
    2>&1) || {
    err "submit_score failed for $label: $result"
    TOTAL=$((TOTAL + 1))
    FAILED=$((FAILED + 1))
    return
  }

  assert_eq "submit_score returned score" "$expected_score" "$result"

  # Check is_claimed
  local claimed
  claimed=$(stellar contract invoke -q \
    --id "$SCORE_CONTRACT_ID" \
    --source "$DEPLOYER_NAME" \
    --network "$NETWORK" \
    -- \
    is_claimed \
    --journal_digest "${journal_digest_hex}" \
    2>&1) || true
  assert_eq "is_claimed after submit" "true" "$claimed"

  # Test duplicate rejection
  info "Testing duplicate rejection..."
  local dup_result
  dup_result=$(stellar contract invoke -q \
    --id "$SCORE_CONTRACT_ID" \
    --source "$PLAYER_NAME" \
    --network "$NETWORK" \
    -- \
    submit_score \
    --seal "$seal_hex" \
    --journal_raw "$journal_hex" \
    2>&1) && dup_exit=0 || dup_exit=$?
  assert_fail "duplicate $label rejected" "$dup_exit"
}

# ---------------------------------------------------------------------------
# Test: Reject a zero-score fixture via mock verifier
# ---------------------------------------------------------------------------
test_reject_fixture() {
  local label="$1" fixture_prefix="$2"

  info "--- Test: reject $label (score must be > 0) ---"

  local journal_file="$FIXTURES_DIR/${fixture_prefix}.journal_raw"

  if [[ ! -f "$journal_file" ]]; then
    err "fixture file not found: $journal_file"
    TOTAL=$((TOTAL + 1))
    FAILED=$((FAILED + 1))
    return
  fi

  local journal_hex
  journal_hex=$(tr -d '[:space:]' < "$journal_file")
  if ! assert_compact_journal_hex "$journal_hex" "$fixture_prefix"; then
    err "$label fixture is not the expected 49-byte compact journal format"
    TOTAL=$((TOTAL + 1))
    FAILED=$((FAILED + 1))
    return
  fi

  if ! materialize_current_seed "$SCORE_CONTRACT_ID"; then
    err "failed to materialize live seed for rejected fixture $label"
    TOTAL=$((TOTAL + 1))
    FAILED=$((FAILED + 1))
    return
  fi
  info "Materialized live seed $CURRENT_SEED at seed_id $CURRENT_SEED_ID"
  journal_hex=$(set_journal_seed_hex "$journal_hex" "$CURRENT_SEED")

  PLAYER_ADDR=$(stellar keys address "$PLAYER_NAME")

  local journal_digest_hex
  journal_digest_hex=$(sha256_of_hex "$journal_hex")

  info "Generating mock seal..."
  local seal_hex
  seal_hex=$(mock_seal "$IMAGE_ID_HEX" "$journal_digest_hex")

  info "Submitting proof (expect rejection)..."
  local result
  result=$(stellar contract invoke -q \
    --id "$SCORE_CONTRACT_ID" \
    --source "$PLAYER_NAME" \
    --network "$NETWORK" \
    -- \
    submit_score \
    --seal "$seal_hex" \
    --journal_raw "$journal_hex" \
    2>&1) && exit_code=0 || exit_code=$?

  assert_fail "$label rejected" "$exit_code"

  local claimed
  claimed=$(stellar contract invoke -q \
    --id "$SCORE_CONTRACT_ID" \
    --source "$DEPLOYER_NAME" \
    --network "$NETWORK" \
    -- \
    is_claimed \
    --journal_digest "${journal_digest_hex}" \
    2>&1) || true
  assert_eq "is_claimed after rejected $label" "false" "$claimed"
}

# ---------------------------------------------------------------------------
# Test: Reject a synthetic zero-score journal via mock verifier
# ---------------------------------------------------------------------------
test_reject_zero_score() {
  info "--- Test: reject synthetic zero-score journal ---"

  # Build a 49-byte AST4 journal with score=0:
  # seed_id(u32 LE) + seed(u32 LE) + frames + score + claimant(kind=0 + 32-byte payload).
  # seed_id=0 seed=0xdeadbeef frames=100 score=0
  local claimant_hex
  claimant_hex=$(printf '00%064x' 0)
  local journal_hex="00000000efbeadde6400000000000000${claimant_hex}"
  if ! materialize_current_seed "$SCORE_CONTRACT_ID"; then
    err "failed to materialize live seed for zero-score rejection test"
    TOTAL=$((TOTAL + 1))
    FAILED=$((FAILED + 1))
    return
  fi
  info "Materialized live seed $CURRENT_SEED at seed_id $CURRENT_SEED_ID"
  journal_hex=$(set_journal_seed_hex "$journal_hex" "$CURRENT_SEED")
  local journal_digest_hex
  journal_digest_hex=$(sha256_of_hex "$journal_hex")

  info "Generating mock seal..."
  local seal_hex
  seal_hex=$(mock_seal "$IMAGE_ID_HEX" "$journal_digest_hex")

  info "Submitting proof (expect rejection)..."
  local result
  result=$(stellar contract invoke -q \
    --id "$SCORE_CONTRACT_ID" \
    --source "$PLAYER_NAME" \
    --network "$NETWORK" \
    -- \
    submit_score \
    --seal "$seal_hex" \
    --journal_raw "$journal_hex" \
    2>&1) && exit_code=0 || exit_code=$?

  assert_fail "zero-score journal rejected" "$exit_code"
}

# ---------------------------------------------------------------------------
# Test: Check cumulative token balance
# ---------------------------------------------------------------------------
test_cumulative_balance() {
  local expected_total="$1"

  info "--- Test: cumulative token balance ---"

  PLAYER_ADDR=$(stellar keys address "$PLAYER_NAME")

  local balance
  balance=$(stellar contract invoke -q \
    --id "$TOKEN_ID" \
    --source "$DEPLOYER_NAME" \
    --network "$NETWORK" \
    -- \
    balance \
    --id "$PLAYER_ADDR" \
    2>&1) || true
  balance=$(echo "$balance" | tr -d '"')
  assert_eq "cumulative token balance" "$expected_total" "$balance"
}

# ---------------------------------------------------------------------------
# Test: is_claimed returns false for unknown digest
# ---------------------------------------------------------------------------
test_unclaimed_digest() {
  info "--- Test: unclaimed digest returns false ---"

  local fake_digest="0000000000000000000000000000000000000000000000000000000000000001"
  local result
  result=$(stellar contract invoke -q \
    --id "$SCORE_CONTRACT_ID" \
    --source "$DEPLOYER_NAME" \
    --network "$NETWORK" \
    -- \
    is_claimed \
    --journal_digest "$fake_digest" \
    2>&1) || true
  assert_eq "unknown digest not claimed" "false" "$result"
}

# ---------------------------------------------------------------------------
# Groth16: Deploy a second score contract for real proof testing
# ---------------------------------------------------------------------------
deploy_groth16() {
  info "Deploying Groth16 test instance..."

  DEPLOYER_ADDR=$(stellar keys address "$DEPLOYER_NAME")

  # Deploy a separate SAC token so journal digests don't collide with mock tests
  info "Deploying GRF1 token (Groth16 test)..."
  local token_output
  token_output=$(stellar contract asset deploy \
    --asset "GRF1:$DEPLOYER_ADDR" \
    --source "$DEPLOYER_NAME" \
    --network "$NETWORK" 2>&1) || {
    token_output=$(stellar contract id asset \
      --asset "GRF1:$DEPLOYER_ADDR" \
      --network "$NETWORK" 2>&1)
  }
  GRF1_TOKEN_ID=$(echo "$token_output" | grep -oE '^C[A-Z0-9]{55}$' | tail -1)
  ok "GRF1 Token ID: $GRF1_TOKEN_ID"

  # Deploy a second score contract
  info "Deploying Groth16 score contract..."
  local deploy_output
  deploy_output=$(stellar contract deploy \
    --wasm "$WASM" \
    --source "$DEPLOYER_NAME" \
    --network "$NETWORK" \
    -- \
    --admin "$DEPLOYER_ADDR" \
    --router_id "$RISC0_ROUTER" \
    --image_id "${IMAGE_ID_HEX}" \
    --token_id "$GRF1_TOKEN_ID" \
    2>&1)
  GRF1_SCORE_CONTRACT_ID=$(echo "$deploy_output" | grep -oE '^C[A-Z0-9]{55}$' | tail -1)
  ok "Groth16 Score contract ID: $GRF1_SCORE_CONTRACT_ID"

  # Transfer token admin
  info "Transferring GRF1 token admin to score contract..."
  stellar contract invoke -q \
    --id "$GRF1_TOKEN_ID" \
    --source "$DEPLOYER_NAME" \
    --network "$NETWORK" \
    -- \
    set_admin \
    --new_admin "$GRF1_SCORE_CONTRACT_ID" >/dev/null 2>&1
  ok "GRF1 token admin transferred"

  # Player trustline for GRF1
  info "Creating GRF1 trustline for player..."
  stellar tx new change-trust \
    --source "$PLAYER_NAME" \
    --line "GRF1:$DEPLOYER_ADDR" \
    --network "$NETWORK" >/dev/null 2>&1
  ok "Player GRF1 trustline created"

  echo ""
  info "Groth16 deployment summary:"
  echo "  Score contract: $GRF1_SCORE_CONTRACT_ID"
  echo "  Token:          $GRF1_TOKEN_ID"
  echo ""
}

# ---------------------------------------------------------------------------
# Test: Submit a single proof fixture using real Groth16 seal from fixture
# ---------------------------------------------------------------------------
test_submit_groth16_fixture() {
  local label="$1" fixture_prefix="$2" expected_score="$3"

  info "--- Test: verify Groth16 $label (expected score: $expected_score) ---"

  local seal_file="$FIXTURES_DIR/${fixture_prefix}.seal"
  local journal_file="$FIXTURES_DIR/${fixture_prefix}.journal_raw"

  for f in "$seal_file" "$journal_file"; do
    if [[ ! -f "$f" ]]; then
      err "fixture file not found: $f"
      TOTAL=$((TOTAL + 1))
      FAILED=$((FAILED + 1))
      return
    fi
  done

  local seal_hex journal_hex
  seal_hex=$(tr -d '[:space:]' < "$seal_file")
  journal_hex=$(tr -d '[:space:]' < "$journal_file")
  if ! assert_compact_journal_hex "$journal_hex" "$fixture_prefix"; then
    err "Groth16 $label fixture is not the expected 49-byte compact journal format"
    TOTAL=$((TOTAL + 1))
    FAILED=$((FAILED + 1))
    return
  fi

  info "Seal: ${#seal_hex} hex chars ($(( ${#seal_hex} / 2 )) bytes)"

  # Verify proof with real Groth16 seal from fixture.
  info "Verifying Groth16 proof..."
  local result
  result=$(stellar contract invoke -q \
    --id "$GRF1_SCORE_CONTRACT_ID" \
    --source "$DEPLOYER_NAME" \
    --network "$NETWORK" \
    -- \
    verify_score \
    --seal "$seal_hex" \
    --journal_raw "$journal_hex" \
    2>&1) || {
    err "verify_score (Groth16) failed for $label: $result"
    TOTAL=$((TOTAL + 1))
    FAILED=$((FAILED + 1))
    return
  }

  assert_eq "Groth16 verify_score returned score" "$expected_score" "$result"
}

# ---------------------------------------------------------------------------
# Test: Reject a zero-score fixture using real Groth16 seal from fixture
# ---------------------------------------------------------------------------
test_reject_groth16_fixture() {
  local label="$1" fixture_prefix="$2"

  info "--- Test: reject Groth16 $label (score must be > 0) ---"

  local seal_file="$FIXTURES_DIR/${fixture_prefix}.seal"
  local journal_file="$FIXTURES_DIR/${fixture_prefix}.journal_raw"

  for f in "$seal_file" "$journal_file"; do
    if [[ ! -f "$f" ]]; then
      err "fixture file not found: $f"
      TOTAL=$((TOTAL + 1))
      FAILED=$((FAILED + 1))
      return
    fi
  done

  local seal_hex journal_hex
  seal_hex=$(tr -d '[:space:]' < "$seal_file")
  journal_hex=$(tr -d '[:space:]' < "$journal_file")
  if ! assert_compact_journal_hex "$journal_hex" "$fixture_prefix"; then
    err "Groth16 $label fixture is not the expected 49-byte compact journal format"
    TOTAL=$((TOTAL + 1))
    FAILED=$((FAILED + 1))
    return
  fi

  PLAYER_ADDR=$(stellar keys address "$PLAYER_NAME")
  local journal_digest_hex
  journal_digest_hex=$(sha256_of_hex "$journal_hex")

  info "Submitting Groth16 proof (expect rejection)..."
  local result
  result=$(stellar contract invoke -q \
    --id "$GRF1_SCORE_CONTRACT_ID" \
    --source "$PLAYER_NAME" \
    --network "$NETWORK" \
    -- \
    submit_score \
    --seal "$seal_hex" \
    --journal_raw "$journal_hex" \
    2>&1) && exit_code=0 || exit_code=$?

  assert_fail "Groth16 $label rejected" "$exit_code"

  local claimed
  claimed=$(stellar contract invoke -q \
    --id "$GRF1_SCORE_CONTRACT_ID" \
    --source "$DEPLOYER_NAME" \
    --network "$NETWORK" \
    -- \
    is_claimed \
    --journal_digest "${journal_digest_hex}" \
    2>&1) || true
  assert_eq "Groth16 is_claimed after rejected $label" "false" "$claimed"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
echo "================================================"
echo "Asteroids Score Contract — Testnet Integration"
echo "$(date)"
echo "================================================"
echo ""

if [[ "$DEPLOY_MODE" == "fresh" ]]; then
  deploy
else
  load_state "$STATE_FILE"
  read_image_id
  if [[ -z "${SCORE_CONTRACT_ID:-}" || -z "${TOKEN_ID:-}" ]]; then
    err "No deployment state found. Run with --deploy-mode fresh first."
    exit 1
  fi
  info "Reusing deployment from $STATE_FILE"
  echo "  Score contract: $SCORE_CONTRACT_ID"
  echo "  Token:          $TOKEN_ID"
  echo ""
fi

echo ""
info "Running tests..."
echo ""

# 1. Read-only queries
test_read_functions

echo ""

# 2. Check that an unknown digest is not claimed
test_unclaimed_digest

echo ""

# 3. Reject synthetic zero-score journal via mock verifier
test_reject_zero_score
echo ""

# 4. Submit positive-score fixtures via mock verifier
# medium first (score 90, seed 0xDEADBEEF), then short (score 1030, same seed — mints delta 940)
test_submit_fixture "medium tape"    "proof-medium-groth16"    90
echo ""
test_submit_fixture "short tape"     "proof-short-groth16"     1030
echo ""
test_submit_fixture "real game tape" "proof-real-game-groth16" 32860

echo ""

# 5. Check cumulative token balance.
# All mock submissions are rewritten to the same live seed, so minting is:
# 90 + (1030-90) + (32860-1030) = 32860, scaled by 10^7.
test_cumulative_balance "328600000000"

# 6. Groth16 tests (if proof-mode=all)
if [[ "$PROOF_MODE" == "all" ]]; then
  echo ""
  echo "================================================"
  echo "Groth16 Real Proof Tests"
  echo "================================================"
  echo ""

  deploy_groth16

  # medium first (same seed as short, lower score — must come first)
  test_submit_groth16_fixture "medium tape"    "proof-medium-groth16"    90
  echo ""
  test_submit_groth16_fixture "short tape"     "proof-short-groth16"     1030
  echo ""
  test_submit_groth16_fixture "real game tape" "proof-real-game-groth16" 32860

  echo ""

  # Groth16 fixture checks are verify-only because fixture seeds are static and
  # not guaranteed to match the live indexed seed_id.
  info "--- Test: Groth16 verify-only keeps token balance unchanged ---"
  PLAYER_ADDR=$(stellar keys address "$PLAYER_NAME")
  grf1_balance=$(stellar contract invoke -q \
    --id "$GRF1_TOKEN_ID" \
    --source "$DEPLOYER_NAME" \
    --network "$NETWORK" \
    -- \
    balance \
    --id "$PLAYER_ADDR" \
    2>&1) || true
  grf1_balance=$(echo "$grf1_balance" | tr -d '"')
  assert_eq "Groth16 token balance unchanged" "0" "$grf1_balance"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "================================================"
if [[ "$FAILED" -eq 0 ]]; then
  echo -e "\033[1;32mALL $TOTAL TESTS PASSED\033[0m — $(date)"
else
  echo -e "\033[1;31m$FAILED/$TOTAL TESTS FAILED\033[0m — $(date)"
fi
echo "================================================"

exit "$FAILED"
