import { useCallback, useEffect, useRef, useState } from "react";
import {
  getProofJob,
  isTerminalProofStatus,
  ProofApiError,
  submitProofJob,
  type ClaimStatus,
  type ProofJobPublic,
  type ProofJobStatus,
} from "../proof/api";
import { serializeTape } from "../game/tape";
import type { CompletedGameRun } from "../game/types";
import {
  PROOF_STATUS_CLAIM_RETRY_POLL_INTERVAL_MS,
  PROOF_STATUS_ERROR_POLL_INTERVAL_MS,
  PROOF_STATUS_INITIAL_POLL_DELAY_MS,
  PROOF_STATUS_POLL_INTERVAL_MS,
} from "../consts";

export interface UseProofJobReturn {
  job: ProofJobPublic | null;
  status: ProofJobStatus | "idle";
  isBusy: boolean;
  isSubmitting: boolean;
  hasResult: boolean;
  error: string | null;
  friendlyStatus: string;
  submitRun: (run: CompletedGameRun, claimantAddress: string) => Promise<boolean>;
  clearError: () => void;
  setError: (message: string) => void;
  clearIfTerminal: () => void;
  setJobFromExternal: (job: ProofJobPublic) => void;
}

function isTerminalClaimStatus(status: ClaimStatus): boolean {
  return status === "succeeded" || status === "failed";
}

function getFriendlyStatus(status: ProofJobStatus | "idle"): string {
  switch (status) {
    case "idle":
      return "Ready";
    case "queued":
    case "dispatching":
      return "Verifying your score...";
    case "prover_running":
      return "Verification in progress...";
    case "retrying":
      return "Still working on it...";
    case "succeeded":
      return "Score verified!";
    case "failed":
      return "Verification failed";
    default:
      return "Ready";
  }
}

export interface UseProofJobOptions {
  onClaimSucceeded?: () => void;
}

export function useProofJob(options?: UseProofJobOptions): UseProofJobReturn {
  const [job, setJob] = useState<ProofJobPublic | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const onClaimSucceededRef = useRef(options?.onClaimSucceeded);
  onClaimSucceededRef.current = options?.onClaimSucceeded;

  const activeJobId = job?.jobId ?? null;
  const activeJobStatus = job?.status ?? null;
  const activeClaimStatus = job?.claim.status ?? null;
  const status: ProofJobStatus | "idle" = job ? job.status : "idle";
  const isBusy = job ? !isTerminalProofStatus(job.status) : false;
  const hasResult = Boolean(job?.result?.summary);
  const friendlyStatus = getFriendlyStatus(status);

  const submitRun = useCallback(
    async (run: CompletedGameRun, claimantAddress: string): Promise<boolean> => {
      if (!run) {
        return false;
      }
      if (run.record.finalScore <= 0) {
        setError("zero-score runs are not accepted for proving or earning KALIEN");
        return false;
      }
      if (claimantAddress.trim().length === 0) {
        setError("connect a smart wallet before submitting a proof");
        return false;
      }

      let tapeBytes: Uint8Array;
      try {
        tapeBytes = serializeTape(
          run.record.seed,
          run.record.inputs,
          run.record.finalScore,
          run.record.finalRngState,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : "failed to serialize tape";
        setError(message);
        return false;
      }

      setIsSubmitting(true);
      setError(null);

      try {
        const response = await submitProofJob(tapeBytes, claimantAddress);
        setJob(response.job);
        return true;
      } catch (err) {
        if (err instanceof ProofApiError) {
          if (err.activeJob) {
            setJob(err.activeJob);
          }
          setError(err.message);
        } else {
          setError("failed to submit proof job");
        }
        return false;
      } finally {
        setIsSubmitting(false);
      }
    },
    [],
  );

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  const setErrorExposed = useCallback((message: string) => {
    setError(message);
  }, []);

  const clearIfTerminal = useCallback(() => {
    setJob((current: ProofJobPublic | null) => {
      if (!current) {
        return null;
      }
      return isTerminalProofStatus(current.status) ? null : current;
    });
  }, []);

  const setJobFromExternal = useCallback((externalJob: ProofJobPublic) => {
    setJob((current: ProofJobPublic | null) => current ?? externalJob);
  }, []);

  // Proof status polling
  useEffect(() => {
    if (!activeJobId || !activeJobStatus) {
      return;
    }
    const keepPolling =
      !isTerminalProofStatus(activeJobStatus) ||
      (activeJobStatus === "succeeded" &&
        activeClaimStatus !== null &&
        !isTerminalClaimStatus(activeClaimStatus));
    if (!keepPolling) {
      return;
    }

    let cancelled = false;
    let timeoutId: number | null = null;

    const poll = async () => {
      try {
        const response = await getProofJob(activeJobId);
        if (cancelled) {
          return;
        }

        setJob(response.job);
        const shouldContinuePolling =
          !isTerminalProofStatus(response.job.status) ||
          (response.job.status === "succeeded" &&
            !isTerminalClaimStatus(response.job.claim.status));
        if (shouldContinuePolling) {
          const claimRetrying =
            response.job.status === "succeeded" && response.job.claim.status === "retrying";
          const interval = claimRetrying
            ? PROOF_STATUS_CLAIM_RETRY_POLL_INTERVAL_MS
            : PROOF_STATUS_POLL_INTERVAL_MS;
          timeoutId = window.setTimeout(poll, interval);
          return;
        }
      } catch (err) {
        if (cancelled) {
          return;
        }

        const message = err instanceof Error ? err.message : "failed to refresh proof status";
        setError(message);
        timeoutId = window.setTimeout(poll, PROOF_STATUS_ERROR_POLL_INTERVAL_MS);
      }
    };

    timeoutId = window.setTimeout(poll, PROOF_STATUS_INITIAL_POLL_DELAY_MS);

    return () => {
      cancelled = true;
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [activeClaimStatus, activeJobId, activeJobStatus]);

  // Notify when claim succeeds via polling
  useEffect(() => {
    if (job?.claim.status === "succeeded") {
      onClaimSucceededRef.current?.();
    }
  }, [job?.claim.status]);

  return {
    job,
    status,
    isBusy,
    isSubmitting,
    hasResult,
    error,
    friendlyStatus,
    submitRun,
    clearError,
    setError: setErrorExposed,
    clearIfTerminal,
    setJobFromExternal,
  };
}
