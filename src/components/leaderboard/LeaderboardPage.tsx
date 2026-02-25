import { useMemo } from "react";
import { PageShell } from "@/components/shared/PageShell";
import { LeaderboardListView } from "./LeaderboardListView";
import { LeaderboardPlayerView } from "./LeaderboardPlayerView";

function getPlayerAddressFromPath(pathname: string): string | null {
  const segments = pathname.split("/").filter(Boolean);
  if (segments[0] !== "leaderboard") {
    return null;
  }
  return segments[1] ?? null;
}

export function LeaderboardPage() {
  const pathname = typeof window !== "undefined" ? window.location.pathname : "/leaderboard";
  const playerAddress = useMemo(() => getPlayerAddressFromPath(pathname), [pathname]);

  return (
    <PageShell glow>
      {playerAddress ? (
        <LeaderboardPlayerView playerAddress={playerAddress} />
      ) : (
        <LeaderboardListView />
      )}
    </PageShell>
  );
}
