# RISC0 Asteroids Proof API

HTTP server for generating Asteroids replay proofs from raw `.tape` bytes.

## Service Model

- Single-flight proving (`concurrency = 1`).
- Async job API with polling.
- Optional API key auth on `/api/*`.

## Endpoints

- `GET /health`
- `POST /api/jobs/prove-tape/raw`
- `GET /api/jobs/{job_id}`
- `DELETE /api/jobs/{job_id}`

## Auth

If `API_KEY` is set, `/api/*` requires either:

- `x-api-key: <API_KEY>`
- `Authorization: Bearer <API_KEY>`

`/health` is always open.

## Submit a Job

```bash
JOB_ID=$(curl -sS \
  -X POST 'http://127.0.0.1:8080/api/jobs/prove-tape/raw?receipt_kind=groth16&segment_limit_po2=21&verify_mode=policy&seed_id=0&claimant=GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF' \
  --data-binary @../test-fixtures/test-medium.tape \
  -H 'content-type: application/octet-stream' \
  -H 'x-api-key: YOUR_API_KEY' | jq -r '.job_id')
```

Poll:

```bash
curl -sS -H 'x-api-key: YOUR_API_KEY' "http://127.0.0.1:8080/api/jobs/${JOB_ID}" | jq
```

`POST /api/jobs/prove-tape/raw` rejects zero-score tapes with:
- status: `400`
- `error_code: "zero_score_not_allowed"`

## Key Environment Variables

See `.env.example` for the full list.

- `API_BIND_ADDR`: listen address (default `0.0.0.0:8080`)
- `API_KEY`: optional shared secret for `/api/*`
- `RISC0_DEV_MODE`: `1` for local dev receipts, `0` for secure proving
- `DATA_DIR`: persistent job DB/log root (`./data` if unset)
- `MAX_TAPE_BYTES`, `MAX_JOBS`, `JOB_TTL_SECS`, `JOB_SWEEP_SECS`
- `MAX_FRAMES`, `MIN_SEGMENT_LIMIT_PO2`, `MAX_SEGMENT_LIMIT_PO2`
- `RUNNING_JOB_TIMEOUT_SECS`, `TIMED_OUT_PROOF_KILL_SECS`
- `HTTP_MAX_CONNECTIONS`, `HTTP_KEEP_ALIVE_SECS`, `HTTP_WORKERS`
- `CORS_ALLOWED_ORIGIN` (optional)
- `CLOUDFLARE_TUNNEL_TOKEN` (used by supervisord tunnel config)

## Security Defaults

- Keep `RISC0_DEV_MODE=0` in production.
- Keep `verify_mode=policy` unless you explicitly need prover-side verification.
- Run under a supervisor (supervisord/systemd/container restart policy) to recover
  from intentional abort-on-timeout behavior.

For host-level deployment/runbook details, see [../README.md](../README.md).
