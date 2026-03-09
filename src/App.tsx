import { lazy, Suspense } from "react";
import { SiteFooter } from "./components/SiteFooter";
import { SiteHeader } from "./components/SiteHeader";
import { useLocation } from "./hooks/useLocation";
import { ErrorBoundary } from "./components/shared/ErrorBoundary";
import { SuspenseFallback } from "./components/shared/SuspenseFallback";
import { WalletProvider } from "./contexts/WalletContext";

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

const LazyPublicProofsPage = lazy(() =>
  import("./components/proofs/PublicProofsPage").then((m) => ({
    default: m.PublicProofsPage,
  })),
);

const LazyGamePage = lazy(() =>
  import("./components/game/GamePageWrapper").then((m) => ({
    default: m.GamePageWrapper,
  })),
);

const LazyWalletPage = lazy(() =>
  import("./components/wallet/WalletPage").then((m) => ({
    default: m.WalletPage,
  })),
);

function App() {
  const pathname = useLocation();

  return (
    <WalletProvider>
      <SiteHeader />
      {pathname.startsWith("/leaderboard") ? (
        <ErrorBoundary key={pathname}>
          <Suspense fallback={<SuspenseFallback />}>
            <LazyLeaderboardPage />
          </Suspense>
        </ErrorBoundary>
      ) : pathname === "/proofs" ? (
        <ErrorBoundary key={pathname}>
          <Suspense fallback={<SuspenseFallback />}>
            <LazyProofsPage />
          </Suspense>
        </ErrorBoundary>
      ) : pathname.startsWith("/proofs/") ? (
        <ErrorBoundary key={pathname}>
          <Suspense fallback={<SuspenseFallback />}>
            <LazyPublicProofsPage />
          </Suspense>
        </ErrorBoundary>
      ) : pathname === "/wallet" ? (
        <ErrorBoundary key={pathname}>
          <Suspense fallback={<SuspenseFallback />}>
            <LazyWalletPage />
          </Suspense>
        </ErrorBoundary>
      ) : pathname.startsWith("/replay/") ? (
        <ErrorBoundary key={pathname}>
          <Suspense fallback={<SuspenseFallback />}>
            <LazyGamePage />
          </Suspense>
        </ErrorBoundary>
      ) : (
        <ErrorBoundary key={pathname}>
          <Suspense fallback={<SuspenseFallback />}>
            <LazyGamePage />
          </Suspense>
        </ErrorBoundary>
      )}
      <SiteFooter />
    </WalletProvider>
  );
}

export default App;
