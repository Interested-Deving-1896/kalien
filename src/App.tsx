import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { SiteHeader } from "./components/SiteHeader";
import { AsteroidsCanvas, type CompletedGameRun } from "./components/AsteroidsCanvas";
import {
  cancelProofJob,
  getGatewayHealth,
  getProofArtifact,
  ProofApiError,
  type ClaimStatus,
  type GatewayHealthResponse,
  getProofJob,
  isTerminalProofStatus,
  submitProofJob,
  type ProofJobPublic,
  type ProofJobStatus,
} from "./proof/api";
import { deserializeTape, serializeTape, TAPE_FOOTER_SIZE, TAPE_HEADER_SIZE } from "./game/tape";
import type {
  SmartAccountConfig,
  SmartAccountRelayerMode,
  SmartWalletSession,
} from "./wallet/smartAccount";
import {
  explainScoreSubmissionError,
  getScoreContractIdFromEnv,
  getTokenContractIdFromEnv,
  readTokenBalance,
  submitScoreTransaction,
} from "./chain/score";
import { extractGroth16SealFromArtifact, packJournalRaw } from "./proof/artifact";
import {
  GATEWAY_HEALTH_INITIAL_POLL_DELAY_MS,
  GATEWAY_HEALTH_POLL_INTERVAL_MS,
  PROOF_STATUS_ERROR_POLL_INTERVAL_MS,
  PROOF_STATUS_INITIAL_POLL_DELAY_MS,
  PROOF_STATUS_POLL_INTERVAL_MS,
  TESTNET_NETWORK_PASSPHRASE,
} from "./consts";
import { formatUtcDateTime } from "./time";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

function formatHex32(value: number): string {
  return `0x${(value >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;
}

function abbreviateHex(value: string, keep = 8): string {
  if (value.length <= keep * 2) {
    return value;
  }
  return `${value.slice(0, keep)}...${value.slice(-keep)}`;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) {
    return "0 ms";
  }

  if (ms < 1000) {
    return `${ms} ms`;
  }

  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)} s`;
  }

  const minutes = Math.floor(seconds / 60);
  const leftoverSeconds = Math.round(seconds % 60);
  return `${minutes}m ${leftoverSeconds}s`;
}

function formatWholeNumber(value: bigint): string {
  const sign = value < 0n ? "-" : "";
  const digits = (value < 0n ? -value : value).toString();
  return `${sign}${digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

function statusLabel(status: ProofJobStatus): string {
  switch (status) {
    case "queued":
      return "Queued";
    case "dispatching":
      return "Dispatching";
    case "prover_running":
      return "Running";
    case "retrying":
      return "Retrying";
    case "succeeded":
      return "Succeeded";
    case "failed":
      return "Failed";
    default:
      return status;
  }
}

function proofStatusBadgeVariant(
  status: ProofJobStatus | "idle",
): "idle" | "info" | "success" | "error" {
  switch (status) {
    case "idle":
      return "idle";
    case "queued":
    case "dispatching":
    case "retrying":
    case "prover_running":
      return "info";
    case "succeeded":
      return "success";
    case "failed":
      return "error";
    default:
      return "idle";
  }
}

function claimStatusLabel(
  status: "queued" | "submitting" | "retrying" | "succeeded" | "failed",
): string {
  switch (status) {
    case "queued":
      return "Queued";
    case "submitting":
      return "Submitting";
    case "retrying":
      return "Retrying";
    case "succeeded":
      return "Submitted";
    case "failed":
      return "Failed";
    default:
      return status;
  }
}

function isTerminalClaimStatus(status: ClaimStatus): boolean {
  return status === "succeeded" || status === "failed";
}

type WalletAction = "idle" | "restoring" | "connecting" | "creating" | "disconnecting";

function walletActionLabel(action: WalletAction, connected: boolean): string {
  if (action === "idle") {
    return connected ? "Connected" : "Not Connected";
  }

  switch (action) {
    case "restoring":
      return "Restoring";
    case "connecting":
      return "Connecting";
    case "creating":
      return "Creating";
    case "disconnecting":
      return "Disconnecting";
    default:
      return "Wallet";
  }
}

function walletBadgeVariant(
  action: WalletAction,
  connected: boolean,
): "idle" | "info" | "success" {
  if (action !== "idle") {
    return "info";
  }
  return connected ? "success" : "idle";
}

function relayerModeLabel(mode: SmartAccountRelayerMode): string {
  switch (mode) {
    case "configured":
      return "Relayer Configured";
    default:
      return "Not Configured (relayer required)";
  }
}

type SmartWalletModule = typeof import("./wallet/smartAccount");

let smartWalletModulePromise: Promise<SmartWalletModule> | null = null;

async function loadSmartWalletModule(): Promise<SmartWalletModule> {
  if (!smartWalletModulePromise) {
    smartWalletModulePromise = import("./wallet/smartAccount");
  }

  return smartWalletModulePromise;
}

const LazyLeaderboardPage = lazy(() =>
  import("./leaderboard/LeaderboardPage").then((m) => ({ default: m.LeaderboardPage })),
);

function GameApp() {
  const [latestRun, setLatestRun] = useState<CompletedGameRun | null>(null);
  const [proofJob, setProofJob] = useState<ProofJobPublic | null>(null);
  const [proofError, setProofError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [walletSession, setWalletSession] = useState<SmartWalletSession | null>(null);
  const [walletAction, setWalletAction] = useState<WalletAction>("idle");
  const [walletUserName, setWalletUserName] = useState("");
  const [walletError, setWalletError] = useState<string | null>(null);
  const [walletConfig, setWalletConfig] = useState<Pick<SmartAccountConfig, "networkPassphrase">>({
    networkPassphrase: TESTNET_NETWORK_PASSPHRASE,
  });
  const [walletRelayerMode, setWalletRelayerMode] = useState<SmartAccountRelayerMode>("disabled");
  const [gatewayHealth, setGatewayHealth] = useState<GatewayHealthResponse | null>(null);
  const [gatewayHealthError, setGatewayHealthError] = useState<string | null>(null);
  const [manualClaimStatus, setManualClaimStatus] = useState<
    "idle" | "submitting" | "succeeded" | "failed"
  >("idle");
  const [manualClaimTxHash, setManualClaimTxHash] = useState<string | null>(null);
  const [manualClaimError, setManualClaimError] = useState<string | null>(null);
  const [tokenBalance, setTokenBalance] = useState<bigint | null>(null);
  const [tokenContractId, setTokenContractId] = useState<string | null>(null);
  const [tokenBalanceError, setTokenBalanceError] = useState<string | null>(null);
  const [isRefreshingBalance, setIsRefreshingBalance] = useState(false);
  const activeProofJobId = proofJob?.jobId ?? null;
  const activeProofJobStatus = proofJob?.status ?? null;
  const activeClaimStatus = proofJob?.claim.status ?? null;
  const claimantAddress = walletSession?.contractId ?? "";
  const scoreContractId = getScoreContractIdFromEnv();
  const tokenContractOverride = getTokenContractIdFromEnv();

  const handleGameOver = useCallback((run: CompletedGameRun) => {
    setLatestRun(run);
    setProofError(null);
    setProofJob((current) => {
      if (!current) {
        return null;
      }

      return isTerminalProofStatus(current.status) ? null : current;
    });
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
          setProofError(null);
          setProofJob((current) =>
            current && isTerminalProofStatus(current.status) ? null : current,
          );
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          setProofError(`failed to load tape file: ${detail}`);
        }
      })();
    });
    input.click();
  }, []);

  const submitLatestRun = useCallback(async () => {
    if (!latestRun) {
      return;
    }
    if (latestRun.record.finalScore <= 0) {
      setProofError("zero-score runs are not accepted for proving or token minting");
      return;
    }
    if (claimantAddress.trim().length === 0) {
      setProofError("connect a smart wallet before submitting a proof");
      return;
    }

    let tapeBytes: Uint8Array;
    try {
      tapeBytes = serializeTape(
        latestRun.record.seed,
        latestRun.record.inputs,
        latestRun.record.finalScore,
        latestRun.record.finalRngState,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "failed to serialize tape";
      setProofError(message);
      return;
    }

    setIsSubmitting(true);
    setProofError(null);

    try {
      const response = await submitProofJob(tapeBytes, claimantAddress);
      setProofJob(response.job);
    } catch (error) {
      if (error instanceof ProofApiError) {
        if (error.activeJob) {
          setProofJob(error.activeJob);
        }
        setProofError(error.message);
      } else {
        setProofError("failed to submit proof job");
      }
    } finally {
      setIsSubmitting(false);
    }
  }, [claimantAddress, latestRun]);

  const connectWallet = useCallback(async () => {
    setWalletAction("connecting");
    setWalletError(null);

    try {
      const walletModule = await loadSmartWalletModule();
      const nextConfig = walletModule.getSmartAccountConfig();
      setWalletConfig({ networkPassphrase: nextConfig.networkPassphrase });
      setWalletRelayerMode(walletModule.getSmartAccountRelayerMode());
      const session = await walletModule.connectSmartWallet();
      setWalletSession(session);
      setProofError(null);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "failed to connect wallet";
      setWalletError(detail);
    } finally {
      setWalletAction("idle");
    }
  }, []);

  const createWallet = useCallback(async () => {
    setWalletAction("creating");
    setWalletError(null);

    try {
      const walletModule = await loadSmartWalletModule();
      const nextConfig = walletModule.getSmartAccountConfig();
      setWalletConfig({ networkPassphrase: nextConfig.networkPassphrase });
      setWalletRelayerMode(walletModule.getSmartAccountRelayerMode());
      const session = await walletModule.createSmartWallet(walletUserName);
      setWalletSession(session);
      setProofError(null);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "failed to create wallet";
      setWalletError(detail);
    } finally {
      setWalletAction("idle");
    }
  }, [walletUserName]);

  const disconnectWallet = useCallback(async () => {
    setWalletAction("disconnecting");
    setWalletError(null);

    try {
      const walletModule = await loadSmartWalletModule();
      const nextConfig = walletModule.getSmartAccountConfig();
      setWalletConfig({ networkPassphrase: nextConfig.networkPassphrase });
      setWalletRelayerMode(walletModule.getSmartAccountRelayerMode());
      await walletModule.disconnectSmartWallet();
      setWalletSession(null);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "failed to disconnect wallet";
      setWalletError(detail);
    } finally {
      setWalletAction("idle");
    }
  }, []);

  const cancelActiveJob = useCallback(async () => {
    if (!proofJob || isTerminalProofStatus(proofJob.status)) {
      return;
    }

    try {
      const response = await cancelProofJob(proofJob.jobId);
      setProofJob(response.job);
      setProofError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "failed to cancel job";
      setProofError(message);
    }
  }, [proofJob]);

  const refreshBalance = useCallback(async () => {
    if (claimantAddress.trim().length === 0) {
      setTokenBalance(null);
      setTokenContractId(null);
      setTokenBalanceError(null);
      return;
    }

    if (!scoreContractId && !tokenContractOverride) {
      setTokenBalance(null);
      setTokenContractId(null);
      setTokenBalanceError(
        "set VITE_SCORE_CONTRACT_ID (or VITE_TOKEN_CONTRACT_ID) to show on-chain token balance",
      );
      return;
    }

    setIsRefreshingBalance(true);
    try {
      const next = await readTokenBalance({
        walletAddress: claimantAddress,
        scoreContractId,
        tokenContractId: tokenContractOverride,
      });
      setTokenBalance(next.balance);
      setTokenContractId(next.tokenContractId);
      setTokenBalanceError(null);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "failed to load token balance";
      setTokenBalanceError(detail);
    } finally {
      setIsRefreshingBalance(false);
    }
  }, [claimantAddress, scoreContractId, tokenContractOverride]);

  const submitProvenScoreOnChain = useCallback(async () => {
    if (!proofJob?.result?.summary) {
      setManualClaimStatus("failed");
      setManualClaimError("proof result is not available yet");
      return;
    }

    if (claimantAddress.trim().length === 0) {
      setManualClaimStatus("failed");
      setManualClaimError("connect a smart wallet before submitting on-chain");
      return;
    }

    if (!scoreContractId) {
      setManualClaimStatus("failed");
      setManualClaimError("missing VITE_SCORE_CONTRACT_ID in frontend env");
      return;
    }

    setManualClaimStatus("submitting");
    setManualClaimError(null);
    setManualClaimTxHash(null);

    try {
      const artifact = await getProofArtifact(proofJob.jobId);
      const seal = extractGroth16SealFromArtifact(artifact);
      const journalRaw = packJournalRaw(proofJob.result.summary.journal);

      if (walletRelayerMode === "disabled") {
        throw new Error("relayer is not configured for this wallet session");
      }

      const tx = await submitScoreTransaction({
        scoreContractId,
        claimantAddress,
        seal,
        journalRaw,
      });

      if (!tx.success) {
        throw new Error(tx.error ?? "on-chain submission failed");
      }

      setManualClaimStatus("succeeded");
      setManualClaimTxHash(tx.hash || null);
      setManualClaimError(null);
      void refreshBalance();
    } catch (error) {
      const detail = error instanceof Error ? error.message : "on-chain submission failed";
      setManualClaimStatus("failed");
      setManualClaimError(explainScoreSubmissionError(detail));
    }
  }, [
    claimantAddress,
    proofJob,
    refreshBalance,
    scoreContractId,
    walletRelayerMode,
  ]);

  useEffect(() => {
    if (!activeProofJobId || !activeProofJobStatus) {
      return;
    }
    const keepPolling =
      !isTerminalProofStatus(activeProofJobStatus) ||
      (activeProofJobStatus === "succeeded" &&
        activeClaimStatus !== null &&
        !isTerminalClaimStatus(activeClaimStatus));
    if (!keepPolling) {
      return;
    }

    let cancelled = false;
    let timeoutId: number | null = null;

    const poll = async () => {
      try {
        const response = await getProofJob(activeProofJobId);
        if (cancelled) {
          return;
        }

        setProofJob(response.job);
        const shouldContinuePolling =
          !isTerminalProofStatus(response.job.status) ||
          (response.job.status === "succeeded" &&
            !isTerminalClaimStatus(response.job.claim.status));
        if (shouldContinuePolling) {
          timeoutId = window.setTimeout(poll, PROOF_STATUS_POLL_INTERVAL_MS);
          return;
        }
      } catch (error) {
        if (cancelled) {
          return;
        }

        const message = error instanceof Error ? error.message : "failed to refresh proof status";
        setProofError(message);
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
  }, [activeClaimStatus, activeProofJobId, activeProofJobStatus]);

  useEffect(() => {
    let cancelled = false;
    let timeoutId: number | null = null;

    const pollHealth = async () => {
      try {
        const response = await getGatewayHealth();
        if (cancelled) {
          return;
        }
        setGatewayHealth(response);
        setGatewayHealthError(null);
        if (response.active_job) {
          setProofJob((current) => current ?? response.active_job);
        }
      } catch (error) {
        if (cancelled) {
          return;
        }
        const message = error instanceof Error ? error.message : "failed to refresh gateway health";
        setGatewayHealthError(message);
      } finally {
        if (!cancelled) {
          timeoutId = window.setTimeout(pollHealth, GATEWAY_HEALTH_POLL_INTERVAL_MS);
        }
      }
    };

    timeoutId = window.setTimeout(pollHealth, GATEWAY_HEALTH_INITIAL_POLL_DELAY_MS);

    return () => {
      cancelled = true;
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const restore = async () => {
      setWalletAction("restoring");
      setWalletError(null);

      try {
        const walletModule = await loadSmartWalletModule();
        const nextConfig = walletModule.getSmartAccountConfig();
        const nextRelayerMode = walletModule.getSmartAccountRelayerMode();
        const session = await walletModule.restoreSmartWalletSession();
        if (cancelled) {
          return;
        }
        setWalletConfig({ networkPassphrase: nextConfig.networkPassphrase });
        setWalletRelayerMode(nextRelayerMode);
        setWalletSession(session);
      } catch (error) {
        if (cancelled) {
          return;
        }
        const detail = error instanceof Error ? error.message : "failed to restore wallet session";
        setWalletError(detail);
      } finally {
        if (!cancelled) {
          setWalletAction("idle");
        }
      }
    };

    void restore();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setManualClaimStatus("idle");
    setManualClaimError(null);
    setManualClaimTxHash(null);
  }, [proofJob?.jobId]);

  useEffect(() => {
    if (proofJob?.claim.status === "succeeded") {
      setManualClaimStatus("succeeded");
      setManualClaimError(null);
      if (proofJob.claim.txHash) {
        setManualClaimTxHash(proofJob.claim.txHash);
      }
      void refreshBalance();
    }
  }, [proofJob?.claim.status, proofJob?.claim.txHash, refreshBalance]);

  useEffect(() => {
    if (claimantAddress.trim().length === 0) {
      setTokenBalance(null);
      setTokenContractId(null);
      setTokenBalanceError(null);
      return;
    }

    void refreshBalance();
  }, [claimantAddress, refreshBalance]);

  const proofBusy = proofJob ? !isTerminalProofStatus(proofJob.status) : false;
  const claimBusy = manualClaimStatus === "submitting";
  const hasProofResult = Boolean(proofJob?.result?.summary);
  const hasPositiveScore = (latestRun?.record.finalScore ?? 0) > 0;
  const walletConnected = claimantAddress.trim().length > 0;
  const walletBusy = walletAction !== "idle";
  const canSubmit =
    Boolean(latestRun) &&
    hasPositiveScore &&
    !isSubmitting &&
    !proofBusy &&
    walletConnected &&
    !walletBusy;
  const canSubmitOnChain =
    hasProofResult && walletConnected && !walletBusy && !claimBusy && Boolean(scoreContractId);
  const currentStatus: ProofJobStatus | "idle" = proofJob ? proofJob.status : "idle";
  const currentStatusLabel = proofJob ? statusLabel(proofJob.status) : "Not Submitted";
  const proverHealthStatus = gatewayHealth?.prover.status ?? "degraded";
  const walletStatusText = walletActionLabel(walletAction, walletConnected);
  const balanceLabel =
    tokenBalance === null
      ? "\u2014"
      : `${formatWholeNumber(tokenBalance)} score token${tokenBalance === 1n ? "" : "s"}`;

  return (
    <main className="mx-auto grid min-h-screen max-w-[1240px] grid-rows-[1fr_auto_auto] gap-4 p-[clamp(1rem,3vw,2rem)]">
      {/* Game Canvas */}
      <section
        className="grid place-items-center rounded-xl border border-[rgba(166,255,228,0.25)] bg-[linear-gradient(180deg,rgba(12,22,30,0.7),rgba(5,12,18,0.9))] p-[clamp(0.5rem,1.5vw,0.8rem)] shadow-[0_24px_80px_rgba(0,0,0,0.55),inset_0_1px_0_rgba(255,255,255,0.08)]"
        aria-label="Asteroids game panel"
      >
        <AsteroidsCanvas onGameOver={handleGameOver} />
      </section>

      {/* Proof Panel */}
      <Card aria-live="polite">
        <CardHeader>
          <CardTitle>Proof Queue</CardTitle>
          <StatusBadge variant={proofStatusBadgeVariant(currentStatus)}>
            {currentStatusLabel}
          </StatusBadge>
        </CardHeader>

        <p className="m-0 opacity-85">
          The queue is intentionally single-active-job to match prover single-flight behavior.
        </p>

        <Accordion
          type="multiple"
          defaultValue={["gateway-health", "game-run", "job-details"]}
        >
          {/* Gateway Health */}
          <AccordionItem value="gateway-health">
            <AccordionTrigger>Gateway Health</AccordionTrigger>
            <AccordionContent>
              <div
                className={`grid gap-1 rounded-lg border p-2.5 ${
                  proverHealthStatus === "compatible"
                    ? "border-[rgba(122,231,174,0.35)] bg-[rgba(10,36,29,0.45)]"
                    : "border-[rgba(255,165,129,0.35)] bg-[rgba(42,22,15,0.42)]"
                }`}
              >
                <p className="m-0 text-sm leading-snug">
                  <strong>Gateway Health:</strong>{" "}
                  {gatewayHealth ? (
                    gatewayHealth.prover.status === "compatible" ? (
                      <>compatible</>
                    ) : (
                      <>degraded</>
                    )
                  ) : (
                    "loading"
                  )}
                </p>
                {gatewayHealth?.prover.status === "compatible" ? (
                  <>
                    <p className="m-0 text-sm leading-snug">
                      <strong>Rules:</strong> {gatewayHealth.prover.ruleset} /{" "}
                      {gatewayHealth.prover.rules_digest_hex.toUpperCase()}
                    </p>
                    <p className="m-0 text-sm leading-snug">
                      <strong>Prover Image:</strong>{" "}
                      <code>{abbreviateHex(gatewayHealth.prover.image_id)}</code>
                      {gatewayHealth.expected.image_id ? " (pinned)" : ""}
                    </p>
                  </>
                ) : null}
                {gatewayHealth?.prover.status === "degraded" ? (
                  <p className="m-0 text-sm text-warning">
                    <strong>Health Error:</strong> {gatewayHealth.prover.error}
                  </p>
                ) : null}
                {gatewayHealthError ? (
                  <p className="m-0 text-sm text-warning">
                    <strong>Health Polling:</strong> {gatewayHealthError}
                  </p>
                ) : null}
              </div>
            </AccordionContent>
          </AccordionItem>

          {/* Game Run Metadata */}
          <AccordionItem value="game-run">
            <AccordionTrigger>Game Run</AccordionTrigger>
            <AccordionContent>
              {latestRun ? (
                <div className="grid gap-2">
                  <dl className="m-0 grid grid-cols-2 gap-2 p-0 sm:grid-cols-3 lg:grid-cols-6">
                    {[
                      ["Score", latestRun.record.finalScore.toLocaleString()],
                      ["Frames", latestRun.frameCount.toLocaleString()],
                      ["Seed", formatHex32(latestRun.record.seed)],
                      ["Final RNG", formatHex32(latestRun.record.finalRngState)],
                      [
                        "Tape Bytes",
                        (
                          TAPE_HEADER_SIZE +
                          latestRun.frameCount +
                          TAPE_FOOTER_SIZE
                        ).toLocaleString(),
                      ],
                      ["Captured", formatUtcDateTime(latestRun.endedAtMs)],
                    ].map(([label, value]) => (
                      <div
                        key={label}
                        className="rounded-lg border border-[rgba(108,159,230,0.24)] bg-[rgba(13,22,40,0.5)] px-2 py-1.5"
                      >
                        <dt className="m-0 text-xs uppercase tracking-[0.06em] text-[rgba(146,182,233,0.9)]">
                          {label}
                        </dt>
                        <dd className="m-0 mt-0.5 font-display text-sm text-card-foreground">
                          {value}
                        </dd>
                      </div>
                    ))}
                  </dl>
                  {latestRun.record.finalScore <= 0 ? (
                    <p className="m-0 text-sm text-warning">
                      Zero-score runs are not accepted for proving or token minting.
                    </p>
                  ) : null}
                  {!walletConnected ? (
                    <p className="m-0 text-sm text-warning">
                      Connect a smart wallet before submitting a proof.
                    </p>
                  ) : null}
                </div>
              ) : (
                <p className="m-0 text-[rgba(171,196,232,0.88)]">
                  Finish a run to capture a replay tape for proving.
                </p>
              )}
            </AccordionContent>
          </AccordionItem>

          {/* Smart Wallet */}
          <AccordionItem value="smart-wallet">
            <AccordionTrigger>Smart Wallet</AccordionTrigger>
            <AccordionContent>
              <div className="grid gap-2.5 rounded-lg border border-[rgba(108,159,230,0.28)] bg-[rgba(9,18,33,0.6)] p-2.5">
                <div className="flex flex-col items-start justify-between gap-2.5 sm:flex-row">
                  <div className="grid gap-1">
                    <h3 className="m-0 font-display text-sm tracking-[0.04em] uppercase">
                      Smart Wallet
                    </h3>
                    <p className="m-0 text-sm text-[rgba(181,208,241,0.92)]">
                      Proof claims are relayed on-chain to the connected smart-account address.
                    </p>
                  </div>
                  <StatusBadge variant={walletBadgeVariant(walletAction, walletConnected)}>
                    {walletStatusText}
                  </StatusBadge>
                </div>

                {!walletConnected ? (
                  <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
                    <Input
                      type="text"
                      placeholder="Username for passkey (optional)"
                      value={walletUserName}
                      onChange={(event) => setWalletUserName(event.target.value)}
                      disabled={walletBusy}
                      className="flex-1 sm:min-w-[220px]"
                    />
                    <Button onClick={createWallet} disabled={walletBusy} size="sm">
                      {walletAction === "creating" ? "Creating Wallet..." : "Create Wallet"}
                    </Button>
                    <Button onClick={connectWallet} disabled={walletBusy} size="sm">
                      {walletAction === "connecting" || walletAction === "restoring"
                        ? "Connecting..."
                        : "Connect Wallet"}
                    </Button>
                  </div>
                ) : (
                  <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
                    <Button onClick={disconnectWallet} disabled={walletBusy} size="sm">
                      {walletAction === "disconnecting" ? "Disconnecting..." : "Disconnect Wallet"}
                    </Button>
                  </div>
                )}

                <div className="grid gap-1.5">
                  <label
                    htmlFor="claimant-address"
                    className="text-xs uppercase tracking-[0.06em] text-[rgba(146,182,233,0.9)]"
                  >
                    Claimant Address
                  </label>
                  <Input
                    id="claimant-address"
                    type="text"
                    placeholder="Connect wallet to set claimant address"
                    readOnly
                    spellCheck={false}
                    value={claimantAddress}
                  />
                </div>

                <div className="grid gap-1.5 rounded-lg border border-[rgba(108,159,230,0.3)] bg-[rgba(12,26,45,0.5)] p-2.5">
                  <div className="flex flex-col items-stretch justify-between gap-2 sm:flex-row sm:items-center">
                    <p className="m-0 text-sm">
                      <strong>Won Balance:</strong> {balanceLabel}
                    </p>
                    <Button
                      size="sm"
                      onClick={() => void refreshBalance()}
                      disabled={!walletConnected || isRefreshingBalance}
                    >
                      {isRefreshingBalance ? "Refreshing..." : "Refresh Balance"}
                    </Button>
                  </div>
                  {tokenContractId ? (
                    <p className="m-0 text-sm text-[rgba(171,196,232,0.9)]">
                      <strong>Token Contract:</strong>{" "}
                      <code>{abbreviateHex(tokenContractId, 10)}</code>
                    </p>
                  ) : null}
                  {tokenBalanceError ? (
                    <p className="m-0 text-sm text-warning">
                      <strong>Balance:</strong> {tokenBalanceError}
                    </p>
                  ) : null}
                </div>

                <div className="grid gap-1 text-sm text-[rgba(171,196,232,0.9)]">
                  <span>
                    <strong>Network:</strong> {walletConfig.networkPassphrase}
                  </span>
                  <span>
                    <strong>Relayer:</strong> {relayerModeLabel(walletRelayerMode)}
                  </span>
                </div>

                {walletSession ? (
                  <p className="m-0 text-sm text-[rgba(171,196,232,0.9)]">
                    <strong>Credential:</strong>{" "}
                    <code className="text-card-foreground">
                      {abbreviateHex(walletSession.credentialId, 10)}
                    </code>
                  </p>
                ) : null}
                {walletError ? (
                  <p className="m-0 text-sm text-warning">
                    <strong>Wallet:</strong> {walletError}
                  </p>
                ) : null}
              </div>
            </AccordionContent>
          </AccordionItem>

          {/* Job Details */}
          {proofJob ? (
            <AccordionItem value="job-details">
              <AccordionTrigger>Job Details</AccordionTrigger>
              <AccordionContent>
                <div className="grid gap-1.5 rounded-lg border border-[rgba(104,161,237,0.28)] bg-[rgba(9,18,33,0.7)] p-2.5">
                  <p className="m-0 text-sm leading-relaxed">
                    <strong>Job ID:</strong> <code className="break-all">{proofJob.jobId}</code>
                  </p>
                  <p className="m-0 text-sm leading-relaxed">
                    <strong>Created:</strong> {formatUtcDateTime(proofJob.createdAt)}
                  </p>
                  <p className="m-0 text-sm leading-relaxed">
                    <strong>Updated:</strong> {formatUtcDateTime(proofJob.updatedAt)}
                  </p>
                  {proofJob.completedAt ? (
                    <p className="m-0 text-sm leading-relaxed">
                      <strong>Completed:</strong> {formatUtcDateTime(proofJob.completedAt)}
                    </p>
                  ) : null}
                  <p className="m-0 text-sm leading-relaxed">
                    <strong>Queue Attempts:</strong> {proofJob.queue.attempts}
                    {proofBusy ? (
                      <Button
                        variant="destructive-outline"
                        size="xs"
                        className="ml-2"
                        onClick={cancelActiveJob}
                      >
                        Cancel
                      </Button>
                    ) : null}
                  </p>
                  {proofJob.queue.lastError ? (
                    <p className="m-0 text-sm text-warning">
                      <strong>Last Retry Reason:</strong> {proofJob.queue.lastError}
                    </p>
                  ) : null}
                  {proofJob.result?.summary ? (
                    <div className="mt-1 grid gap-1 border-t border-[rgba(97,167,132,0.4)] pt-2">
                      <p className="m-0 text-sm">
                        <strong>Proof Time:</strong>{" "}
                        {formatDuration(proofJob.result.summary.elapsedMs)}
                      </p>
                      <p className="m-0 text-sm">
                        <strong>Receipt:</strong>{" "}
                        {proofJob.result.summary.producedReceiptKind ??
                          proofJob.result.summary.requestedReceiptKind}
                      </p>
                      <p className="m-0 text-sm">
                        <strong>Verified Score:</strong>{" "}
                        {proofJob.result.summary.journal.final_score.toLocaleString()}
                      </p>
                      <p className="m-0 text-sm">
                        <strong>Verified Frames:</strong>{" "}
                        {proofJob.result.summary.journal.frame_count.toLocaleString()}
                      </p>
                      <p className="m-0 text-sm">
                        <strong>Segments:</strong>{" "}
                        {proofJob.result.summary.stats.segments.toLocaleString()}
                      </p>
                      <p className="m-0 text-sm">
                        <strong>Claim:</strong> {claimStatusLabel(proofJob.claim.status)}
                      </p>
                      {proofJob.claim.txHash ? (
                        <p className="m-0 text-sm">
                          <strong>Tx Hash:</strong> <code>{proofJob.claim.txHash}</code>
                        </p>
                      ) : null}
                      <p className="m-0 text-sm">
                        <strong>Manual Submit:</strong>{" "}
                        {manualClaimStatus === "idle"
                          ? "not submitted"
                          : manualClaimStatus === "submitting"
                            ? "submitting"
                            : manualClaimStatus}
                      </p>
                      <p className="m-0 text-sm">
                        <strong>Manual Path:</strong> Relayer (Fee Sponsored)
                      </p>
                      {manualClaimTxHash ? (
                        <p className="m-0 text-sm">
                          <strong>Manual Tx:</strong> <code>{manualClaimTxHash}</code>
                        </p>
                      ) : null}
                      {manualClaimError ? (
                        <p className="m-0 text-sm text-warning">
                          <strong>Manual Claim:</strong> {manualClaimError}
                        </p>
                      ) : null}
                      {!scoreContractId ? (
                        <p className="m-0 text-sm text-warning">
                          <strong>Manual Claim:</strong> set VITE_SCORE_CONTRACT_ID in frontend env
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                  {proofJob.claim.lastError ? (
                    <p className="m-0 text-sm text-warning">
                      <strong>Auto Claim:</strong> {proofJob.claim.lastError}
                    </p>
                  ) : null}
                  {proofJob.error ? (
                    <p className="m-0 text-sm text-[#ffabab]">
                      <strong>Failure:</strong> {proofJob.error}
                    </p>
                  ) : null}
                </div>
              </AccordionContent>
            </AccordionItem>
          ) : null}
        </Accordion>

        {/* Proof Actions (always visible, not in accordion) */}
        <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:flex-wrap sm:items-center">
          <Button onClick={loadTapeFile} disabled={proofBusy}>
            Load Tape
          </Button>
          <Button onClick={submitLatestRun} disabled={!canSubmit}>
            {isSubmitting ? "Submitting Tape..." : "Submit For Proof"}
          </Button>
          {hasProofResult ? (
            <Button onClick={submitProvenScoreOnChain} disabled={!canSubmitOnChain}>
              {manualClaimStatus === "submitting"
                ? "Submitting On-chain..."
                : "Submit Proven Score On-chain"}
            </Button>
          ) : null}
          {proofJob?.result ? (
            <Button
              onClick={async () => {
                const res = await fetch(`/api/proofs/jobs/${proofJob.jobId}/result`);
                const blob = new Blob([await res.text()], { type: "application/json" });
                const url = URL.createObjectURL(blob);
                window.open(url, "_blank");
                URL.revokeObjectURL(url);
              }}
            >
              Open Raw Proof JSON
            </Button>
          ) : null}
        </div>

        {proofError ? <p className="m-0 text-sm text-[#ffabab]">{proofError}</p> : null}
      </Card>

      {/* Controls Footnote */}
      <section className="text-center text-sm leading-relaxed opacity-85">
        <p>
          Controls: <strong className="font-display font-semibold text-[#d6fff0]">Arrow Keys</strong>{" "}
          move and turn, <strong className="font-display font-semibold text-[#d6fff0]">Space</strong>{" "}
          fires,
          <strong className="font-display font-semibold text-[#d6fff0]"> P</strong> pauses,{" "}
          <strong className="font-display font-semibold text-[#d6fff0]">R</strong> restarts,{" "}
          <strong className="font-display font-semibold text-[#d6fff0]">D</strong> saves a tape,
          <strong className="font-display font-semibold text-[#d6fff0]"> Esc</strong> returns to menu.
        </p>
      </section>
    </main>
  );
}

function App() {
  return (
    <>
      <SiteHeader />
      {window.location.pathname.startsWith("/leaderboard") ? (
        <Suspense>
          <LazyLeaderboardPage />
        </Suspense>
      ) : (
        <GameApp />
      )}
    </>
  );
}

export default App;
