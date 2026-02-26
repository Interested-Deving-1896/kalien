import { useCallback, useEffect, useMemo, useState } from "react";
import type { CompletedGameRun } from "../components/AsteroidsCanvas";
import { getProofArtifact } from "../proof/api";
import { extractGroth16SealFromArtifact, packJournalRaw } from "../proof/artifact";
import {
  explainScoreSubmissionError,
  getScoreContractIdFromEnv,
  submitScoreTransaction,
} from "../chain/score";
import { deserializeTape } from "../game/tape";
import { useWallet, type UseWalletReturn } from "./useWallet";
import { useGatewayHealth, type UseGatewayHealthReturn } from "./useGatewayHealth";
import { useProofJob, type UseProofJobReturn } from "./useProofJob";
import { useTokenBalance, type UseTokenBalanceReturn } from "./useTokenBalance";

export type GameFlowStep = "play" | "score" | "wallet" | "prove" | "earn";

export interface UseGameFlowReturn {
  currentStep: GameFlowStep;
  wallet: UseWalletReturn;
  proof: UseProofJobReturn;
  balance: UseTokenBalanceReturn;
  health: UseGatewayHealthReturn;
  latestRun: CompletedGameRun | null;
  hasPositiveScore: boolean;
  handleGameOver: (run: CompletedGameRun) => void;
  submitForProof: () => Promise<void>;
  submitOnChain: () => Promise<void>;
  loadTapeFile: () => void;
  claimStatus: "idle" | "submitting" | "succeeded" | "failed";
  claimTxHash: string | null;
  claimError: string | null;
  canSubmitForProof: boolean;
  canSubmitOnChain: boolean;
  scoreContractId: string | null;
}

export function useGameFlow(): UseGameFlowReturn {
  const [latestRun, setLatestRun] = useState<CompletedGameRun | null>(null);
  const [claimStatus, setClaimStatus] = useState<"idle" | "submitting" | "succeeded" | "failed">(
    "idle",
  );
  const [claimTxHash, setClaimTxHash] = useState<string | null>(null);
  const [claimError, setClaimError] = useState<string | null>(null);

  const wallet = useWallet();
  const health = useGatewayHealth();

  const balance = useTokenBalance(wallet.address);

  const proof = useProofJob({
    onClaimSucceeded: balance.refresh,
  });

  const scoreContractId = getScoreContractIdFromEnv();
  const hasPositiveScore = (latestRun?.record.finalScore ?? 0) > 0;

  // Feed activeJob from gateway health into proof job
  useEffect(() => {
    if (health.activeJob) {
      proof.setJobFromExternal(health.activeJob);
    }
  }, [health.activeJob, proof.setJobFromExternal]);

  // Reset claim state when proof job changes
  useEffect(() => {
    setClaimStatus("idle");
    setClaimError(null);
    setClaimTxHash(null);
  }, [proof.job?.jobId]);

  // Sync claim state when auto-claim succeeds via polling
  useEffect(() => {
    if (proof.job?.claim.status === "succeeded") {
      setClaimStatus("succeeded");
      setClaimError(null);
      if (proof.job.claim.txHash) {
        setClaimTxHash(proof.job.claim.txHash);
      }
      void balance.refresh();
    }
  }, [proof.job?.claim.status, proof.job?.claim.txHash, balance.refresh]);

  const handleGameOver = useCallback(
    (run: CompletedGameRun) => {
      setLatestRun(run);
      proof.clearError();
      proof.clearIfTerminal();
    },
    [proof.clearError, proof.clearIfTerminal],
  );

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
          setLatestRun({
            record: {
              seed: tape.header.seed,
              inputs: tape.inputs,
              finalScore: tape.footer.finalScore,
              finalRngState: tape.footer.finalRngState,
            },
            frameCount: tape.header.frameCount,
            endedAtMs: Date.now(),
          });
          proof.clearError();
          proof.clearIfTerminal();
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          proof.setError(`failed to load tape file: ${detail}`);
        }
      })();
    });
    input.click();
  }, [proof.clearError, proof.clearIfTerminal, proof.setError]);

  const submitForProof = useCallback(async () => {
    if (!latestRun) {
      return;
    }
    const success = await proof.submitRun(latestRun, wallet.address);
    if (success) {
      window.location.href = "/proofs";
    }
  }, [latestRun, proof.submitRun, wallet.address]);

  const submitOnChain = useCallback(async () => {
    if (!proof.job?.result?.summary) {
      setClaimStatus("failed");
      setClaimError("proof result is not available yet");
      return;
    }

    if (wallet.address.trim().length === 0) {
      setClaimStatus("failed");
      setClaimError("connect a smart wallet before submitting on-chain");
      return;
    }

    if (!scoreContractId) {
      setClaimStatus("failed");
      setClaimError("missing VITE_SCORE_CONTRACT_ID in frontend env");
      return;
    }

    setClaimStatus("submitting");
    setClaimError(null);
    setClaimTxHash(null);

    try {
      const artifact = await getProofArtifact(proof.job.jobId);
      const seal = extractGroth16SealFromArtifact(artifact);
      const journalRaw = packJournalRaw(proof.job.result.summary.journal);

      if (wallet.relayerMode === "disabled") {
        throw new Error("relayer is not configured for this wallet session");
      }

      const tx = await submitScoreTransaction({
        scoreContractId,
        claimantAddress: wallet.address,
        seal,
        journalRaw,
      });

      if (!tx.success) {
        throw new Error(tx.error ?? "on-chain submission failed");
      }

      setClaimStatus("succeeded");
      setClaimTxHash(tx.hash || null);
      setClaimError(null);
      void balance.refresh();
    } catch (err) {
      const detail = err instanceof Error ? err.message : "on-chain submission failed";
      setClaimStatus("failed");
      setClaimError(explainScoreSubmissionError(detail));
    }
  }, [wallet.address, wallet.relayerMode, proof.job, balance.refresh, scoreContractId]);

  const canSubmitForProof =
    Boolean(latestRun) &&
    hasPositiveScore &&
    !proof.isSubmitting &&
    !proof.isBusy &&
    wallet.isConnected &&
    !wallet.isBusy;

  const canSubmitOnChain =
    proof.hasResult &&
    wallet.isConnected &&
    !wallet.isBusy &&
    claimStatus !== "submitting" &&
    Boolean(scoreContractId);

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
    health,
    latestRun,
    hasPositiveScore,
    handleGameOver,
    submitForProof,
    submitOnChain,
    loadTapeFile,
    claimStatus,
    claimTxHash,
    claimError,
    canSubmitForProof,
    canSubmitOnChain,
    scoreContractId,
  };
}
