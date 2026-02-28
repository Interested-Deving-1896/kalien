# Kalien Verifier

`kalien-verifier/` hosts the RISC Zero proving service for deterministic Asteroids
replays.

## Architecture

- Cloudflare Worker queues proof jobs.
- `api-server` accepts tapes and runs single-flight proving.
- `host` runs local CLI proving and benchmarks.
- `methods/guest` is the zkVM guest that replays the tape.
- `asteroids-core` is the deterministic engine shared across verifier components.

## Workspace Layout

| Path | Purpose |
|---|---|
| `asteroids-core/` | deterministic replay core (`no_std`) |
| `methods/guest/` | RISC Zero guest program |
| `host/` | local proving CLI + benchmark binary |
| `api-server/` | HTTP proving service |
| `deploy/` | supervisord configs and reset helpers |

## Local Build and Run

From `kalien-verifier/`:

```bash
cargo build --locked --release -p api-server
API_KEY='replace-with-strong-secret' cargo run --release -p api-server
```

CUDA build/run:

```bash
cargo build --locked --release -p api-server --features cuda
API_KEY='replace-with-strong-secret' cargo run --release -p api-server --features cuda
```

Health check:

```bash
curl -s http://127.0.0.1:8080/health | jq
```

API contract, endpoint details, and env vars are canonical in
[kalien-verifier/api-server/README.md](api-server/README.md).

## Vast.ai Provisioning

Run the setup script on the instance:

```bash
curl -sSf https://raw.githubusercontent.com/kalepail/kalien/main/kalien-verifier/VASTAI | bash
```

Then build and run `api-server` as above.

## Production Process Supervision

On the prover host:

```bash
mkdir -p /etc/kalien /var/lib/kalien/prover
cp deploy/supervisord/kalien-api.conf /etc/supervisor/conf.d/
cp api-server/.env.example /etc/kalien/api-server.env
supervisorctl reread && supervisorctl update
supervisorctl status
```

If state is wedged, reset with:

```bash
sudo bash deploy/reset-prover-state.sh --yes
```

## Cloudflare Tunnel (Named Tunnel Token)

`deploy/supervisord/cloudflared.conf` expects `CLOUDFLARE_TUNNEL_TOKEN` in
`/etc/kalien/api-server.env`.

```bash
cp deploy/supervisord/cloudflared.conf /etc/supervisor/conf.d/
# edit /etc/kalien/api-server.env and set CLOUDFLARE_TUNNEL_TOKEN=...
supervisorctl reread && supervisorctl update
supervisorctl status
```

## Local Host CLI Proving

From `kalien-verifier/`:

```bash
RISC0_DEV_MODE=1 cargo run -p host --release -- \
  --tape ../test-fixtures/test-medium.tape \
  --claimant GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF \
  --seed-id 0 \
  --proof-mode dev \
  --verify-mode policy
```

Secure proving (non-dev receipts):

```bash
RISC0_DEV_MODE=0 cargo run -p host --release -- \
  --tape ../test-fixtures/test-medium.tape \
  --claimant GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF \
  --seed-id 0
```

## Benchmark and Smoke Scripts

From repo root:

```bash
bash scripts/smoke-test-prover.sh --url https://your-prover.example.com
bash scripts/bench-segment-sweep.sh https://your-prover.example.com --receipts composite,succinct
bash scripts/bench-core-cycles.sh --threshold-mode check
```
