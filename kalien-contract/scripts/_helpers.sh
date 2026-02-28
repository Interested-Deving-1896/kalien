# _helpers.sh — Shared helper library for kalien-contract scripts.
# Source this file — do not execute directly.
#
# Provides:
#   - Logging:     info, ok, err, warn
#   - Paths:       SCRIPT_DIR, CONTRACT_DIR, ROOT_DIR, FIXTURES_DIR, WASM
#   - Constants:   RISC0_VERIFIER, RISC0_MOCK, NETWORK, HORIZON_URL
#   - Crypto:      sha256_of_hex
#   - Keys:        ensure_funded_key
#   - Env/state:   load_env_chain, load_state, save_state_vars
#   - Fixtures:    read_image_id
#   - Mock prover: mock_seal
#
# Callers must set SCRIPT_DIR before sourcing (for path resolution):
#   SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
#   source "$SCRIPT_DIR/_helpers.sh"

# ---------------------------------------------------------------------------
# Paths (derived from caller's SCRIPT_DIR)
# ---------------------------------------------------------------------------
CONTRACT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT_DIR="$(cd "$CONTRACT_DIR/.." && pwd)"
FIXTURES_DIR="$ROOT_DIR/test-fixtures"
WASM="$CONTRACT_DIR/target/wasm32v1-none/release/asteroids_score.wasm"
CONTRACT_ENV_FILE="$CONTRACT_DIR/.env"

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
RISC0_VERIFIER="CCYKHXM3LO5CC6X26GFOLZGPXWI3P2LWXY3EGG7JTTM5BQ3ISETDQ3DD"
RISC0_MOCK="CCKXGODVBNCGZZIKTU2DIPTXPVSLIG5Z67VYPAL4X5HVSED7VI4OD6A3"
NETWORK="${NETWORK:-testnet}"
HORIZON_URL="https://horizon-testnet.stellar.org"

# CPU instruction limit per Stellar transaction
CPU_LIMIT=100000000

# ---------------------------------------------------------------------------
# Env loading
# ---------------------------------------------------------------------------

# Load env vars in the same precedence order used by top-level scripts:
#   root/.env -> root/.dev.vars -> kalien-contract/.env
# Later files override earlier files.
load_env_chain() {
  local env_file
  for env_file in "$ROOT_DIR/.env" "$ROOT_DIR/.dev.vars" "$CONTRACT_ENV_FILE"; do
    if [[ -f "$env_file" ]]; then
      # shellcheck disable=SC1090
      set -a
      source "$env_file"
      set +a
    fi
  done
}

load_env_chain

# .dev.vars may export STELLAR_RPC_URL (for the Cloudflare Worker) without a
# matching passphrase, which confuses the Stellar CLI.  Clear it so the CLI
# falls back to the --network preset.
unset STELLAR_RPC_URL 2>/dev/null || true

# ---------------------------------------------------------------------------
# Logging — all output goes to stderr so callers can capture stdout for data
# ---------------------------------------------------------------------------
info()  { echo -e "\033[1;34m==>\033[0m $*" >&2; }
ok()    { echo -e "\033[1;32m OK\033[0m $*" >&2; }
err()   { echo -e "\033[1;31mERR\033[0m $*" >&2; }
warn()  { echo -e "\033[1;33mWRN\033[0m $*" >&2; }

# ---------------------------------------------------------------------------
# Prerequisite check
# ---------------------------------------------------------------------------
require_cmds() {
  local missing=0
  for cmd in "$@"; do
    if ! command -v "$cmd" &>/dev/null; then
      err "Missing required command: $cmd"
      missing=1
    fi
  done
  if [[ "$missing" -eq 1 ]]; then
    exit 1
  fi
}

# ---------------------------------------------------------------------------
# Crypto
# ---------------------------------------------------------------------------

# Compute SHA-256 of raw bytes from hex string
sha256_of_hex() {
  echo -n "$1" | xxd -r -p | shasum -a 256 | cut -d' ' -f1
}

# Validate AST4 journal raw hex length for the compact layout.
# Layout: seed_id(u32 LE) + seed(u32 LE) + frame_count(u32 LE) + final_score(u32 LE)
#         + claimant(kind + 32-byte id) = 49 bytes (98 hex chars).
assert_compact_journal_hex() {
  local journal_hex="${1:-}"
  local context="${2:-journal}"
  local expected_hex_len=98

  if [[ ${#journal_hex} -ne $expected_hex_len ]]; then
    err "$context: journal length mismatch (${#journal_hex} hex chars, expected ${expected_hex_len})"
    return 1
  fi
}

# ---------------------------------------------------------------------------
# Stellar key management
# ---------------------------------------------------------------------------

# Ensure a named key exists and is funded on the configured network.
# Args: $1 = key name
ensure_funded_key() {
  local key_name="$1"
  if ! stellar keys address "$key_name" &>/dev/null; then
    info "Generating key: $key_name"
    stellar keys generate "$key_name" --network "$NETWORK" --fund
    ok "Funded key: $key_name"
  else
    info "Using existing key: $key_name"
  fi
}

# ---------------------------------------------------------------------------
# Fixture helpers
# ---------------------------------------------------------------------------

# Read image_id from first available fixture (all fixtures share the same id)
# Sets global: IMAGE_ID_HEX
read_image_id() {
  local id_file="$FIXTURES_DIR/proof-medium-groth16.image_id"
  if [[ ! -f "$id_file" ]]; then
    err "Image ID fixture not found: $id_file"
    err "Run: bun run scripts/generate-proof.ts first"
    exit 1
  fi
  IMAGE_ID_HEX=$(tr -d '[:space:]' < "$id_file")
}

# ---------------------------------------------------------------------------
# State file persistence
# ---------------------------------------------------------------------------

# Load state from a file into current shell.
# Args: $1 = state file path
load_state() {
  local state_file="$1"
  if [[ -f "$state_file" ]]; then
    # shellcheck disable=SC1090
    source "$state_file"
  fi
}

# Upsert KEY=VALUE into an env file while preserving other lines.
# Args: $1 = env file path, $2 = key, $3 = value
upsert_env_var() {
  local env_file="$1"
  local key="$2"
  local value="${3:-}"
  local tmp_file
  tmp_file="$(mktemp "${TMPDIR:-/tmp}/kalien-env.XXXXXX")"

  if [[ -f "$env_file" ]]; then
    awk -v key="$key" -v value="$value" '
      BEGIN { updated = 0 }
      index($0, key "=") == 1 {
        if (updated == 0) {
          print key "=" value
          updated = 1
        }
        next
      }
      { print }
      END {
        if (updated == 0) {
          print key "=" value
        }
      }
    ' "$env_file" > "$tmp_file"
  else
    printf "%s=%s\n" "$key" "$value" > "$tmp_file"
  fi

  mv "$tmp_file" "$env_file"
}

# Save one or more key/value pairs into an env file.
# Args: $1 = env file path, then repeated: <key> <value>
save_state_vars() {
  local env_file="$1"
  shift
  while [[ $# -gt 1 ]]; do
    upsert_env_var "$env_file" "$1" "$2"
    shift 2
  done
}

# ---------------------------------------------------------------------------
# Mock prover
# ---------------------------------------------------------------------------

# Generate a mock seal via the testnet mock verifier contract.
# Args: $1 = image_id_hex, $2 = journal_digest_hex
# Requires: DEPLOYER_NAME, RISC0_MOCK, NETWORK
mock_seal() {
  local img_id="$1" jd="$2"
  local result
  result=$(stellar contract invoke -q \
    --id "$RISC0_MOCK" \
    --source "$DEPLOYER_NAME" \
    --network "$NETWORK" \
    -- \
    mock_prove \
    --image_id "$img_id" \
    --journal_digest "$jd" 2>&1)
  echo "$result" | python3 -c "import sys,json; print(json.load(sys.stdin)['seal'])"
}

# ---------------------------------------------------------------------------
# Formatting
# ---------------------------------------------------------------------------

# Format a number with thousand-separators (locale-dependent)
fmt_num() {
  printf "%'d" "$1" 2>/dev/null || printf "%d" "$1"
}

# Convert stroops (integer) to XLM string with 6 decimal places
stroops_to_xlm() {
  awk "BEGIN { printf \"%.6f\", ${1:-0} / 10000000 }"
}
