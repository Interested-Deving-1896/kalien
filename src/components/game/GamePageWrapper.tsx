import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CheckCircle2 from "lucide-react/dist/esm/icons/check-circle-2";
import Clock from "lucide-react/dist/esm/icons/clock";
import ExternalLink from "lucide-react/dist/esm/icons/external-link";
import Play from "lucide-react/dist/esm/icons/play";
import RotateCcw from "lucide-react/dist/esm/icons/rotate-ccw";
import Trophy from "lucide-react/dist/esm/icons/trophy";
import X from "lucide-react/dist/esm/icons/x";
import { useGameFlow, type GameFlowStep } from "@/hooks/useGameFlow";
import { GamePanel } from "@/components/game/GamePanel";
import { StepIndicator, type Step } from "@/components/proof/StepIndicator";
import { WalletConnect } from "@/components/wallet/WalletConnect";
import { SubmitScore } from "@/components/submit/SubmitScore";
import { PageShell } from "@/components/shared/PageShell";
import { Link } from "@/components/shared/Link";
import { useBalanceState, useWalletState } from "@/contexts/WalletContext";
import { ProofProgress } from "@/components/proof/ProofProgress";
import { Button } from "@/components/ui/button";
import { formatFramesAsTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { HIGH_SCORE_THRESHOLD } from "@/consts";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { navigate, useLocation } from "@/hooks/useLocation";
import { useSeed } from "@/hooks/useSeed";
import type { CompletedGameRun } from "@/game/types";

const FLOW_STEPS: Step[] = [
  { key: "play", label: "Play" },
  { key: "score", label: "Score" },
  { key: "prove", label: "Prove" },
  { key: "earn", label: "Earn" },
];

function completedSteps(current: GameFlowStep): string[] {
  const order: GameFlowStep[] = ["play", "score", "wallet", "prove", "earn"];
  const currentIdx = order.indexOf(current);
  const displayIdx = current === "wallet" ? 1 : currentIdx;
  return FLOW_STEPS.filter((_, i) => i < displayIdx).map((s) => s.key);
}

function displayStepKey(step: GameFlowStep): string {
  return step === "wallet" ? "score" : step;
}

function formatCountdown(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT")
  );
}

function getRunKey(flow: ReturnType<typeof useGameFlow>): string | null {
  const run = flow.latestRun;
  if (!run) {
    return null;
  }
  return [run.endedAtMs, run.frameCount, run.record.seedId >>> 0, run.record.finalScore >>> 0].join(
    ":",
  );
}

function shouldHoldForNextSeed(
  currentSeedId: number | null,
  lastCompletedSeedId: number | null,
): boolean {
  return (
    currentSeedId !== null && lastCompletedSeedId !== null && currentSeedId === lastCompletedSeedId
  );
}

function getEndlessModeDetail(params: {
  enabled: boolean;
  replayJobId: string | null;
  walletConnected: boolean;
  latestRun: ReturnType<typeof useGameFlow>["latestRun"];
  hasPositiveScore: boolean;
  isSubmitting: boolean;
  proofError: string | null;
  seed: number | null;
  seedId: number | null;
  secondsLeft: number;
  lastCompletedSeedId: number | null;
  recentSubmissionActive: boolean;
}): string | null {
  const nextSeedLabel = `Next ${formatCountdown(params.secondsLeft)}`;

  if (!params.enabled) {
    return null;
  }
  if (params.replayJobId) {
    return null;
  }
  if (!params.walletConnected) {
    return "Connect wallet";
  }
  if (params.latestRun && params.proofError) {
    return "Submit failed";
  }
  if (params.latestRun && params.isSubmitting) {
    return "Submitting";
  }
  if (params.latestRun) {
    if (!params.hasPositiveScore) {
      return nextSeedLabel;
    }
    return params.recentSubmissionActive ? `Run submitted | ${nextSeedLabel}` : "Submitting";
  }
  if (params.seed === null || params.seedId === null) {
    return params.recentSubmissionActive ? "Run submitted | Waiting seed" : "Waiting seed";
  }
  if (shouldHoldForNextSeed(params.seedId, params.lastCompletedSeedId)) {
    return params.recentSubmissionActive ? `Run submitted | ${nextSeedLabel}` : nextSeedLabel;
  }
  if (params.recentSubmissionActive) {
    return "Run submitted";
  }
  return null;
}

function GameOverOverlay({
  flow,
  replayJobId,
  endlessModeEnabled,
  onRestartReplay,
  onPlayLive,
}: {
  flow: ReturnType<typeof useGameFlow>;
  replayJobId: string | null;
  endlessModeEnabled: boolean;
  onRestartReplay: () => void;
  onPlayLive: () => void;
}) {
  const isReplay = flow.latestRun?.isReplay ?? false;
  const completed = completedSteps(flow.currentStep);
  const currentDisplayStep = displayStepKey(flow.currentStep);
  const showWalletConnect = !isReplay && !flow.wallet.isConnected;
  const showSubmitButton = !isReplay && flow.currentStep !== "play";
  const showProofProgress = !isReplay && (flow.proof.isBusy || flow.proof.job !== null);
  const showSuccessBanner =
    !isReplay &&
    flow.proof.job?.status === "succeeded" &&
    flow.proof.job?.claim.status === "succeeded";

  const score = flow.latestRun?.record.finalScore ?? 0;
  const isHighScore = score >= HIGH_SCORE_THRESHOLD;
  const duration = flow.latestRun ? formatFramesAsTime(flow.latestRun.frameCount) : "";

  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-[rgba(3,7,14,0.82)] backdrop-blur-sm">
      <div className="w-full max-w-sm px-4">
        <div className="flex max-h-[calc(100%-1rem)] flex-col gap-3 overflow-y-auto rounded-xl border border-border-subtle bg-[radial-gradient(circle_at_12%_8%,rgba(94,165,255,0.12),transparent_42%),linear-gradient(160deg,rgba(8,16,29,0.92),rgba(6,13,24,0.98))] p-[clamp(0.8rem,2vw,1.2rem)] shadow-elevated">
          <div className="flex items-center gap-3">
            <div
              className={cn(
                "flex size-10 shrink-0 items-center justify-center rounded-full",
                isHighScore ? "bg-secondary/15 text-secondary" : "bg-primary/15 text-primary",
              )}
            >
              <Trophy className="size-5" aria-hidden="true" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="m-0 font-display text-[0.65rem] uppercase tracking-[0.1em] text-muted-foreground">
                {isReplay ? "Replay Complete" : isHighScore ? "Amazing Score!" : "Game Over"}
              </p>
              <p
                className={cn(
                  "m-0 font-display text-2xl font-bold tracking-tight",
                  isHighScore ? "text-secondary" : "text-card-foreground",
                )}
              >
                {score.toLocaleString()}
              </p>
            </div>
            <div className="flex items-center gap-1 text-muted-foreground">
              <Clock className="size-3" aria-hidden="true" />
              <span className="text-xs">{duration}</span>
            </div>
          </div>

          {!isReplay && (
            <StepIndicator
              steps={FLOW_STEPS}
              currentStepKey={currentDisplayStep}
              completedStepKeys={completed}
            />
          )}

          {showWalletConnect && (
            <WalletConnect
              isConnected={flow.wallet.isConnected}
              isBusy={flow.wallet.isBusy}
              action={flow.wallet.action}
              address={flow.wallet.address}
              userName={flow.wallet.userName}
              error={flow.wallet.error}
              onSetUserName={flow.wallet.setUserName}
              onConnect={flow.wallet.connect}
              onCreate={flow.wallet.create}
              onDisconnect={flow.wallet.disconnect}
            />
          )}

          {showSubmitButton && !showProofProgress && (
            <SubmitScore
              onSubmit={flow.submitForProof}
              canSubmit={flow.canSubmitForProof}
              isSubmitting={flow.proof.isSubmitting}
              isConnected={flow.wallet.isConnected}
              hasPositiveScore={flow.hasPositiveScore}
            />
          )}

          {showProofProgress && (
            <ProofProgress
              status={flow.proof.status}
              friendlyStatus={flow.proof.friendlyStatus}
              isBusy={flow.proof.isBusy}
              hasResult={flow.proof.hasResult}
              error={flow.proof.error}
              elapsedMs={flow.proof.job?.result?.summary?.elapsedMs}
              verifiedScore={flow.proof.job?.result?.summary?.journal.final_score}
              onPlayAgain={endlessModeEnabled ? undefined : flow.dismissOverlay}
              claimStatus={flow.claimStatus}
              claimTxHash={flow.claimTxHash}
              claimError={flow.claimError}
              hintText={
                endlessModeEnabled
                  ? "Endless mode will queue this run now, then wait for the next seed before starting again."
                  : undefined
              }
            />
          )}

          {showSuccessBanner && (
            <div className="flex flex-col items-center gap-2 rounded-lg border border-secondary/30 bg-[rgba(26,108,71,0.15)] px-3 py-3 text-center">
              <CheckCircle2 className="size-5 text-secondary" aria-hidden="true" />
              <p className="m-0 font-display text-sm tracking-wide text-secondary">
                Verified &amp; claimed on-chain!
              </p>
              <p className="m-0 text-xs text-muted-foreground">
                Your score will appear on the leaderboard.
              </p>
              <div className="flex flex-wrap items-center justify-center gap-2">
                <Button variant="space" size="sm" asChild>
                  <Link href="/proofs" className="no-underline">
                    <ExternalLink className="size-3.5" />
                    My Proofs
                  </Link>
                </Button>
                <Button variant="space" size="sm" asChild>
                  <Link href="/leaderboard" className="no-underline">
                    <ExternalLink className="size-3.5" />
                    Leaderboard
                  </Link>
                </Button>
              </div>
            </div>
          )}

          {!flow.proof.isBusy &&
            !flow.proof.isSubmitting &&
            (isReplay ? (
              <div className="flex items-center justify-center gap-3">
                <button
                  type="button"
                  onClick={onRestartReplay}
                  className="flex cursor-pointer items-center gap-1.5 rounded-md bg-transparent px-2 py-1 text-xs text-muted-foreground outline-none transition-colors hover:text-card-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:text-card-foreground"
                >
                  <RotateCcw className="size-3" aria-hidden="true" />
                  Replay
                </button>
                <button
                  type="button"
                  onClick={replayJobId ? () => navigate("/") : onPlayLive}
                  className="flex cursor-pointer items-center gap-1.5 rounded-md bg-transparent px-2 py-1 text-xs text-muted-foreground outline-none transition-colors hover:text-card-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:text-card-foreground"
                >
                  <Play className="size-3" aria-hidden="true" />
                  Play
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={flow.dismissOverlay}
                className="mx-auto flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-2 py-1 text-xs text-muted-foreground outline-none transition-colors hover:text-card-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:text-card-foreground"
                aria-label="Dismiss and play again"
              >
                <X className="size-3" aria-hidden="true" />
                Play Again
              </button>
            ))}
        </div>
      </div>
    </div>
  );
}

export function GamePageWrapper() {
  useDocumentTitle("Play & Prove", {
    description:
      "Play deterministic Asteroids and prove your score with cryptographic verification in Kalien.",
    path: "/",
  });

  const wallet = useWalletState();
  const balance = useBalanceState();
  const flow = useGameFlow({ wallet, balance });
  const { dismissOverlay, handleGameOver: handleFlowGameOver, submitForProof } = flow;
  const { seed, seedId, secondsLeft } = useSeed();
  const gameRef = useRef<import("@/game/AsteroidsGame").AsteroidsGame | null>(null);
  const [autopilotEnabled, setAutopilotEnabled] = useState(false);
  const [endlessModeEnabled, setEndlessModeEnabled] = useState(false);
  const [autoStartSignal, setAutoStartSignal] = useState(0);
  const autoSubmittedRunKeyRef = useRef<string | null>(null);
  const autoDismissedRunKeyRef = useRef<string | null>(null);
  const submittedFeedbackRunKeyRef = useRef<string | null>(null);
  const lastCompletedSeedIdRef = useRef<number | null>(null);
  const lastAutoStartedSeedIdRef = useRef<number | null>(null);
  const waitingForNextSeedRef = useRef(false);
  const [recentSubmissionAtMs, setRecentSubmissionAtMs] = useState<number | null>(null);

  const handleGameInstance = useCallback((game: import("@/game/AsteroidsGame").AsteroidsGame) => {
    gameRef.current = game;
  }, []);

  const pathname = useLocation();
  const replayJobId = pathname.match(/^\/replay\/(.+)$/)?.[1] ?? null;
  const latestRunKey = getRunKey(flow);
  const recentSubmissionActive =
    recentSubmissionAtMs !== null && Date.now() - recentSubmissionAtMs < 6_000;
  const endlessModeDetail = useMemo(
    () =>
      getEndlessModeDetail({
        enabled: endlessModeEnabled,
        replayJobId,
        walletConnected: flow.wallet.isConnected,
        latestRun: flow.latestRun,
        hasPositiveScore: flow.hasPositiveScore,
        isSubmitting: flow.proof.isSubmitting,
        proofError: flow.proof.error,
        seed,
        seedId,
        secondsLeft,
        lastCompletedSeedId: lastCompletedSeedIdRef.current,
        recentSubmissionActive,
      }),
    [
      endlessModeEnabled,
      replayJobId,
      flow.wallet.isConnected,
      flow.latestRun,
      flow.hasPositiveScore,
      flow.proof.isSubmitting,
      flow.proof.error,
      seed,
      seedId,
      secondsLeft,
      recentSubmissionActive,
    ],
  );

  const recordSubmissionFeedback = useCallback((runKey: string) => {
    if (submittedFeedbackRunKeyRef.current === runKey) {
      return;
    }
    submittedFeedbackRunKeyRef.current = runKey;
    setRecentSubmissionAtMs(Date.now());
  }, []);

  useEffect(() => {
    if (!replayJobId) {
      const id = new URLSearchParams(window.location.search).get("replay");
      if (id) navigate(`/replay/${id}`);
    }
  }, [replayJobId]);

  useEffect(() => {
    if (!latestRunKey) {
      autoSubmittedRunKeyRef.current = null;
      autoDismissedRunKeyRef.current = null;
    }
  }, [latestRunKey]);

  useEffect(() => {
    if (!endlessModeEnabled) {
      waitingForNextSeedRef.current = false;
      autoSubmittedRunKeyRef.current = null;
    }
  }, [endlessModeEnabled]);

  const handleAutopilotStateChange = useCallback((enabled: boolean) => {
    setAutopilotEnabled(enabled);
    if (!enabled) {
      waitingForNextSeedRef.current = false;
      setEndlessModeEnabled(false);
    }
  }, []);

  const startLiveRunWithMode = useCallback(
    ({ autopilot, endless }: { autopilot: boolean; endless: boolean }) => {
      if (replayJobId || gameRef.current?.getMode() === "replay") {
        return;
      }

      waitingForNextSeedRef.current = false;
      autoSubmittedRunKeyRef.current = null;
      autoDismissedRunKeyRef.current = null;
      setRecentSubmissionAtMs(null);
      setAutopilotEnabled(autopilot);
      setEndlessModeEnabled(endless);

      const game = gameRef.current;
      if (!game) {
        setAutoStartSignal((signal) => signal + 1);
        return;
      }

      game.setAutopilotOnStart(autopilot);
      game.startNewGame();
      game.clearBufferedInput();
    },
    [replayJobId],
  );

  const handleToggleEndlessMode = useCallback(() => {
    if (replayJobId || gameRef.current?.getMode() === "replay") {
      return;
    }
    if (!autopilotEnabled) {
      setAutopilotEnabled(true);
      setEndlessModeEnabled(true);
      return;
    }
    setEndlessModeEnabled((enabled) => !enabled);
  }, [autopilotEnabled, replayJobId]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const isAutopilotHotkey = event.code === "KeyA";
      const isEndlessHotkey = event.code === "KeyE";
      const mode = gameRef.current?.getMode() ?? null;

      if (
        event.repeat ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey ||
        (!isAutopilotHotkey && !isEndlessHotkey) ||
        replayJobId ||
        mode === "replay" ||
        isEditableTarget(event.target)
      ) {
        return;
      }

      if (mode === null || mode === "menu") {
        event.preventDefault();
        startLiveRunWithMode({
          autopilot: true,
          endless: isEndlessHotkey,
        });
        return;
      }

      if (!isEndlessHotkey) {
        return;
      }

      event.preventDefault();
      handleToggleEndlessMode();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [handleToggleEndlessMode, replayJobId, startLiveRunWithMode]);

  const handleGameOver = useCallback(
    (run: CompletedGameRun) => {
      lastCompletedSeedIdRef.current = run.record.seedId >>> 0;
      handleFlowGameOver(run);
    },
    [handleFlowGameOver],
  );

  useEffect(() => {
    if (
      !endlessModeEnabled ||
      replayJobId ||
      !latestRunKey ||
      !flow.latestRun ||
      flow.hasPositiveScore
    ) {
      return;
    }
    if (autoDismissedRunKeyRef.current === latestRunKey) {
      return;
    }

    waitingForNextSeedRef.current = true;
    autoDismissedRunKeyRef.current = latestRunKey;
    dismissOverlay();
  }, [
    dismissOverlay,
    endlessModeEnabled,
    flow.hasPositiveScore,
    flow.latestRun,
    latestRunKey,
    replayJobId,
  ]);

  useEffect(() => {
    if (!endlessModeEnabled || replayJobId || !latestRunKey) {
      return;
    }
    if (!flow.hasPositiveScore || !flow.canSubmitForProof) {
      return;
    }
    if (autoSubmittedRunKeyRef.current === latestRunKey) {
      return;
    }

    let cancelled = false;
    autoSubmittedRunKeyRef.current = latestRunKey;

    void (async () => {
      const submitted = await submitForProof();
      if (cancelled || !submitted) {
        return;
      }
      recordSubmissionFeedback(latestRunKey);
      waitingForNextSeedRef.current = true;
      autoDismissedRunKeyRef.current = latestRunKey;
      dismissOverlay();
    })();

    return () => {
      cancelled = true;
    };
  }, [
    dismissOverlay,
    endlessModeEnabled,
    flow.canSubmitForProof,
    flow.hasPositiveScore,
    submitForProof,
    latestRunKey,
    recordSubmissionFeedback,
    replayJobId,
  ]);

  useEffect(() => {
    if (
      !endlessModeEnabled ||
      replayJobId ||
      !latestRunKey ||
      !flow.latestRun ||
      !flow.hasPositiveScore ||
      !flow.proof.job
    ) {
      return;
    }
    if (autoDismissedRunKeyRef.current === latestRunKey) {
      return;
    }

    recordSubmissionFeedback(latestRunKey);
    waitingForNextSeedRef.current = true;
    autoDismissedRunKeyRef.current = latestRunKey;
    dismissOverlay();
  }, [
    dismissOverlay,
    endlessModeEnabled,
    flow.hasPositiveScore,
    flow.latestRun,
    flow.proof.job,
    latestRunKey,
    recordSubmissionFeedback,
    replayJobId,
  ]);

  useEffect(() => {
    if (
      !endlessModeEnabled ||
      replayJobId ||
      flow.latestRun ||
      seed === null ||
      seedId === null ||
      !waitingForNextSeedRef.current
    ) {
      return;
    }
    const liveMode = gameRef.current?.getMode() ?? null;
    if (liveMode === "playing" || liveMode === "paused" || liveMode === "replay") {
      return;
    }
    if (shouldHoldForNextSeed(seedId, lastCompletedSeedIdRef.current)) {
      return;
    }
    if (lastAutoStartedSeedIdRef.current === seedId) {
      return;
    }

    waitingForNextSeedRef.current = false;
    lastAutoStartedSeedIdRef.current = seedId;
    setAutoStartSignal((signal) => signal + 1);
  }, [endlessModeEnabled, flow.latestRun, replayJobId, seed, seedId]);

  const handleRestartReplay = useCallback(() => {
    if (replayJobId) {
      window.location.reload();
    } else {
      gameRef.current?.restartReplay();
      dismissOverlay();
    }
  }, [replayJobId, dismissOverlay]);

  const handlePlayLive = useCallback(() => {
    gameRef.current?.exitReplay();
    dismissOverlay();
  }, [dismissOverlay]);

  const overlay = flow.latestRun ? (
    <GameOverOverlay
      flow={flow}
      replayJobId={replayJobId}
      endlessModeEnabled={endlessModeEnabled}
      onRestartReplay={handleRestartReplay}
      onPlayLive={handlePlayLive}
    />
  ) : null;

  return (
    <PageShell className="grid-rows-[auto_1fr] content-start">
      <h1 className="sr-only">Kalien: Play and prove your Asteroids score</h1>
      <GamePanel
        onGameOver={handleGameOver}
        onGameInstance={handleGameInstance}
        overlay={overlay}
        replayJobId={replayJobId}
        autopilotEnabled={autopilotEnabled}
        endlessModeEnabled={endlessModeEnabled}
        endlessModeDetail={endlessModeDetail}
        onAutopilotStateChange={handleAutopilotStateChange}
        onToggleEndlessMode={handleToggleEndlessMode}
        autoStartSignal={autoStartSignal}
      />
    </PageShell>
  );
}
