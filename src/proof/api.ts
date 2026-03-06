import {
  API_TIMEOUT_GET_ARTIFACT_MS,
  API_TIMEOUT_GET_PROOF_MS,
  API_TIMEOUT_LIST_JOBS_MS,
  API_TIMEOUT_SUBMIT_PROOF_MS,
} from "../consts";
import { fetchWithTimeout as baseFetchWithTimeout, parseJson } from "../lib/api";

export type ProofJobStatus =
  | "queued"
  | "dispatching"
  | "prover_running"
  | "retrying"
  | "succeeded"
  | "failed";

export interface TapeMetadata {
  seed: number;
  seedId: number;
  frameCount: number;
  finalScore: number;
  checksum: number;
}

export interface ProofTapeInfo {
  sizeBytes: number;
  metadata: TapeMetadata;
}

export interface QueueTracking {
  attempts: number;
  lastAttemptAt: string | null;
  lastError: string | null;
  nextRetryAt: string | null;
  waitStartedAt?: string | null;
  waitElapsedMs?: number | null;
}

export type ProverBackend = "boundless" | "vast";

export interface ProverAttempt {
  index: number;
  backend: ProverBackend;
  startedAt: string;
  endedAt: string | null;
  outcome: "in_progress" | "success" | "failed";
  error: string | null;
  errorDetail: string | null;
  errorCode: string | null;
  proverJobId: string | null;
  statusUrl: string | null;
  maxPriceUsd?: number | null;
  actualCostUsd: number | null;
  proverAddress: string | null;
  fulfillmentTxHash: string | null;
  programCycles?: number | null;
  totalCycles?: number | null;
}

export interface ClaimAttempt {
  index: number;
  startedAt: string;
  endedAt: string | null;
  outcome: "in_progress" | "success" | "failed";
  error: string | null;
  errorDetail: string | null;
  txHash: string | null;
}

export interface ProverTracking {
  jobId: string | null;
  status: "queued" | "running" | "succeeded" | "failed" | null;
  statusUrl: string | null;
  lastPolledAt: string | null;
  pollingErrors: number;
  ipfsCid: string | null;
  runStartedAt?: string | null;
  runElapsedMs?: number | null;
}

export type ClaimStatus = "queued" | "submitting" | "retrying" | "succeeded" | "failed";

export interface ClaimTracking {
  claimantAddress: string;
  status: ClaimStatus;
  attempts: number;
  lastAttemptAt: string | null;
  lastError: string | null;
  nextRetryAt: string | null;
  submittedAt: string | null;
  txHash: string | null;
}

export interface ProofJournal {
  seed_id: number;
  seed: number;
  frame_count: number;
  final_score: number;
  claimant: string;
}

export interface ProofStats {
  segments: number;
  total_cycles: number;
  user_cycles: number;
  paging_cycles: number;
  reserved_cycles: number;
}

export interface ProofResultSummary {
  elapsedMs: number;
  requestedReceiptKind: string;
  producedReceiptKind: string;
  journal: ProofJournal;
  stats: ProofStats;
}

export interface ProofResultInfo {
  artifactKey: string;
  summary: ProofResultSummary;
}

export interface ProofJobPublic {
  jobId: string;
  status: ProofJobStatus;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  tape: ProofTapeInfo;
  queue: QueueTracking;
  prover: ProverTracking;
  result: ProofResultInfo | null;
  claim: ClaimTracking;
  error: string | null;
  errorCode?: string | null;
  timeoutPhase?: "vast_wait" | "prover_run" | "total_wall" | null;
  proverAttempts: ProverAttempt[];
  claimAttempts: ClaimAttempt[];
}

export interface SubmitProofJobResponse {
  success: true;
  status_url: string;
  job: ProofJobPublic;
}

export interface GetProofJobResponse {
  success: true;
  job: ProofJobPublic;
}

export interface ProofArtifactV4Response {
  version: "v4";
  stored_at: string;
  backend: ProverBackend;
  seal_hex: string;
  journal_raw_hex: string;
  journal_digest_hex: string;
  requested_receipt_kind: "groth16";
  produced_receipt_kind: "groth16";
}

interface ApiErrorResponse {
  success: false;
  error?: string;
  active_job?: ProofJobPublic;
}

export class ProofApiError extends Error {
  readonly status: number;
  readonly activeJob: ProofJobPublic | null;

  constructor(message: string, status: number, activeJob: ProofJobPublic | null = null) {
    super(message);
    this.name = "ProofApiError";
    this.status = status;
    this.activeJob = activeJob;
  }
}

export function isTerminalProofStatus(status: ProofJobStatus): boolean {
  return status === "succeeded" || status === "failed";
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  timeoutMs: number,
): Promise<Response> {
  try {
    return await baseFetchWithTimeout(input, init, timeoutMs);
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new ProofApiError("request timed out", 0);
    }
    throw err;
  }
}

async function parseError(response: Response): Promise<ProofApiError> {
  let message = `request failed (${response.status})`;
  let activeJob: ProofJobPublic | null = null;

  try {
    const payload = (await response.json()) as ApiErrorResponse;
    if (typeof payload.error === "string" && payload.error.trim().length > 0) {
      message = payload.error;
    }

    if (payload.active_job) {
      activeJob = payload.active_job;
    }
  } catch {
    // ignore parse failures and use fallback message
  }

  return new ProofApiError(message, response.status, activeJob);
}

export async function submitProofJob(
  tapeBytes: Uint8Array,
  claimantAddress: string,
  seedId: number,
): Promise<SubmitProofJobResponse> {
  const body = new Uint8Array(tapeBytes).buffer;
  const params = new URLSearchParams({
    claimant: claimantAddress,
    seed_id: String(seedId >>> 0),
  });
  const headers: Record<string, string> = {
    "content-type": "application/octet-stream",
  };

  const response = await fetchWithTimeout(
    `/api/proofs/jobs?${params.toString()}`,
    {
      method: "POST",
      headers,
      body,
    },
    API_TIMEOUT_SUBMIT_PROOF_MS,
  );

  if (!response.ok) {
    throw await parseError(response);
  }

  return parseJson<SubmitProofJobResponse>(response);
}

export async function getProofJob(jobId: string): Promise<GetProofJobResponse> {
  const response = await fetchWithTimeout(
    `/api/proofs/jobs/${jobId}`,
    {
      method: "GET",
    },
    API_TIMEOUT_GET_PROOF_MS,
  );

  if (!response.ok) {
    throw await parseError(response);
  }

  return parseJson<GetProofJobResponse>(response);
}

export async function getProofArtifact(jobId: string): Promise<ProofArtifactV4Response> {
  const response = await fetchWithTimeout(
    `/api/proofs/jobs/${jobId}/result`,
    {
      method: "GET",
    },
    API_TIMEOUT_GET_ARTIFACT_MS,
  );

  if (!response.ok) {
    throw await parseError(response);
  }

  return parseJson<ProofArtifactV4Response>(response);
}

export interface ListProofJobsResponse {
  success: true;
  jobs: ProofJobPublic[];
  total: number;
  offset: number;
  limit: number;
  next_offset: number | null;
}

export async function listProofJobs(
  claimantAddress: string,
  options: { limit?: number; offset?: number } = {},
): Promise<ListProofJobsResponse> {
  const params = new URLSearchParams({ address: claimantAddress });
  if (options.limit != null) params.set("limit", String(options.limit));
  if (options.offset != null) params.set("offset", String(options.offset));

  const response = await fetchWithTimeout(
    `/api/proofs/jobs?${params}`,
    { method: "GET" },
    API_TIMEOUT_LIST_JOBS_MS,
  );
  if (!response.ok) throw await parseError(response);
  return parseJson<ListProofJobsResponse>(response);
}

export async function retryFailedClaim(jobId: string): Promise<GetProofJobResponse> {
  const response = await fetchWithTimeout(
    `/api/proofs/jobs/${jobId}/retry-claim`,
    { method: "POST" },
    API_TIMEOUT_GET_PROOF_MS,
  );
  if (!response.ok) throw await parseError(response);
  return parseJson<GetProofJobResponse>(response);
}

export async function retryFailedProof(
  jobId: string,
  backend: "auto" | "boundless" | "vast" = "auto",
): Promise<GetProofJobResponse> {
  const params = new URLSearchParams();
  params.set("backend", backend);
  const response = await fetchWithTimeout(
    `/api/proofs/jobs/${jobId}/retry-proof?${params.toString()}`,
    { method: "POST" },
    API_TIMEOUT_GET_PROOF_MS,
  );
  if (!response.ok) throw await parseError(response);
  return parseJson<GetProofJobResponse>(response);
}

export function getTapeDownloadUrl(jobId: string): string {
  return `/api/proofs/jobs/${jobId}/tape`;
}

function defaultTapeFilename(jobId: string): string {
  return `${jobId}.tape`;
}

function extractFilename(contentDisposition: string | null, fallback: string): string {
  if (!contentDisposition) return fallback;

  const extendedMatch = contentDisposition.match(/filename\*\s*=\s*([^;]+)/i);
  if (extendedMatch) {
    const rawValue = extendedMatch[1]?.trim();
    if (rawValue) {
      const unquoted = rawValue.replace(/^"(.*)"$/, "$1");
      const parts = unquoted.split("''", 2);
      const encodedName = parts.length === 2 ? parts[1] : unquoted;
      try {
        const decoded = decodeURIComponent(encodedName);
        if (decoded) return decoded;
      } catch {
        // Fall back to the simpler filename parser below.
      }
    }
  }

  const basicMatch = contentDisposition.match(/filename\s*=\s*("?)([^";]+)\1/i);
  const filename = basicMatch?.[2]?.trim();
  return filename && filename.length > 0 ? filename : fallback;
}

function isTapeContentType(contentType: string | null): boolean {
  const normalized = contentType?.toLowerCase() ?? "";
  return (
    normalized.includes("application/octet-stream") || normalized.includes("application/x-binary")
  );
}

export async function fetchProofTape(
  jobId: string,
): Promise<{ bytes: Uint8Array; filename: string }> {
  const response = await fetchWithTimeout(
    getTapeDownloadUrl(jobId),
    { method: "GET" },
    API_TIMEOUT_GET_ARTIFACT_MS,
  );

  if (!response.ok) {
    throw await parseError(response);
  }

  const contentType = response.headers.get("content-type");
  if (!isTapeContentType(contentType)) {
    const normalized = contentType?.toLowerCase() ?? "";
    const message = normalized.includes("text/html")
      ? "expected tape bytes but received HTML"
      : `expected tape bytes but received ${contentType ?? "an unknown content type"}`;
    throw new ProofApiError(message, response.status);
  }

  const filename = extractFilename(
    response.headers.get("content-disposition"),
    defaultTapeFilename(jobId),
  );
  const bytes = new Uint8Array(await response.arrayBuffer());
  return { bytes, filename };
}

export async function downloadProofTape(jobId: string): Promise<void> {
  const { bytes, filename } = await fetchProofTape(jobId);
  const payload = bytes.slice().buffer as ArrayBuffer;
  const blob = new Blob([payload], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
