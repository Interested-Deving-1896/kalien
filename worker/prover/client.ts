import {
  DEFAULT_PROVER_HEALTH_CACHE_MS,
  DEFAULT_PROVER_REQUEST_TIMEOUT_MS,
  DEFAULT_SEGMENT_LIMIT_PO2,
  EXPECTED_RULES_DIGEST,
  EXPECTED_RULESET,
  RETRYABLE_JOB_ERROR_CODES,
} from "../constants";
import type { WorkerEnv } from "../env";
import type {
  ProverCreateJobResponse,
  ProverErrorResponse,
  ProverGetJobResponse,
  ProverHealthResponse,
  ProverPollResult,
  ProverSubmitResult,
  ProofResultSummary,
} from "../types";
import { buildProofArtifactV4FromProverResponse } from "../proof-artifact";
import { isLocalHostname, parseBoolean, parseInteger, safeErrorMessage } from "../utils";
import { parseClaimantStrKeyFromUserInput } from "../../shared/stellar/strkey";

export interface ValidatedProverHealth {
  imageId: string;
  rulesDigest: number;
  rulesDigestHex: string;
  ruleset: string;
}

class ProverHealthCheckError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "ProverHealthCheckError";
    this.retryable = retryable;
  }
}

let proverHealthCache: {
  cacheKey: string;
  fetchedAtMs: number;
  value: ValidatedProverHealth;
} | null = null;

function normalizeHex32Bytes(raw: string): string | null {
  const normalized = raw.trim().toLowerCase().replace(/^0x/, "");
  return /^[0-9a-f]{64}$/.test(normalized) ? normalized : null;
}

function buildProverUrl(env: WorkerEnv, pathname: string): URL {
  const base = env.PROVER_BASE_URL?.trim();
  if (!base) {
    throw new Error("missing PROVER_BASE_URL");
  }

  const url = new URL(pathname, base);
  if (
    url.protocol !== "https:" &&
    !parseBoolean(env.ALLOW_INSECURE_PROVER_URL, false) &&
    !isLocalHostname(url.hostname)
  ) {
    throw new Error("PROVER_BASE_URL must use https in production");
  }

  return url;
}

interface ProverCreateOptions {
  segmentLimitPo2?: number;
  seedId: number;
  claimantAddress: string;
}

function buildProverCreateUrlWithOptions(env: WorkerEnv, options: ProverCreateOptions): URL {
  const url = buildProverUrl(env, "/api/jobs/prove-tape/raw");

  const segmentLimitPo2 =
    typeof options.segmentLimitPo2 === "number"
      ? Math.max(1, Math.floor(options.segmentLimitPo2))
      : DEFAULT_SEGMENT_LIMIT_PO2;
  url.searchParams.set("segment_limit_po2", String(segmentLimitPo2));

  // The Stellar on-chain verifier expects Groth16 seals.
  url.searchParams.set("receipt_kind", "groth16");
  // Skip prover-side receipt verification; on-chain verification is the source of truth.
  url.searchParams.set("verify_mode", "policy");
  url.searchParams.set("seed_id", String(options.seedId >>> 0));
  url.searchParams.set("claimant", options.claimantAddress);

  return url;
}

function buildProverStatusUrl(env: WorkerEnv, proverJobId: string): URL {
  return buildProverUrl(env, `/api/jobs/${proverJobId}`);
}

function buildProverHealthUrl(env: WorkerEnv): URL {
  return buildProverUrl(env, "/health");
}

function buildProverHeaders(env: WorkerEnv, includeContentType: boolean): Headers {
  const headers = new Headers();

  if (includeContentType) {
    headers.set("content-type", "application/octet-stream");
  }

  if (env.PROVER_API_KEY) {
    headers.set("x-api-key", env.PROVER_API_KEY);
  }

  if (env.PROVER_ACCESS_CLIENT_ID && env.PROVER_ACCESS_CLIENT_SECRET) {
    headers.set("CF-Access-Client-Id", env.PROVER_ACCESS_CLIENT_ID);
    headers.set("CF-Access-Client-Secret", env.PROVER_ACCESS_CLIENT_SECRET);
  }

  return headers;
}

async function fetchWithTimeout(url: URL, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function parseJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

export function describeProverHealthError(error: unknown): {
  retryable: boolean;
  message: string;
} {
  if (error instanceof ProverHealthCheckError) {
    return {
      retryable: error.retryable,
      message: error.message,
    };
  }

  return {
    retryable: true,
    message: safeErrorMessage(error),
  };
}

function cacheKeyForHealthCheck(env: WorkerEnv): string {
  const proverBaseUrl = env.PROVER_BASE_URL?.trim() ?? "";
  const expectedImageId = env.PROVER_EXPECTED_IMAGE_ID?.trim() ?? "";
  return `${proverBaseUrl}|${expectedImageId}`;
}

export async function getValidatedProverHealth(
  env: WorkerEnv,
  options?: { forceRefresh?: boolean },
): Promise<ValidatedProverHealth> {
  const forceRefresh = options?.forceRefresh ?? false;
  const cacheMs = parseInteger(env.PROVER_HEALTH_CACHE_MS, DEFAULT_PROVER_HEALTH_CACHE_MS, 1_000);
  const cacheKey = cacheKeyForHealthCheck(env);
  const now = Date.now();

  if (
    !forceRefresh &&
    proverHealthCache &&
    proverHealthCache.cacheKey === cacheKey &&
    now - proverHealthCache.fetchedAtMs <= cacheMs
  ) {
    return proverHealthCache.value;
  }

  const timeoutMs = parseInteger(
    env.PROVER_REQUEST_TIMEOUT_MS,
    DEFAULT_PROVER_REQUEST_TIMEOUT_MS,
    1_000,
  );

  let response: Response;
  try {
    response = await fetchWithTimeout(
      buildProverHealthUrl(env),
      {
        method: "GET",
        headers: buildProverHeaders(env, false),
      },
      timeoutMs,
    );
  } catch (error) {
    throw new ProverHealthCheckError(
      `failed reaching prover health endpoint: ${safeErrorMessage(error)}`,
      true,
    );
  }

  if (response.status >= 500 || response.status === 429) {
    throw new ProverHealthCheckError(`prover health endpoint returned ${response.status}`, true);
  }

  if (!response.ok) {
    let detail = "";
    try {
      detail = await response.text();
    } catch {
      // Ignore parse errors.
    }
    throw new ProverHealthCheckError(
      `prover health endpoint returned ${response.status}: ${detail || "no body"}`,
      false,
    );
  }

  let payload: ProverHealthResponse;
  try {
    payload = await parseJson<ProverHealthResponse>(response);
  } catch (error) {
    throw new ProverHealthCheckError(
      `failed parsing prover health response: ${safeErrorMessage(error)}`,
      true,
    );
  }

  const normalizedImageId =
    typeof payload.image_id === "string" ? normalizeHex32Bytes(payload.image_id) : null;
  if (!normalizedImageId) {
    throw new ProverHealthCheckError(
      "prover health missing valid image_id (expected 32-byte hex)",
      false,
    );
  }

  const rulesDigest =
    typeof payload.rules_digest === "number" && Number.isFinite(payload.rules_digest)
      ? payload.rules_digest >>> 0
      : null;
  if (rulesDigest === null) {
    throw new ProverHealthCheckError("prover health missing rules_digest (u32)", false);
  }

  if (rulesDigest !== EXPECTED_RULES_DIGEST >>> 0) {
    throw new ProverHealthCheckError(
      `prover health rules_digest mismatch: 0x${rulesDigest.toString(16).padStart(8, "0")} (expected 0x${EXPECTED_RULES_DIGEST.toString(16).padStart(8, "0")})`,
      false,
    );
  }

  const ruleset = typeof payload.ruleset === "string" ? payload.ruleset.trim() : "";
  if (ruleset !== EXPECTED_RULESET) {
    throw new ProverHealthCheckError(
      `prover health ruleset mismatch: ${ruleset || "missing"} (expected ${EXPECTED_RULESET})`,
      false,
    );
  }

  const expectedImageIdRaw = env.PROVER_EXPECTED_IMAGE_ID?.trim();
  if (expectedImageIdRaw && expectedImageIdRaw.length > 0) {
    const normalizedExpectedImageId = normalizeHex32Bytes(expectedImageIdRaw);
    if (!normalizedExpectedImageId) {
      throw new ProverHealthCheckError("PROVER_EXPECTED_IMAGE_ID must be 32-byte hex", false);
    }
    if (normalizedExpectedImageId !== normalizedImageId) {
      throw new ProverHealthCheckError(
        `prover health image_id mismatch: ${normalizedImageId} (expected ${normalizedExpectedImageId})`,
        false,
      );
    }
  }

  const validated: ValidatedProverHealth = {
    imageId: normalizedImageId,
    rulesDigest,
    rulesDigestHex: `0x${rulesDigest.toString(16).padStart(8, "0")}`,
    ruleset,
  };

  proverHealthCache = {
    cacheKey,
    fetchedAtMs: now,
    value: validated,
  };

  return validated;
}

export async function submitToProver(
  env: WorkerEnv,
  tapeBytes: Uint8Array,
  options: ProverCreateOptions,
): Promise<ProverSubmitResult> {
  try {
    await getValidatedProverHealth(env);
  } catch (error) {
    const healthError = describeProverHealthError(error);
    return {
      type: healthError.retryable ? "retry" : "fatal",
      message: `prover health check failed: ${healthError.message}`,
    };
  }

  const timeoutMs = parseInteger(
    env.PROVER_REQUEST_TIMEOUT_MS,
    DEFAULT_PROVER_REQUEST_TIMEOUT_MS,
    1_000,
  );

  const createUrl = buildProverCreateUrlWithOptions(env, options);
  const submittedSegmentLimitPo2 = parseInteger(
    createUrl.searchParams.get("segment_limit_po2") ?? undefined,
    DEFAULT_SEGMENT_LIMIT_PO2,
    1,
  );

  let response: Response;
  try {
    response = await fetchWithTimeout(
      createUrl,
      {
        method: "POST",
        headers: buildProverHeaders(env, true),
        body: new Uint8Array(tapeBytes),
      },
      timeoutMs,
    );
  } catch (error) {
    return {
      type: "retry",
      message: `failed reaching prover create endpoint: ${safeErrorMessage(error)}`,
    };
  }

  if (response.status === 429 || response.status >= 500) {
    let errorBody: ProverErrorResponse | undefined;
    try {
      errorBody = (await response.json()) as ProverErrorResponse;
    } catch {
      // Ignore parse errors.
    }
    const codePart = errorBody?.error_code ? ` (${errorBody.error_code})` : "";
    const detailPart = errorBody?.error ? `: ${errorBody.error}` : "";
    return {
      type: "retry",
      message: `prover create endpoint returned ${response.status}${codePart}${detailPart}`,
    };
  }

  if (!response.ok) {
    let detail = "";
    try {
      detail = await response.text();
    } catch {
      // Ignore parse errors.
    }

    return {
      type: "fatal",
      message: `prover rejected tape submission (${response.status}): ${detail || "no body"}`,
    };
  }

  let payload: ProverCreateJobResponse;
  try {
    payload = await parseJson<ProverCreateJobResponse>(response);
  } catch (error) {
    return {
      type: "retry",
      message: `failed parsing prover create response: ${safeErrorMessage(error)}`,
    };
  }

  if (!payload.success || !payload.job_id) {
    return {
      type: "fatal",
      message: payload.error ?? "prover create response was missing job_id",
    };
  }

  if (!payload.status_url || payload.status_url.trim().length === 0) {
    return {
      type: "fatal",
      message: "prover create response was missing status_url",
    };
  }

  const statusUrl = payload.status_url;
  return {
    type: "success",
    jobId: payload.job_id,
    statusUrl,
    segmentLimitPo2: submittedSegmentLimitPo2,
  };
}

/**
 * Single-shot prover status check: one HTTP fetch, parse, return.
 * Used by the DO alarm handler and kickAlarm() for progress checks.
 */
export async function pollProverOnce(
  env: WorkerEnv,
  proverJobId: string,
): Promise<ProverPollResult> {
  const requestTimeoutMs = parseInteger(
    env.PROVER_REQUEST_TIMEOUT_MS,
    DEFAULT_PROVER_REQUEST_TIMEOUT_MS,
    1_000,
  );

  let response: Response;
  try {
    response = await fetchWithTimeout(
      buildProverStatusUrl(env, proverJobId),
      {
        method: "GET",
        headers: buildProverHeaders(env, false),
      },
      requestTimeoutMs,
    );
  } catch (error) {
    return {
      type: "retry",
      message: `failed reading prover status: ${safeErrorMessage(error)}`,
    };
  }

  if (response.status === 429 || response.status >= 500) {
    let errorBody: ProverErrorResponse | undefined;
    try {
      errorBody = (await response.json()) as ProverErrorResponse;
    } catch {
      // Ignore parse errors.
    }
    const codePart = errorBody?.error_code ? ` (${errorBody.error_code})` : "";
    const detailPart = errorBody?.error ? `: ${errorBody.error}` : "";
    return {
      type: "retry",
      message: `prover status endpoint returned ${response.status}${codePart}${detailPart}`,
      errorCode: errorBody?.error_code ?? undefined,
    };
  }

  // A 404 means the prover lost the job (crash/restart). The tape is
  // still valid — clear the prover job ID so the next attempt
  // re-submits rather than polling a dead job forever.
  if (response.status === 404) {
    return {
      type: "retry",
      message: "prover job not found (likely prover restart); will re-submit",
      clearProverJob: true,
    };
  }

  if (!response.ok) {
    let detail = "";
    try {
      detail = await response.text();
    } catch {
      // Ignore parse errors.
    }

    return {
      type: "fatal",
      message: `prover status endpoint returned ${response.status}: ${detail || "no body"}`,
    };
  }

  let payload: ProverGetJobResponse;
  try {
    payload = await parseJson<ProverGetJobResponse>(response);
  } catch (error) {
    return {
      type: "retry",
      message: `failed parsing prover status response: ${safeErrorMessage(error)}`,
    };
  }

  if (payload.status === "succeeded") {
    if (!payload.result?.proof || !payload.result.proof.journal || !payload.result.proof.stats) {
      return {
        type: "retry",
        message: "prover reported success but result payload was incomplete; will re-submit",
        clearProverJob: true,
      };
    }

    let summary: ProofResultSummary;
    try {
      summary = summarizeProof(payload);
    } catch (error) {
      return {
        type: "fatal",
        message: `prover success payload failed strict v4 validation: ${safeErrorMessage(error)}`,
      };
    }

    let artifact;
    try {
      artifact = await buildProofArtifactV4FromProverResponse(
        "vast",
        payload,
        summary,
        new Date().toISOString(),
      );
    } catch (error) {
      return {
        type: "fatal",
        message: `failed building v4 proof artifact: ${safeErrorMessage(error)}`,
      };
    }

    return {
      type: "success",
      summary,
      artifact,
    };
  }

  if (payload.status === "failed") {
    if (payload.error_code && RETRYABLE_JOB_ERROR_CODES.has(payload.error_code)) {
      return {
        type: "retry",
        message: `prover job failed with retryable error_code=${payload.error_code}: ${payload.error ?? "unknown"}`,
        clearProverJob: true,
        errorCode: payload.error_code,
        errorDetail: payload.error ?? undefined,
      };
    }
    const codePart = payload.error_code ? ` (error_code=${payload.error_code})` : "";
    return {
      type: "fatal",
      message: payload.error
        ? `prover marked job as failed${codePart}: ${payload.error}`
        : `prover marked job as failed${codePart}`,
      errorCode: payload.error_code ?? undefined,
      errorDetail: payload.error ?? undefined,
    };
  }

  if (payload.status !== "queued" && payload.status !== "running") {
    return {
      type: "fatal",
      message: `prover returned unknown job status: ${payload.status}`,
    };
  }

  return {
    type: "running",
    status: payload.status,
  };
}

function readJournalU32(
  value: unknown,
  field: "seed_id" | "seed" | "frame_count" | "final_score",
): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`prover returned invalid ${field} in journal; expected u32`);
  }
  if (value < 0 || value > 0xffff_ffff) {
    throw new Error(`prover returned out-of-range ${field} in journal; expected u32`);
  }
  return value >>> 0;
}

export function summarizeProof(response: ProverGetJobResponse): ProofResultSummary {
  const result = response.result;
  if (!result) {
    throw new Error("prover result payload missing");
  }

  const seedId = readJournalU32(result.proof.journal.seed_id, "seed_id");
  const seed = readJournalU32(result.proof.journal.seed, "seed");
  const frameCount = readJournalU32(result.proof.journal.frame_count, "frame_count");
  const finalScore = readJournalU32(result.proof.journal.final_score, "final_score");
  if (frameCount === 0) {
    throw new Error("prover returned frame_count=0; tape frame_count must be > 0");
  }
  if (finalScore === 0) {
    throw new Error("prover returned final_score=0; zero-score runs are not accepted");
  }

  const claimant = result.proof.journal.claimant;
  if (typeof claimant !== "string") {
    throw new Error("prover returned invalid claimant in journal; expected Stellar G... or C...");
  }
  let normalizedClaimant = "";
  try {
    normalizedClaimant = parseClaimantStrKeyFromUserInput(claimant).normalized;
  } catch {
    throw new Error("prover returned invalid claimant in journal; expected Stellar G... or C...");
  }

  const requestedReceiptKind = result.proof.requested_receipt_kind;
  if (requestedReceiptKind !== "groth16") {
    throw new Error(
      `prover returned requested_receipt_kind=${requestedReceiptKind}; expected groth16`,
    );
  }

  const producedReceiptKind = result.proof.produced_receipt_kind;
  if (producedReceiptKind !== "groth16") {
    throw new Error(
      `prover returned produced_receipt_kind=${String(producedReceiptKind)}; expected groth16`,
    );
  }

  return {
    elapsedMs: result.elapsed_ms,
    requestedReceiptKind,
    producedReceiptKind,
    journal: {
      seed_id: seedId,
      seed,
      frame_count: frameCount,
      final_score: finalScore,
      claimant: normalizedClaimant,
    },
    stats: result.proof.stats,
  };
}
