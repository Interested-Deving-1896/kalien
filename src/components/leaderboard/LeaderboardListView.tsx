import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import {
  getLeaderboard,
  LeaderboardApiError,
  type LeaderboardPageResponse,
  type LeaderboardWindow,
} from "./api";
import { formatUtcDateTime, timeAgo } from "../../time";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { ErrorMessage } from "@/components/shared/ErrorMessage";
import { RelativeTime } from "./RelativeTime";
import { TimeWindowPicker, RankingsSearch } from "./LeaderboardFilters";
import { RankingsTable } from "./RankingsTable";
import { useWalletContext } from "@/contexts/WalletContext";

const AUTO_REFRESH_MS = 60_000;

function toNullableTrimmed(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function LeaderboardListView() {
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

  const fetchLeaderboardRef = useRef<(() => void) | undefined>(undefined);

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

  fetchLeaderboardRef.current = () => fetchLeaderboard(true);

  // Primary data fetch
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    void (async () => {
      try {
        const response = await getLeaderboard({
          window: windowKey,
          limit,
          offset,
          address: findAddress,
        });
        if (!cancelled) {
          setLeaderboard(response);
          setLastRefreshAt(new Date().toISOString());
        }
      } catch (reason) {
        if (cancelled) return;
        const detail =
          reason instanceof LeaderboardApiError || reason instanceof Error
            ? reason.message
            : "failed to load leaderboard";
        setError(detail);
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [findAddress, limit, offset, windowKey]);

  // Auto-refresh (paused when tab is hidden)
  useEffect(() => {
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") {
        fetchLeaderboardRef.current?.();
      }
    }, AUTO_REFRESH_MS);
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
  const showingStart = leaderboard
    ? Math.min(leaderboard.pagination.total, leaderboard.pagination.offset + 1)
    : 0;
  const showingEnd = leaderboard
    ? Math.min(
        leaderboard.pagination.total,
        leaderboard.pagination.offset + leaderboard.entries.length,
      )
    : 0;
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
      {/* Hero Header — mirrors Proofs page style */}
      <header className="animate-rise flex flex-col items-start justify-between gap-3 rounded-xl border border-[rgba(122,185,255,0.34)] bg-[radial-gradient(circle_at_110%_0%,rgba(102,231,196,0.12),transparent_40%),linear-gradient(160deg,rgba(7,14,25,0.8),rgba(5,11,20,0.95))] p-[clamp(0.95rem,2.6vw,1.2rem)] shadow-[0_22px_70px_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.07)] sm:flex-row">
        <div>
          <h1 className="m-0 font-display text-[clamp(1.75rem,4.2vw,2.4rem)] tracking-[0.09em] uppercase [text-shadow:0_0_16px_rgba(79,196,255,0.26)]">
            Leaderboard
          </h1>
          <p className="m-0 mt-1 text-[rgba(205,238,226,0.92)]">
            Rolling 10m, 24h, and all-time rankings from proved runs.
          </p>
        </div>
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
      </header>

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
            <p className="m-0 text-sm text-[rgba(186,210,241,0.92)]">
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
            <p className="m-0 text-[rgba(186,210,241,0.92)]">No proved runs yet.</p>
            <p className="m-0 text-[rgba(186,210,241,0.92)]">
              Play the game and prove your score to appear here.
            </p>
            <Button variant="active" asChild>
              <a href="/" className="no-underline">
                Play Now
              </a>
            </Button>
          </div>
        ) : leaderboard && leaderboard.entries.length === 0 ? (
          <p className="m-0 text-[rgba(186,210,241,0.92)]">No proved runs in this window yet.</p>
        ) : leaderboard ? (
          <RankingsTable
            entries={leaderboard.entries}
            highlightAddress={leaderboard.me?.claimantAddress}
          />
        ) : null}

        {/* Pagination */}
        {leaderboard && leaderboard.entries.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              onClick={() => setOffset((current) => Math.max(0, current - limit))}
              disabled={leaderboard.pagination.offset === 0 || loading}
            >
              <ChevronLeft className="size-3.5" />
              Previous
            </Button>
            <span className="text-sm tabular-nums text-muted-foreground">
              {showingStart}&ndash;{showingEnd} of {leaderboard.pagination.total.toLocaleString()}
            </span>
            <Button
              size="sm"
              onClick={() => {
                if (leaderboard.pagination.next_offset !== null) {
                  setOffset(leaderboard.pagination.next_offset);
                }
              }}
              disabled={leaderboard.pagination.next_offset === null || loading}
            >
              Next
              <ChevronRight className="size-3.5" />
            </Button>
          </div>
        )}
      </Card>
    </>
  );
}
