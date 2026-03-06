import { useCallback, useState } from "react";
import type { CompletedGameRun } from "../game/types";
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
  submitForProof: () => Promise<boolean>;
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
  const { clear, clearError, setError, submitRun } = proof;

  const hasPositiveScore = (latestRun?.record.finalScore ?? 0) > 0;

  const handleGameOver = useCallback(
    (run: CompletedGameRun) => {
      setLatestRun(run);
      clearError();
      clear();
    },
    [clear, clearError],
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
          clearError();
          clear();
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          setError(`failed to load tape file: ${detail}`);
        }
      })();
    });
    input.click();
  }, [clear, clearError, setError]);

  const submitForProof = useCallback(async () => {
    if (!latestRun) {
      return false;
    }
    return submitRun(latestRun, wallet.address);
  }, [latestRun, submitRun, wallet.address]);

  const canSubmitForProof =
    Boolean(latestRun) &&
    hasPositiveScore &&
    !proof.isSubmitting &&
    !proof.isBusy &&
    wallet.isConnected &&
    !wallet.isBusy;

  const proofStatus = proof.job?.status;
  const jobClaimStatus = proof.job?.claim.status;
  let claimStatus: "idle" | "submitting" | "succeeded" | "failed" = "idle";
  if (proofStatus === "succeeded" && jobClaimStatus) {
    if (jobClaimStatus === "succeeded") {
      claimStatus = "succeeded";
    } else if (jobClaimStatus === "failed") {
      claimStatus = "failed";
    } else {
      // queued | submitting | retrying all map to "submitting" in this UI.
      claimStatus = "submitting";
    }
  }
  const claimTxHash = proof.job?.claim.txHash ?? null;
  const claimError = claimStatus === "failed" ? (proof.job?.claim.lastError ?? null) : null;

  let currentStep: GameFlowStep = "play";
  if (proof.job?.status === "succeeded") {
    currentStep = "earn";
  } else if (proof.isBusy) {
    currentStep = "prove";
  } else if (latestRun && !wallet.isConnected) {
    currentStep = "wallet";
  } else if (latestRun) {
    currentStep = "score";
  }

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
