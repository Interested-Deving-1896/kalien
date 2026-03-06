import type { WorkerEnv } from "./env";
import { tapeKey } from "./keys";
import type { ProofJobRecord } from "./types";
import { safeErrorMessage } from "./utils";

const HEX_TX_HASH_RE = /^[0-9a-f]{64}$/i;

export interface ReplayLookupCandidate {
  claimTxHash: string | null;
  seed: number;
  finalScore: number;
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function normalizeReplayTxHash(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return HEX_TX_HASH_RE.test(normalized) ? normalized : null;
}

function compareJobsByFreshness(a: ProofJobRecord, b: ProofJobRecord): number {
  const aTime = a.claim.submittedAt ?? a.completedAt ?? a.createdAt;
  const bTime = b.claim.submittedAt ?? b.completedAt ?? b.createdAt;
  return bTime.localeCompare(aTime);
}

function jobClaimTxHashes(job: ProofJobRecord): string[] {
  const hashes = new Set<string>();
  const primary = normalizeReplayTxHash(job.claim.txHash);
  if (primary) {
    hashes.add(primary);
  }
  for (const attempt of job.claimAttempts ?? []) {
    const normalized = normalizeReplayTxHash(attempt.txHash);
    if (normalized) {
      hashes.add(normalized);
    }
  }
  return Array.from(hashes);
}

function matchingJobsForCandidate(
  jobs: ProofJobRecord[],
  candidate: ReplayLookupCandidate,
): ProofJobRecord[] {
  return jobs.filter((job) => {
    const jobSeed = asFiniteNumber(job.tape?.metadata?.seed);
    const jobFinalScore = asFiniteNumber(job.tape?.metadata?.finalScore);
    return jobSeed === candidate.seed && jobFinalScore === candidate.finalScore;
  });
}

function findExactMatchInCandidates(
  matches: ProofJobRecord[],
  candidate: ReplayLookupCandidate,
): ProofJobRecord | null {
  const normalizedCandidateTxHash = normalizeReplayTxHash(candidate.claimTxHash);
  if (!normalizedCandidateTxHash) {
    return null;
  }

  const exactMatches = matches.filter((job) =>
    jobClaimTxHashes(job).includes(normalizedCandidateTxHash),
  );
  if (exactMatches.length === 0) {
    return null;
  }

  exactMatches.sort(compareJobsByFreshness);
  return exactMatches[0] ?? null;
}

export async function proofJobHasReplayTape(
  env: Pick<WorkerEnv, "PROOF_ARTIFACTS">,
  job: { jobId: string; tape?: { key?: string | null } | null },
): Promise<boolean> {
  const primaryKey =
    typeof job.tape?.key === "string" && job.tape.key.trim().length > 0
      ? job.tape.key
      : tapeKey(job.jobId);
  try {
    const primary = await env.PROOF_ARTIFACTS.head(primaryKey);
    if (primary) {
      return true;
    }
    const fallbackKey = tapeKey(job.jobId);
    if (fallbackKey !== primaryKey) {
      return Boolean(await env.PROOF_ARTIFACTS.head(fallbackKey));
    }
    return false;
  } catch (error) {
    console.warn(
      `[replay-recovery] failed to head replay tape for ${job.jobId}: ${safeErrorMessage(error)}`,
    );
    return false;
  }
}

export function findExactMatchingProofJob(
  jobs: ProofJobRecord[],
  candidate: ReplayLookupCandidate,
): ProofJobRecord | null {
  const matches = matchingJobsForCandidate(jobs, candidate);
  if (matches.length === 0) {
    return null;
  }
  return findExactMatchInCandidates(matches, candidate);
}

export function findBestMatchingProofJob(
  jobs: ProofJobRecord[],
  candidate: ReplayLookupCandidate,
  allowNonSucceeded = false,
): ProofJobRecord | null {
  const matches = matchingJobsForCandidate(jobs, candidate);
  if (matches.length === 0) {
    return null;
  }

  const exactMatch = findExactMatchInCandidates(matches, candidate);
  if (exactMatch) {
    return exactMatch;
  }

  const succeededMatches = matches.filter((job) => job.claim.status === "succeeded");
  if (succeededMatches.length === 1) {
    succeededMatches.sort(compareJobsByFreshness);
    return succeededMatches[0];
  }
  if (succeededMatches.length > 1) {
    return null;
  }

  if (!allowNonSucceeded) {
    return null;
  }

  if (matches.length === 1) {
    return matches[0];
  }

  return null;
}
