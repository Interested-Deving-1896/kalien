import { lazy, Suspense, useMemo } from "react";
import { SiteHeader } from "./components/SiteHeader";
import { useGameFlow, type GameFlowStep } from "./hooks/useGameFlow";
import { GamePanel } from "./components/game/GamePanel";
import { ScoreCard } from "./components/game/ScoreCard";
import { StepIndicator, type Step } from "./components/proof/StepIndicator";
import { WalletConnect } from "./components/wallet/WalletConnect";
import { TokenBalance } from "./components/wallet/TokenBalance";
import { SubmitScore } from "./components/submit/SubmitScore";
import { PageShell } from "./components/shared/PageShell";

const LazyLeaderboardPage = lazy(() =>
  import("./components/leaderboard/LeaderboardPage").then((m) => ({
    default: m.LeaderboardPage,
  })),
);

const LazyProofsPage = lazy(() =>
  import("./components/proofs/ProofsPage").then((m) => ({
    default: m.ProofsPage,
  })),
);

const FLOW_STEPS: Step[] = [
  { key: "play", label: "Play" },
  { key: "score", label: "Score" },
  { key: "prove", label: "Prove" },
  { key: "earn", label: "Earn" },
];

function completedSteps(current: GameFlowStep): string[] {
  const order: GameFlowStep[] = ["play", "score", "wallet", "prove", "earn"];
  const currentIdx = order.indexOf(current);
  // "wallet" isn't a visible step - map it to "score" for display purposes
  const displayIdx = current === "wallet" ? 1 : currentIdx;
  return FLOW_STEPS.filter((_, i) => i < displayIdx).map((s) => s.key);
}

function displayStepKey(step: GameFlowStep): string {
  // "wallet" maps to "score" in the visible step indicator
  return step === "wallet" ? "score" : step;
}

function GamePage() {
  const flow = useGameFlow();

  const completed = useMemo(() => completedSteps(flow.currentStep), [flow.currentStep]);
  const currentDisplayStep = displayStepKey(flow.currentStep);
  const showSubmitButton = flow.latestRun !== null && flow.currentStep !== "play";
  const showWalletConnect = !flow.wallet.isConnected && flow.latestRun !== null;
  return (
    <PageShell className="grid-rows-[auto_1fr] content-start">
      {/* Game Canvas */}
      <GamePanel onGameOver={flow.handleGameOver} />

      {/* Post-game flow */}
      {flow.latestRun && (
        <div className="grid gap-4">
          {/* Step Indicator */}
          <StepIndicator
            steps={FLOW_STEPS}
            currentStepKey={currentDisplayStep}
            completedStepKeys={completed}
          />

          {/* Score Display */}
          <ScoreCard run={flow.latestRun} />

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
          {showSubmitButton && (
            <SubmitScore
              onSubmit={flow.submitForProof}
              canSubmit={flow.canSubmitForProof}
              isSubmitting={flow.proof.isSubmitting}
              isConnected={flow.wallet.isConnected}
              hasPositiveScore={flow.hasPositiveScore}
            />
          )}

          {/* Token Balance */}
          <TokenBalance
            formattedBalance={flow.balance.formattedBalance}
            isRefreshing={flow.balance.isRefreshing}
            error={flow.balance.error}
            isConnected={flow.wallet.isConnected}
            onRefresh={flow.balance.refresh}
          />

          {/* Connected wallet indicator (compact, when already connected) */}
          {flow.wallet.isConnected && (
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
        </div>
      )}
    </PageShell>
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
      ) : window.location.pathname.startsWith("/proofs") ? (
        <Suspense>
          <LazyProofsPage />
        </Suspense>
      ) : (
        <GamePage />
      )}
    </>
  );
}

export default App;
