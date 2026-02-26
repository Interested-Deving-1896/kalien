import { StatusBadge } from "@/components/ui/status-badge";
import type { ProofJobPublic, ProofJobStatus, ClaimStatus, ProverBackend } from "@/proof/api";

function getActiveBackend(job: ProofJobPublic): ProverBackend | null {
  if (!job.proverAttempts || job.proverAttempts.length === 0) {
    return null;
  }
  // Find the in-progress attempt first, then fall back to last attempt
  const inProgress = job.proverAttempts.find((a) => a.outcome === "in_progress");
  if (inProgress) return inProgress.backend;
  const last = job.proverAttempts[job.proverAttempts.length - 1];
  return last?.backend ?? null;
}

function backendLabel(backend: ProverBackend): string {
  return backend === "boundless" ? "Boundless" : "Vast";
}

export function ProofStatusBadge({ job }: { job: ProofJobPublic }) {
  const status: ProofJobStatus = job.status;
  const claimStatus: ClaimStatus = job.claim.status;
  const backend = getActiveBackend(job);

  switch (status) {
    case "queued":
      return <StatusBadge variant="muted">Queued</StatusBadge>;
    case "dispatching":
      return <StatusBadge variant="muted">Dispatching</StatusBadge>;
    case "prover_running": {
      const label = backend ? `Proving · ${backendLabel(backend)}` : "Proving";
      return <StatusBadge variant="info">{label}</StatusBadge>;
    }
    case "retrying":
      return <StatusBadge variant="warning">Retrying</StatusBadge>;
    case "succeeded":
      if (claimStatus === "succeeded") {
        return <StatusBadge variant="success">Claimed</StatusBadge>;
      }
      if (claimStatus === "failed") {
        return <StatusBadge variant="warning">Claim Failed</StatusBadge>;
      }
      return <StatusBadge variant="info">Claiming</StatusBadge>;
    case "failed":
      return <StatusBadge variant="error">Failed</StatusBadge>;
    default:
      return <StatusBadge variant="muted">{status}</StatusBadge>;
  }
}
