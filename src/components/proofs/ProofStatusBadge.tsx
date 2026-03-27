import { StatusBadge } from "@/components/ui/status-badge";
import type { ProofJobPublic, ProofJobStatus, ClaimStatus, ProverBackend } from "@/proof/api";
import { getActiveBackend, isSupersededProofJob } from "@/proof/helpers";

function backendLabel(backend: ProverBackend): string {
  return backend === "boundless" ? "Boundless" : "Vast";
}

export function ProofStatusBadge({ job }: { job: ProofJobPublic }) {
  const status: ProofJobStatus = job.status;
  const claimStatus: ClaimStatus = job.claim.status;
  const backend = getActiveBackend(job);

  if (isSupersededProofJob(job)) {
    return <StatusBadge variant="purple">Superseded</StatusBadge>;
  }

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
      if (job.prover.jobId) {
        const label = backend ? `Polling · ${backendLabel(backend)}` : "Polling";
        return <StatusBadge variant="info">{label}</StatusBadge>;
      }
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
