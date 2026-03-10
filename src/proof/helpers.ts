import type { ProofJobPublic, ProverBackend } from "./api";

export function boundlessExplorerUrl(statusUrl: string): string | null {
  if (!statusUrl.startsWith("boundless:")) return null;
  const requestId = statusUrl.slice("boundless:".length);
  try {
    const hex = BigInt(requestId).toString(16);
    return `https://explorer.beboundless.xyz/orders/0x${hex}`;
  } catch {
    return null;
  }
}

export function getActiveBackend(job: ProofJobPublic): ProverBackend | null {
  if (!job.proverAttempts || job.proverAttempts.length === 0) return null;
  const inProgress = job.proverAttempts.find((a) => a.outcome === "in_progress");
  if (inProgress) return inProgress.backend;
  const last = job.proverAttempts[job.proverAttempts.length - 1];
  return last?.backend ?? null;
}

export function isSupersededProofJob(job: ProofJobPublic): boolean {
  return (
    (job.status === "succeeded" && job.claim.txHash === "superseded-by-higher-score") ||
    (job.status === "failed" && job.errorCode === "superseded_by_higher_score")
  );
}
