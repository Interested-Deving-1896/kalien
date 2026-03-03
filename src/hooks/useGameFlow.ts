import { useCallback, useEffect, useMemo, useState } from "react";
import type { CompletedGameRun } from "../game/types";
import { isTerminalProofStatus, listProofJobs } from "../proof/api";
import { deserializeTape } from "../game/tape";
import type { UseWalletReturn } from "./useWallet";
import { useProofJob, type UseProofJobReturn } from "./useProofJob";
import type { UseTokenBalanceReturn } from "./useTokenBalance";

export type GameFlowStep = "play" | "score" | "wallet" | "prove" | "earn";

export interface UseGameFlowReturn {
  currentStep: GameFlowStep;
  wallet: UseWalletReturn;
  proof: UseProofJobReturn;
  balance: UseTokenBalanceReturn;
  latestRun: CompletedGameRun | null;
  hasPositiveScore: boolean;
  handleGameOver: (run: CompletedGameRun) => void;
  dismissOverlay: () => void;
  submitForProof: () => Promise<void>;
  loadTapeFile: () => void;
  claimStatus: "idle" | "submitting" | "succeeded" | "failed";
  claimTxHash: string | null;
  claimError: string | null;
  canSubmitForProof: boolean;
}

export interface UseGameFlowDeps {
  wallet: UseWalletReturn;
  balance: UseTokenBalanceReturn;
}

export function useGameFlow(deps: UseGameFlowDeps): UseGameFlowReturn {
  const [latestRun, setLatestRun] = useState<CompletedGameRun | null>(null);

  const { wallet, balance } = deps;

  const proof = useProofJob({
    onClaimSucceeded: balance.refresh,
  });

  const hasPositiveScore = (latestRun?.record.finalScore ?? 0) > 0;

  // Restore in-progress job on mount by fetching the user's most recent job.
  useEffect(() => {
    if (!wallet.address || !wallet.isConnected) return;

    let cancelled = false;
    listProofJobs(wallet.address, { limit: 1 })
      .then((response) => {
        if (cancelled) return undefined;
        const latest = response.jobs[0];
        const claimPendingAfterProofSuccess =
          latest?.status === "succeeded" &&
          latest.claim.status !== "succeeded" &&
          latest.claim.status !== "failed";
        if (latest && (!isTerminalProofStatus(latest.status) || claimPendingAfterProofSuccess)) {
          proof.setJobFromExternal(latest);
        }
        return undefined;
      })
      .catch(() => {
        // Job list may be empty or unavailable — ignore.
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- proof methods are stable refs from useProofJob
  }, [wallet.address, wallet.isConnected, proof]);

  const handleGameOver = useCallback(
    (run: CompletedGameRun) => {
      setLatestRun(run);
      proof.clearError();
      proof.clear();
    },
    [proof],
  );

  const dismissOverlay = useCallback(() => {
    setLatestRun(null);
  }, []);

  const loadTapeFile = useCallback(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".tape";
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) return;
      void (async () => {
        try {
          const buf = await file.arrayBuffer();
          const bytes = new Uint8Array(buf);
          const tape = deserializeTape(bytes);
          // Tape v4 format does not carry seed_id — set to 0 so the proof
          // submission guard rejects with a clear message rather than submitting
          // an unprovable job.
          setLatestRun({
            record: {
              seed: tape.header.seed,
              seedId: 0,
              inputs: tape.inputs,
              finalScore: tape.footer.finalScore,
            },
            frameCount: tape.header.frameCount,
            endedAtMs: Date.now(),
          });
          proof.clearError();
          proof.clear();
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          proof.setError(`failed to load tape file: ${detail}`);
        }
      })();
    });
    input.click();
  }, [proof]);

  const submitForProof = useCallback(async () => {
    if (!latestRun) {
      return;
    }
    await proof.submitRun(latestRun, wallet.address);
  }, [latestRun, proof, wallet.address]);

  const canSubmitForProof =
    Boolean(latestRun) &&
    hasPositiveScore &&
    !proof.isSubmitting &&
    !proof.isBusy &&
    wallet.isConnected &&
    !wallet.isBusy;

  const claimStatus = useMemo<"idle" | "submitting" | "succeeded" | "failed">(() => {
    const proofStatus = proof.job?.status;
    const status = proof.job?.claim.status;
    if (proofStatus !== "succeeded" || !status) {
      return "idle";
    }
    if (status === "succeeded") {
      return "succeeded";
    }
    if (status === "failed") {
      return "failed";
    }
    // queued | submitting | retrying all map to "submitting" in this UI.
    return "submitting";
  }, [proof.job?.status, proof.job?.claim.status]);
  const claimTxHash = proof.job?.claim.txHash ?? null;
  const claimError = claimStatus === "failed" ? (proof.job?.claim.lastError ?? null) : null;

  const currentStep = useMemo<GameFlowStep>(() => {
    if (proof.job?.status === "succeeded") {
      return "earn";
    }
    if (proof.isBusy) {
      return "prove";
    }
    if (latestRun && !wallet.isConnected) {
      return "wallet";
    }
    if (latestRun) {
      return "score";
    }
    return "play";
  }, [latestRun, wallet.isConnected, proof.isBusy, proof.job?.status]);

  return {
    currentStep,
    wallet,
    proof,
    balance,
    latestRun,
    hasPositiveScore,
    handleGameOver,
    dismissOverlay,
    submitForProof,
    loadTapeFile,
    claimStatus,
    claimTxHash,
    claimError,
    canSubmitForProof,
  };
}
