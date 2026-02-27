import { Hono } from "hono";
import { cache } from "hono/cache";
import {
  DEFAULT_MAX_TAPE_BYTES,
  EXPECTED_RULES_DIGEST,
  EXPECTED_RULESET,
  OPPORTUNISTIC_POLL_STALE_MS,
} from "../constants";
import { fetchBoundlessCycles } from "../boundless/sdk/client";
import { asPublicJob, coordinatorStub } from "../durable/coordinator";
import type { WorkerEnv } from "../env";
import { resultKey } from "../keys";
import { describeProverHealthError, getValidatedProverHealth } from "../prover/client";
import { parseAndValidateTape } from "../tape";
import type { ProofJobRecord, ProverAttempt } from "../types";
import { isTerminalProofStatus, parseInteger, safeErrorMessage } from "../utils";
import { validateClaimantStrKeyFromUserInput } from "../../shared/stellar/strkey";
import {
  HEALTH_CACHE_CONTROL,
  JOB_LIST_CACHE_CONTROL,
  JOB_STATUS_CACHE_CONTROL,
  JOB_STATUS_TERMINAL_CACHE_CONTROL,
  RESULT_CACHE_CONTROL,
  TAPE_CACHE_CONTROL,
} from "../cache-control";
import {
  hasCapacity,
  recordSubmission,
  retryAfterSeconds,
  SUBMISSION_LIMIT,
  SUBMISSION_WINDOW_MS,
} from "./rate-limit";
import {
  ensureCurrentEpochSeed,
  readCurrentEpochSeedState,
  submitRelayProxy,
  type RelayProxyPayload,
} from "../claim/direct";

class PayloadTooLargeError extends Error {
  readonly sizeBytes: number;
  readonly maxBytes: number;

  constructor(sizeBytes: number, maxBytes: number) {
    super(`tape payload too large: ${sizeBytes} bytes (max ${maxBytes})`);
    this.name = "PayloadTooLargeError";
    this.sizeBytes = sizeBytes;
    this.maxBytes = maxBytes;
  }
}

function parseContentLength(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }

  return parsed;
}

async function readRequestBodyWithLimit(
  request: Request,
  maxTapeBytes: number,
): Promise<Uint8Array> {
  const reader = request.body?.getReader();
  if (!reader) {
    return new Uint8Array();
  }

  const chunks: Uint8Array[] = [];
  let totalSize = 0;

  try {
    /* eslint-disable no-await-in-loop */
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      if (!value || value.byteLength === 0) {
        continue;
      }

      totalSize += value.byteLength;
      if (totalSize > maxTapeBytes) {
        void reader.cancel("payload too large");
        throw new PayloadTooLargeError(totalSize, maxTapeBytes);
      }
      chunks.push(value);
    }
    /* eslint-enable no-await-in-loop */
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return body;
}

function jsonError(
  c: { json: (body: unknown, status?: number) => Response },
  status: number,
  error: string,
): Response {
  return c.json(
    {
      success: false,
      error,
    },
    status,
  );
}

function clientIp(c: { req: { raw: Request } }): string {
  return c.req.raw.headers.get("cf-connecting-ip") ?? "unknown";
}

const DEFAULT_BOUNDLESS_CHAIN_ID = "8453"; // Base mainnet
const RELAY_SUBMISSION_LIMIT = 20;
const RELAY_SUBMISSION_WINDOW_MS = 60_000;

function parseRelayPayload(body: unknown): { payload: RelayProxyPayload } | { error: string } {
  if (!body || typeof body !== "object") {
    return { error: "request body must be a JSON object" };
  }

  const source = body as Record<string, unknown>;
  const xdrValue = typeof source.xdr === "string" ? source.xdr.trim() : "";
  const funcValue = typeof source.func === "string" ? source.func.trim() : "";
  const hasXdr = xdrValue.length > 0;
  const hasFunc = funcValue.length > 0;

  if (hasXdr && hasFunc) {
    return { error: "provide either xdr or func/auth payload, not both" };
  }

  if (hasXdr) {
    return {
      payload: {
        kind: "xdr",
        xdr: xdrValue,
      },
    };
  }

  if (hasFunc) {
    const authValue = source.auth;
    if (authValue == null) {
      return {
        payload: {
          kind: "soroban",
          func: funcValue,
          auth: [],
        },
      };
    }
    if (!Array.isArray(authValue)) {
      return { error: "auth must be an array of base64 strings when func is provided" };
    }

    const auth: string[] = [];
    for (let i = 0; i < authValue.length; i += 1) {
      const value = authValue[i];
      if (typeof value !== "string" || value.trim().length === 0) {
        return { error: `auth[${i}] must be a non-empty base64 string` };
      }
      auth.push(value.trim());
    }

    return {
      payload: {
        kind: "soroban",
        func: funcValue,
        auth,
      },
    };
  }

  return { error: "missing payload: provide xdr or func/auth" };
}

function latestSuccessfulAttempt(job: ProofJobRecord): ProverAttempt | null {
  for (let i = job.proverAttempts.length - 1; i >= 0; i -= 1) {
    const attempt = job.proverAttempts[i];
    if (attempt.outcome === "success") return attempt;
  }
  return null;
}

function normalizeBoundlessRequestId(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = trimmed.startsWith("boundless:")
    ? trimmed.slice("boundless:".length)
    : trimmed;
  if (!/^0x[0-9a-f]+$/i.test(normalized)) return null;
  return normalized;
}

function resolveBoundlessChainId(env: WorkerEnv): string {
  const raw = env.BOUNDLESS_CHAIN_ID?.trim();
  if (!raw) return DEFAULT_BOUNDLESS_CHAIN_ID;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_BOUNDLESS_CHAIN_ID;
  return String(parsed);
}

async function enrichBoundlessCyclesForResponse(
  env: WorkerEnv,
  job: ProofJobRecord,
): Promise<ProofJobRecord> {
  if (job.status !== "succeeded") return job;
  if (!job.proverAttempts || job.proverAttempts.length === 0) return job;

  const attempt = latestSuccessfulAttempt(job);
  if (!attempt || attempt.totalCycles != null) return job;

  const isBoundlessAttempt =
    attempt.backend === "boundless" ||
    attempt.statusUrl?.startsWith("boundless:") === true ||
    job.prover.statusUrl?.startsWith("boundless:") === true;
  if (!isBoundlessAttempt) return job;

  const requestId =
    normalizeBoundlessRequestId(attempt.proverJobId) ??
    normalizeBoundlessRequestId(attempt.statusUrl) ??
    normalizeBoundlessRequestId(job.prover.jobId) ??
    normalizeBoundlessRequestId(job.prover.statusUrl);
  if (!requestId) return job;

  try {
    const chainId = resolveBoundlessChainId(env);
    const { programCycles, totalCycles } = await fetchBoundlessCycles(chainId, requestId);
    if (totalCycles == null) return job;

    const successfulIndex = job.proverAttempts.findIndex(
      (candidate) => candidate.index === attempt.index && candidate.outcome === "success",
    );
    if (successfulIndex < 0) return job;

    const updatedAttempts = [...job.proverAttempts];
    updatedAttempts[successfulIndex] = {
      ...updatedAttempts[successfulIndex],
      programCycles,
      totalCycles,
    };
    return {
      ...job,
      proverAttempts: updatedAttempts,
    };
  } catch {
    return job;
  }
}

export function createApiRouter(): Hono<{ Bindings: WorkerEnv }> {
  const api = new Hono<{ Bindings: WorkerEnv }>();

  api.get("/health", async (c) => {
    const coordinator = coordinatorStub(c.env);
    const activeJob = await coordinator.getActiveJob();
    const expectedImageIdRaw = c.env.PROVER_EXPECTED_IMAGE_ID?.trim() ?? "";
    const expectedImageId = expectedImageIdRaw.length > 0 ? expectedImageIdRaw : null;

    let prover:
      | {
          status: "compatible";
          image_id: string;
          rules_digest_hex: string;
          ruleset: string;
        }
      | {
          status: "degraded";
          error: string;
        };

    try {
      const health = await getValidatedProverHealth(c.env);
      prover = {
        status: "compatible",
        image_id: health.imageId,
        rules_digest_hex: health.rulesDigestHex,
        ruleset: health.ruleset,
      };
    } catch (error) {
      const healthError = describeProverHealthError(error);
      prover = {
        status: "degraded",
        error: healthError.message,
      };
    }

    c.header("Cache-Control", HEALTH_CACHE_CONTROL);
    return c.json({
      success: true,
      service: "kalien-proof-gateway",
      mode: "single-active-job",
      expected: {
        rules_digest_hex: `0x${(EXPECTED_RULES_DIGEST >>> 0).toString(16).padStart(8, "0")}`,
        ruleset: EXPECTED_RULESET,
        image_id: expectedImageId,
      },
      checked_at: new Date().toISOString(),
      prover,
      active_jobs: activeJob ? 1 : 0,
      active_job_id: activeJob?.jobId ?? null,
    });
  });

  api.get("/seed/current", async (c) => {
    let state: Awaited<ReturnType<typeof readCurrentEpochSeedState>>;
    try {
      state = await readCurrentEpochSeedState(c.env);
    } catch (error) {
      return jsonError(c, 503, safeErrorMessage(error));
    }

    return c.json({
      success: true,
      seed_id: state.seedId,
      seconds_left: state.secondsLeft,
      seed: state.seed,
      indexed: state.seed !== null,
    });
  });

  api.post("/seed/refresh", async (c) => {
    // ensureCurrentEpochSeed already checks if the seed exists
    // and has its own cooldown logic — no need to pre-check here.
    let result;
    try {
      result = await ensureCurrentEpochSeed(c.env);
    } catch (error) {
      return jsonError(c, 503, safeErrorMessage(error));
    }

    if (!result.success) {
      if (result.retryAfterSeconds && result.retryAfterSeconds > 0) {
        c.header("Retry-After", String(result.retryAfterSeconds));
      }
      return c.json(
        {
          success: false,
          error: result.message ?? "unable to create current epoch seed",
          seed_id: result.state.seedId,
          seconds_left: result.state.secondsLeft,
          seed: result.state.seed,
          indexed: result.state.seed !== null,
          refresh_attempted: result.refreshAttempted,
          refreshed: result.refreshed,
          tx_hash_current_seed: result.txHashCurrentSeed,
          retry_after_seconds: result.retryAfterSeconds ?? null,
        },
        result.retryAfterSeconds ? 429 : 503,
      );
    }

    return c.json({
      success: true,
      seed_id: result.state.seedId,
      seconds_left: result.state.secondsLeft,
      seed: result.state.seed,
      indexed: result.state.seed !== null,
      refresh_attempted: result.refreshAttempted,
      refreshed: result.refreshed,
      message: result.message,
      tx_hash_current_seed: result.txHashCurrentSeed,
    });
  });

  api.post("/relay", async (c) => {
    const ipKey = `relay:${clientIp(c)}`;
    if (!hasCapacity(ipKey, RELAY_SUBMISSION_LIMIT, RELAY_SUBMISSION_WINDOW_MS)) {
      const retryAfter = retryAfterSeconds(ipKey, RELAY_SUBMISSION_LIMIT, RELAY_SUBMISSION_WINDOW_MS);
      c.header("Retry-After", String(Math.max(1, retryAfter)));
      return jsonError(c, 429, "too many relay submissions; try again later");
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch (error) {
      return jsonError(c, 400, `invalid JSON body: ${safeErrorMessage(error)}`);
    }

    const parsed = parseRelayPayload(body);
    if ("error" in parsed) {
      return jsonError(c, 400, parsed.error);
    }

    recordSubmission(ipKey, RELAY_SUBMISSION_WINDOW_MS);

    const relay = await submitRelayProxy(c.env, parsed.payload);
    if (relay.type === "success") {
      return c.json({
        success: true,
        data: {
          hash: relay.txHash,
          status: "submitted",
        },
      });
    }

    return c.json(
      {
        success: false,
        error: relay.message,
        data: relay.errorDetail ? { detail: relay.errorDetail } : undefined,
      },
      relay.type === "retry" ? 503 : 400,
    );
  });

  api.post("/proofs/jobs", async (c) => {
    const maxTapeBytes = parseInteger(c.env.MAX_TAPE_BYTES, DEFAULT_MAX_TAPE_BYTES, 1);
    const declaredLength = parseContentLength(c.req.header("content-length"));
    if (declaredLength !== null && declaredLength > maxTapeBytes) {
      return jsonError(
        c,
        413,
        `tape payload too large: ${declaredLength} bytes (max ${maxTapeBytes})`,
      );
    }

    let tapeBytes: Uint8Array;
    try {
      tapeBytes = await readRequestBodyWithLimit(c.req.raw, maxTapeBytes);
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        return jsonError(c, 413, error.message);
      }
      return jsonError(c, 400, `failed reading request body: ${safeErrorMessage(error)}`);
    }

    let metadata;
    try {
      metadata = parseAndValidateTape(tapeBytes, maxTapeBytes);
    } catch (error) {
      return jsonError(c, 400, safeErrorMessage(error));
    }

    const rawClaimant = c.req.query("claimant") ?? "";
    let claimantAddress: string;
    try {
      claimantAddress = validateClaimantStrKeyFromUserInput(rawClaimant);
    } catch (error) {
      return jsonError(c, 400, `invalid claimant query param: ${safeErrorMessage(error)}`);
    }

    const rawSeedId = c.req.query("seed_id") ?? "";
    const parsedSeedId = Number.parseInt(rawSeedId.trim(), 10);
    if (!Number.isFinite(parsedSeedId) || parsedSeedId < 0 || parsedSeedId > 0xffff_ffff) {
      return jsonError(c, 400, "invalid seed_id query param: expected unsigned 32-bit integer");
    }
    metadata = {
      ...metadata,
      seedId: parsedSeedId >>> 0,
    };

    // Sliding-window rate limit: 10 submissions per 10 minutes, per IP and per address.
    const ipKey = `ip:${clientIp(c)}`;
    const addrKey = `addr:${claimantAddress}`;
    if (
      !hasCapacity(ipKey, SUBMISSION_LIMIT, SUBMISSION_WINDOW_MS) ||
      !hasCapacity(addrKey, SUBMISSION_LIMIT, SUBMISSION_WINDOW_MS)
    ) {
      const retryIp = retryAfterSeconds(ipKey, SUBMISSION_LIMIT, SUBMISSION_WINDOW_MS);
      const retryAddr = retryAfterSeconds(addrKey, SUBMISSION_LIMIT, SUBMISSION_WINDOW_MS);
      const retryAfter = Math.max(retryIp, retryAddr, 1);
      c.header("Retry-After", String(retryAfter));
      return jsonError(c, 429, "too many proof submissions; try again later");
    }
    recordSubmission(ipKey, SUBMISSION_WINDOW_MS);
    recordSubmission(addrKey, SUBMISSION_WINDOW_MS);

    const coordinator = coordinatorStub(c.env);
    const createResult = await coordinator.createJob({
      sizeBytes: tapeBytes.byteLength,
      metadata,
      claimantAddress,
    });

    const { job } = createResult;

    try {
      await c.env.PROOF_ARTIFACTS.put(job.tape.key, tapeBytes, {
        httpMetadata: {
          contentType: "application/octet-stream",
        },
        customMetadata: {
          jobId: job.jobId,
        },
      });
    } catch (error) {
      await coordinator.markFailed(
        job.jobId,
        `failed storing tape in R2: ${safeErrorMessage(error)}`,
      );
      return jsonError(c, 503, "failed storing tape artifact");
    }

    try {
      await c.env.PROOF_QUEUE.send(
        {
          jobId: job.jobId,
        },
        {
          contentType: "json",
        },
      );
    } catch (error) {
      await coordinator.markFailed(
        job.jobId,
        `failed enqueueing proof job: ${safeErrorMessage(error)}`,
      );
      await c.env.PROOF_ARTIFACTS.delete(job.tape.key);
      return jsonError(c, 503, "failed enqueueing proof job");
    }

    const refreshed = await coordinator.getJob(job.jobId);
    if (!refreshed) {
      return jsonError(c, 500, "job disappeared after enqueue");
    }

    return c.json(
      {
        success: true,
        status_url: `/api/proofs/jobs/${job.jobId}`,
        job: asPublicJob(refreshed),
      },
      202,
    );
  });

  api.get("/proofs/jobs", async (c) => {
    const rawAddress = c.req.query("address") ?? "";
    if (!rawAddress.trim()) {
      return jsonError(c, 400, "address query param required");
    }

    let claimantAddress: string;
    try {
      claimantAddress = validateClaimantStrKeyFromUserInput(rawAddress);
    } catch (error) {
      return jsonError(c, 400, `invalid address: ${safeErrorMessage(error)}`);
    }

    const limitRaw = Number.parseInt(c.req.query("limit") ?? "25", 10);
    const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 25, 1), 100);
    const offsetRaw = Number.parseInt(c.req.query("offset") ?? "0", 10);
    const offset = Math.max(Number.isFinite(offsetRaw) ? offsetRaw : 0, 0);

    const coordinator = coordinatorStub(c.env);
    const { jobs, total } = await coordinator.listJobsForClaimant(claimantAddress, limit, offset);

    const jobsWithCycleBackfill = await Promise.all(
      jobs.map(async (job) => {
        if (job.status !== "succeeded") {
          return job;
        }

        const successfulAttempt = latestSuccessfulAttempt(job);
        if (!successfulAttempt || successfulAttempt.totalCycles != null) {
          return job;
        }

        const isBoundlessAttempt =
          successfulAttempt.backend === "boundless" ||
          successfulAttempt.statusUrl?.startsWith("boundless:") === true ||
          job.prover.statusUrl?.startsWith("boundless:") === true;
        if (!isBoundlessAttempt) {
          return job;
        }

        try {
          const persisted = (await coordinator.enrichBoundlessCycles(
            job.jobId,
          )) as ProofJobRecord | null;
          return enrichBoundlessCyclesForResponse(c.env, persisted ?? job);
        } catch {
          // Best-effort only; never fail list reads because of enrichment.
          return enrichBoundlessCyclesForResponse(c.env, job);
        }
      }),
    );

    const nextOffset = offset + jobs.length < total ? offset + limit : null;

    c.header("Cache-Control", JOB_LIST_CACHE_CONTROL);
    return c.json({
      success: true,
      jobs: jobsWithCycleBackfill.map(asPublicJob),
      total,
      offset,
      limit,
      next_offset: nextOffset,
    });
  });

  api.get(
    "/proofs/jobs/:jobId/tape",
    cache({
      cacheName: "kalien-tape-v1",
      cacheControl: TAPE_CACHE_CONTROL,
    }),
    async (c) => {
      const jobId = c.req.param("jobId");
      if (!jobId) {
        return jsonError(c, 400, "invalid job id in path");
      }

      const coordinator = coordinatorStub(c.env);
      const job = await coordinator.getJob(jobId);
      if (!job) {
        return jsonError(c, 404, `job not found: ${jobId}`);
      }

      const tape = await c.env.PROOF_ARTIFACTS.get(job.tape.key);
      if (!tape) {
        return jsonError(c, 404, "tape not found");
      }

      return new Response(tape.body, {
        status: 200,
        headers: {
          "content-type": "application/octet-stream",
          "content-disposition": `attachment; filename="${jobId}.tape"`,
          "cache-control": TAPE_CACHE_CONTROL,
        },
      });
    },
  );

  api.get("/proofs/jobs/:jobId", async (c) => {
    const jobId = c.req.param("jobId");
    if (!jobId) {
      return jsonError(c, 400, "invalid job id in path");
    }

    const coordinator = coordinatorStub(c.env);
    let job = (await coordinator.getJob(jobId)) as ProofJobRecord | null;
    if (!job) {
      return jsonError(c, 404, `job not found: ${jobId}`);
    }

    // Opportunistic: if the DO alarm hasn't polled recently (unreliable in local
    // dev), do a single-shot prover check so the frontend sees progress.
    // DOs are single-threaded so this is safe from races in prod.
    if (
      !isTerminalProofStatus(job.status) &&
      job.prover.jobId &&
      (!job.prover.lastPolledAt ||
        Date.now() - new Date(job.prover.lastPolledAt).getTime() > OPPORTUNISTIC_POLL_STALE_MS)
    ) {
      try {
        await coordinator.kickAlarm();
        job = (await coordinator.getJob(jobId)) ?? job;
      } catch {
        // Best-effort — don't fail the read if kicking the alarm errors.
      }
    }

    // Lazy backfill: if this is a succeeded Boundless job missing cycle data,
    // re-check the indexer (Bento populates cycles asynchronously).
    if (job.status === "succeeded") {
      try {
        const enriched = (await coordinator.enrichBoundlessCycles(jobId)) as ProofJobRecord | null;
        if (enriched) {
          job = enriched;
        }
      } catch {
        // Best-effort — don't fail the read if enrichment errors.
      }
      job = await enrichBoundlessCyclesForResponse(c.env, job);
    }

    // Terminal jobs never change — cache longer. In-progress jobs need fresh data.
    c.header(
      "Cache-Control",
      isTerminalProofStatus(job.status)
        ? JOB_STATUS_TERMINAL_CACHE_CONTROL
        : JOB_STATUS_CACHE_CONTROL,
    );

    return c.json({
      success: true,
      job: asPublicJob(job),
    });
  });

  api.delete("/proofs/jobs/:jobId", async (c) => {
    const jobId = c.req.param("jobId");
    if (!jobId) {
      return jsonError(c, 400, "invalid job id in path");
    }

    const coordinator = coordinatorStub(c.env);
    try {
      const failed = await coordinator.markFailed(jobId, "cancelled by api request");
      if (!failed) {
        return jsonError(c, 404, `job not found: ${jobId}`);
      }
      return c.json({
        success: true,
        job: asPublicJob(failed),
      });
    } catch (error) {
      return jsonError(c, 409, safeErrorMessage(error));
    }
  });

  api.post("/proofs/jobs/:jobId/retry-claim", async (c) => {
    const jobId = c.req.param("jobId");
    if (!jobId) {
      return jsonError(c, 400, "invalid job id in path");
    }

    const coordinator = coordinatorStub(c.env);
    try {
      const job = await coordinator.retryFailedClaim(jobId);
      if (!job) {
        return jsonError(c, 404, `job not found: ${jobId}`);
      }
      return c.json({ success: true, job: asPublicJob(job) });
    } catch (error) {
      return jsonError(c, 409, safeErrorMessage(error));
    }
  });

  api.get(
    "/proofs/jobs/:jobId/result",
    cache({
      cacheName: "kalien-result-v1",
      cacheControl: RESULT_CACHE_CONTROL,
    }),
    async (c) => {
      const jobId = c.req.param("jobId");
      if (!jobId) {
        return jsonError(c, 400, "invalid job id in path");
      }

      // Try the DO first for the canonical artifact key.
      const coordinator = coordinatorStub(c.env);
      const job = await coordinator.getJob(jobId);

      let artifact: R2ObjectBody | null = null;

      if (job?.result?.artifactKey) {
        artifact = await c.env.PROOF_ARTIFACTS.get(job.result.artifactKey);
      } else if (!job) {
        // DO record was pruned — fall back to the well-known R2 key.
        // result.json is retained in R2 beyond DO pruning so users can
        // fetch proof data for on-chain submission.
        artifact = await c.env.PROOF_ARTIFACTS.get(resultKey(jobId));
      }

      if (!artifact) {
        if (job && !job.result?.artifactKey) {
          return jsonError(c, 409, "proof result is not available for this job");
        }
        return jsonError(c, 404, "proof result not found");
      }

      return new Response(artifact.body, {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": RESULT_CACHE_CONTROL,
        },
      });
    },
  );

  api.notFound((c) => {
    return jsonError(c, 404, `unknown api route: ${c.req.path}`);
  });

  return api;
}
