import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import {
  getLeaderboard,
  LeaderboardApiError,
  type LeaderboardPageResponse,
  type LeaderboardWindow,
} from "@/leaderboard/api";
import { formatUtcDateTime, timeAgo } from "@/lib/time";
import { toNullableTrimmed } from "@/lib/validation";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { ErrorMessage } from "@/components/shared/ErrorMessage";
import { Link } from "@/components/shared/Link";
import { Pagination } from "@/components/shared/Pagination";
import { RelativeTime } from "./RelativeTime";
import { TimeWindowPicker, RankingsSearch } from "./LeaderboardFilters";
import { RankingsTable } from "./RankingsTable";
import { PageHero } from "@/components/shared/PageHero";
import { useWalletContext } from "@/contexts/WalletContext";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { AUTO_REFRESH_LEADERBOARD_MS } from "@/consts";

export function LeaderboardListView() {
  useDocumentTitle("Leaderboard", {
    description:
      "Explore rolling and all-time Kalien leaderboard rankings from proved, on-chain verified runs.",
    path: "/leaderboard",
  });
  const { wallet } = useWalletContext();
  const [windowKey, setWindowKey] = useState<LeaderboardWindow>("all");
  const [offset, setOffset] = useState(0);
  const [limit] = useState(25);
  const [searchInput, setSearchInput] = useState("");
  const [findAddress, setFindAddress] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [leaderboard, setLeaderboard] = useState<LeaderboardPageResponse | null>(null);
  const [lastRefreshAt, setLastRefreshAt] = useState<string | null>(null);

  const fetchLeaderboard = useCallback(
    (silent: boolean) => {
      if (!silent) {
        setLoading(true);
        setError(null);
      }

      void (async () => {
        try {
          const response = await getLeaderboard({
            window: windowKey,
            limit,
            offset,
            address: findAddress,
          });
          setLeaderboard(response);
          setLastRefreshAt(new Date().toISOString());
          if (!silent) {
            setError(null);
          }
        } catch (reason) {
          if (!silent) {
            const detail =
              reason instanceof LeaderboardApiError || reason instanceof Error
                ? reason.message
                : "failed to load leaderboard";
            setError(detail);
          }
        } finally {
          if (!silent) {
            setLoading(false);
          }
        }
      })();
    },
    [findAddress, limit, offset, windowKey],
  );

  const fetchLeaderboardRef = useRef(fetchLeaderboard);
  fetchLeaderboardRef.current = fetchLeaderboard;

  // Primary data fetch
  useEffect(() => {
    fetchLeaderboardRef.current(false);
  }, [findAddress, limit, offset, windowKey]);

  // Auto-refresh (paused when tab is hidden)
  useEffect(() => {
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") {
        fetchLeaderboardRef.current?.(true);
      }
    }, AUTO_REFRESH_LEADERBOARD_MS);
    return () => clearInterval(interval);
  }, []);

  const applyFind = useCallback(() => {
    const next = toNullableTrimmed(searchInput);
    setFindAddress(next);
    setOffset(0);
  }, [searchInput]);

  const clearFind = useCallback(() => {
    setSearchInput("");
    setFindAddress(null);
    setOffset(0);
  }, []);

  const findMe = useCallback(() => {
    if (!wallet.address) return;
    setSearchInput(wallet.address);
    setFindAddress(wallet.address);
    setOffset(0);
  }, [wallet.address]);

  // Derived values
  const hasHistoricalData =
    (leaderboard?.window !== "all" &&
      leaderboard?.entries.length === 0 &&
      (leaderboard?.ingestion?.total_events ?? 0) > 0) ||
    false;
  const isEmptyAllTime =
    leaderboard?.window === "all" &&
    leaderboard.entries.length === 0 &&
    (leaderboard.ingestion?.total_events ?? 0) === 0;

  return (
    <>
      <PageHero
        title="Leaderboard"
        subtitle="Rolling 10m, 24h, and all-time rankings from proved runs."
      >
        <div className="flex items-center gap-2">
          {leaderboard?.ingestion?.last_synced_at ? (
            <StatusBadge
              variant={
                Date.now() - new Date(leaderboard.ingestion.last_synced_at).getTime() < 30 * 60_000
                  ? "success"
                  : "muted"
              }
              title={formatUtcDateTime(leaderboard.ingestion.last_synced_at)}
            >
              Synced <RelativeTime value={leaderboard.ingestion.last_synced_at} />
            </StatusBadge>
          ) : (
            <StatusBadge variant="muted">Sync in progress</StatusBadge>
          )}
          <Button
            size="sm"
            onClick={() => fetchLeaderboard(false)}
            disabled={loading}
            title={lastRefreshAt ? `Last refreshed ${timeAgo(lastRefreshAt)}` : "Refresh"}
          >
            <RefreshCw className="size-3.5" />
            Refresh
          </Button>
        </div>
      </PageHero>

      <ErrorMessage message={error} />

      {/* Single Rankings Card — everything lives here */}
      <Card className="animate-rise">
        {/* Toolbar: time picker left, search right */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <TimeWindowPicker
            windowKey={windowKey}
            onWindowChange={(w) => {
              setWindowKey(w);
              setOffset(0);
            }}
          />
          <RankingsSearch
            searchInput={searchInput}
            onSearchChange={setSearchInput}
            onFind={applyFind}
            onClear={clearFind}
            onFindMe={wallet.isConnected ? findMe : null}
            findActive={findAddress !== null}
          />
        </div>

        {/* Your rank callout */}
        {leaderboard?.me ? (
          <div className="flex items-center gap-2 rounded-lg border border-secondary/25 bg-[rgba(26,108,71,0.12)] px-3 py-2">
            <span className="text-sm text-secondary">
              Your Rank: <strong>#{leaderboard.me.rank}</strong> (
              {leaderboard.me.score.toLocaleString()} pts)
            </span>
          </div>
        ) : findAddress ? (
          <div className="rounded-lg border border-border/30 bg-[rgba(8,19,34,0.5)] px-3 py-2">
            <span className="text-sm text-muted-foreground">
              Address not ranked in this window.
            </span>
          </div>
        ) : null}

        {/* Historical data nudge */}
        {hasHistoricalData ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-dashed border-[rgba(120,181,248,0.35)] bg-[rgba(8,19,34,0.62)] px-3 py-2">
            <p className="m-0 text-sm text-text-soft">
              No proved runs landed in this short window. Historical rankings still exist.
            </p>
            <Button
              size="sm"
              onClick={() => {
                setWindowKey("all");
                setOffset(0);
              }}
            >
              Show All-Time
            </Button>
          </div>
        ) : null}

        {/* Table or empty states */}
        {loading && !leaderboard ? (
          <RankingsTable entries={[]} isLoading />
        ) : isEmptyAllTime ? (
          <div className="grid justify-items-center gap-2 rounded-lg border border-dashed border-[rgba(120,181,248,0.35)] bg-[rgba(8,19,34,0.62)] p-6 text-center">
            <p className="m-0 text-text-soft">No proved runs yet.</p>
            <p className="m-0 text-text-soft">Play the game and prove your score to appear here.</p>
            <Button variant="active" asChild>
              <Link href="/" className="no-underline">
                Play Now
              </Link>
            </Button>
          </div>
        ) : leaderboard && leaderboard.entries.length === 0 ? (
          <p className="m-0 text-text-soft">No proved runs in this window yet.</p>
        ) : leaderboard ? (
          <RankingsTable
            entries={leaderboard.entries}
            highlightAddress={leaderboard.me?.claimantAddress}
          />
        ) : null}

        {/* Pagination */}
        {leaderboard && leaderboard.entries.length > 0 && (
          <Pagination
            offset={leaderboard.pagination.offset}
            limit={limit}
            total={leaderboard.pagination.total}
            nextOffset={leaderboard.pagination.next_offset}
            onOffsetChange={setOffset}
            disabled={loading}
          />
        )}
      </Card>
    </>
  );
}
