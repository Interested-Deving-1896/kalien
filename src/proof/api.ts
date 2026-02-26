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
  frameCount: number;
  finalScore: number;
  finalRngState: number;
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
}

export type ProverBackend = "boundless" | "vast";

export interface ProverAttempt {
  index: number;
  backend: ProverBackend;
  startedAt: string;
  endedAt: string | null;
  outcome: "in_progress" | "success" | "failed";
  error: string | null;
  proverJobId: string | null;
  statusUrl: string | null;
  maxPriceUsd?: number | null;
}

export interface ProverTracking {
  jobId: string | null;
  status: "queued" | "running" | "succeeded" | "failed" | null;
  statusUrl: string | null;
  lastPolledAt: string | null;
  pollingErrors: number;
  recoveryAttempts: number;
  ipfsCid: string | null;
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
  seed: number;
  frame_count: number;
  final_score: number;
  final_rng_state: number;
  tape_checksum: number;
  rules_digest: number;
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
  producedReceiptKind: string | null;
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
  proverAttempts: ProverAttempt[];
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

export interface StoredProofArtifactResponse {
  stored_at?: string;
  prover_response?: unknown;
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
): Promise<SubmitProofJobResponse> {
  const body = new Uint8Array(tapeBytes).buffer;
  const headers: Record<string, string> = {
    "content-type": "application/octet-stream",
    "x-claimant-address": claimantAddress,
  };

  const response = await fetchWithTimeout(
    "/api/proofs/jobs",
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

export async function getProofArtifact(jobId: string): Promise<StoredProofArtifactResponse> {
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

  return parseJson<StoredProofArtifactResponse>(response);
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

export function getTapeDownloadUrl(jobId: string): string {
  return `/api/proofs/jobs/${jobId}/tape`;
}
