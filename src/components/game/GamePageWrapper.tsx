import { useMemo, useState } from "react";
import { CheckCircle2, ExternalLink, Trophy, Clock, X } from "lucide-react";
import { useGameFlow, type GameFlowStep } from "@/hooks/useGameFlow";
import { GamePanel } from "@/components/game/GamePanel";
import { StepIndicator, type Step } from "@/components/proof/StepIndicator";
import { WalletConnect } from "@/components/wallet/WalletConnect";
import { SubmitScore } from "@/components/submit/SubmitScore";
import { PageShell } from "@/components/shared/PageShell";
import { Link } from "@/components/shared/Link";
import { useWalletContext } from "@/contexts/WalletContext";
import { ProofProgress } from "@/components/proof/ProofProgress";
import { Button } from "@/components/ui/button";
import { formatFramesAsTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { HIGH_SCORE_THRESHOLD } from "@/consts";

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

function GameOverOverlay({ flow }: { flow: ReturnType<typeof useGameFlow> }) {
  const completed = useMemo(() => completedSteps(flow.currentStep), [flow.currentStep]);
  const currentDisplayStep = displayStepKey(flow.currentStep);
  const showWalletConnect = !flow.wallet.isConnected;
  const showSubmitButton = flow.currentStep !== "play";
  const showProofProgress = flow.proof.isBusy || flow.proof.job !== null;
  const showSuccessBanner =
    flow.proof.job?.status === "succeeded" && flow.proof.job?.claim.status === "succeeded";

  const score = flow.latestRun?.record.finalScore ?? 0;
  const isHighScore = score >= HIGH_SCORE_THRESHOLD;
  const duration = flow.latestRun ? formatFramesAsTime(flow.latestRun.frameCount) : "";

  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-[rgba(3,7,14,0.82)] backdrop-blur-sm">
      <div className="w-full max-w-sm px-4">
        <div className="flex max-h-[calc(100%-1rem)] flex-col gap-3 overflow-y-auto rounded-xl border border-border-subtle bg-[radial-gradient(circle_at_12%_8%,rgba(94,165,255,0.12),transparent_42%),linear-gradient(160deg,rgba(8,16,29,0.92),rgba(6,13,24,0.98))] p-[clamp(0.8rem,2vw,1.2rem)] shadow-elevated">
          {/* Score display — compact inline */}
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
                {isHighScore ? "Amazing Score!" : "Game Over"}
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

          {/* Step Indicator */}
          <StepIndicator
            steps={FLOW_STEPS}
            currentStepKey={currentDisplayStep}
            completedStepKeys={completed}
          />

          {/* Wallet Connect (only when not connected) */}
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

          {/* Submit for Proof */}
          {showSubmitButton && !showProofProgress && (
            <SubmitScore
              onSubmit={flow.submitForProof}
              canSubmit={flow.canSubmitForProof}
              isSubmitting={flow.proof.isSubmitting}
              isConnected={flow.wallet.isConnected}
              hasPositiveScore={flow.hasPositiveScore}
            />
          )}

          {/* Proof Progress */}
          {showProofProgress && (
            <ProofProgress
              status={flow.proof.status}
              friendlyStatus={flow.proof.friendlyStatus}
              isBusy={flow.proof.isBusy}
              hasResult={flow.proof.hasResult}
              error={flow.proof.error}
              elapsedMs={flow.proof.job?.result?.summary?.elapsedMs}
              verifiedScore={flow.proof.job?.result?.summary?.journal.final_score}
              onPlayAgain={flow.dismissOverlay}
              onSubmitOnChain={flow.submitOnChain}
              canSubmitOnChain={flow.canSubmitOnChain}
              claimStatus={flow.claimStatus}
              claimTxHash={flow.claimTxHash}
            />
          )}

          {/* Success state */}
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

          {/* Dismiss — restart game */}
          {!flow.proof.isBusy && !flow.proof.isSubmitting && (
            <button
              onClick={flow.dismissOverlay}
              className="mx-auto flex cursor-pointer items-center gap-1 bg-transparent text-xs text-muted-foreground transition-colors hover:text-card-foreground"
              aria-label="Dismiss and play again"
            >
              <X className="size-3" aria-hidden="true" />
              Play Again
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function GamePageWrapper() {
  const { wallet, balance } = useWalletContext();
  const flow = useGameFlow({ wallet, balance });

  const [replayJobId] = useState(() => {
    const id = new URLSearchParams(window.location.search).get("replay");
    if (id) {
      window.history.replaceState(null, "", "/");
    }
    return id;
  });

  const overlay = flow.latestRun ? <GameOverOverlay flow={flow} /> : null;

  return (
    <PageShell className="grid-rows-[auto_1fr] content-start">
      <GamePanel onGameOver={flow.handleGameOver} overlay={overlay} replayJobId={replayJobId} />
    </PageShell>
  );
}
