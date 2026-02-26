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
import { StatCard, StatGrid } from "@/components/shared/StatCard";
import { ErrorMessage } from "@/components/shared/ErrorMessage";
import { RelativeTime } from "./RelativeTime";
import { LeaderboardFilters } from "./LeaderboardFilters";
import { RankingsTable } from "./RankingsTable";

const AUTO_REFRESH_MS = 60_000;

function windowLabel(window: LeaderboardWindow): string {
  if (window === "10m") return "10m";
  if (window === "day") return "24h";
  return "All";
}

function windowSubtitle(window: LeaderboardWindow): string {
  if (window === "10m") return "Last 10 minutes";
  if (window === "day") return "Last 24 hours";
  return "All-time history";
}

function toNullableTrimmed(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function LeaderboardListView() {
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

  // Auto-refresh
  useEffect(() => {
    const interval = setInterval(() => {
      fetchLeaderboardRef.current?.();
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
  const topEntry = leaderboard?.entries[0] ?? null;
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
      {/* Hero Header */}
      <header className="animate-rise flex flex-col items-start justify-between gap-3 rounded-xl border border-[rgba(122,185,255,0.34)] bg-[radial-gradient(circle_at_110%_0%,rgba(102,231,196,0.12),transparent_40%),linear-gradient(160deg,rgba(7,14,25,0.8),rgba(5,11,20,0.95))] p-[clamp(0.95rem,2.6vw,1.2rem)] shadow-[0_22px_70px_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.07)] sm:flex-row">
        <div>
          <h1 className="m-0 font-display text-[clamp(1.75rem,4.2vw,2.4rem)] tracking-[0.09em] uppercase [text-shadow:0_0_16px_rgba(79,196,255,0.26)]">
            Leaderboard
          </h1>
          <p className="m-0 mt-1 text-[rgba(205,238,226,0.92)]">
            Rolling 10m, 24h, and all-time rankings from proved runs.
          </p>
          <p className="m-0 mt-1 text-sm text-[rgba(186,210,241,0.92)]">
            {leaderboard
              ? `${windowSubtitle(leaderboard.window)} window`
              : "Loading current ranking window"}
          </p>
        </div>
        <div className="grid justify-items-end gap-2">
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

      {/* Filters */}
      <Card className="animate-rise">
        <LeaderboardFilters
          windowKey={windowKey}
          onWindowChange={(w) => {
            setWindowKey(w);
            setOffset(0);
          }}
          searchInput={searchInput}
          onSearchChange={setSearchInput}
          onFind={applyFind}
          onClear={clearFind}
          findActive={findAddress !== null}
        />
      </Card>

      <ErrorMessage message={error} />

      {/* Loading skeleton */}
      {loading && !leaderboard ? (
        <Card className="animate-rise">
          <h2 className="m-0 font-display text-sm tracking-[0.08em] uppercase text-[rgba(176,219,255,0.95)]">
            Rankings
          </h2>
          <RankingsTable entries={[]} isLoading />
        </Card>
      ) : null}

      {leaderboard ? (
        <>
          {/* Summary + KPIs */}
          <Card className="animate-rise">
            <div className="flex flex-wrap gap-1 gap-x-4">
              <p className="m-0">
                <strong>Window:</strong> {windowLabel(leaderboard.window)}
                {" \u00b7 "}
                <strong>Updated:</strong> <RelativeTime value={leaderboard.generated_at} />
              </p>
              <p className="m-0">
                <strong>Showing:</strong> {showingStart}-{showingEnd} of{" "}
                {leaderboard.pagination.total.toLocaleString()} players
              </p>
            </div>

            <StatGrid columns={4}>
              <StatCard
                label="Tracked Players"
                value={leaderboard.pagination.total.toLocaleString()}
              />
              <StatCard
                label="Top Score"
                value={topEntry ? topEntry.score.toLocaleString() : "n/a"}
              />
              <StatCard
                label="Event Rows"
                value={leaderboard.ingestion?.total_events?.toLocaleString() ?? "n/a"}
              />
              <StatCard
                label="Highest Ledger"
                value={leaderboard.ingestion?.highest_ledger?.toLocaleString() ?? "n/a"}
              />
            </StatGrid>

            {leaderboard.me ? (
              <p className="m-0">
                <strong>Your Rank:</strong> #{leaderboard.me.rank} (
                {leaderboard.me.score.toLocaleString()} pts)
              </p>
            ) : findAddress ? (
              <p className="m-0 text-[rgba(186,210,241,0.92)]">
                Address not ranked in this window.
              </p>
            ) : null}

            {hasHistoricalData ? (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-dashed border-[rgba(120,181,248,0.35)] bg-[rgba(8,19,34,0.62)] p-2.5">
                <p className="m-0 text-[rgba(186,210,241,0.92)]">
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
          </Card>

          {/* Rankings Table */}
          <Card className="animate-rise">
            <h2 className="m-0 font-display text-sm tracking-[0.08em] uppercase text-[rgba(176,219,255,0.95)]">
              Rankings
            </h2>
            <p className="m-0 text-[rgba(186,210,241,0.92)]">
              Rankings show one row per claimant (their best proved run in this window). Minted is
              the token delta minted for that specific submission.
            </p>
            {isEmptyAllTime ? (
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
            ) : leaderboard.entries.length === 0 ? (
              <p className="m-0 text-[rgba(186,210,241,0.92)]">
                No proved runs in this window yet.
              </p>
            ) : (
              <RankingsTable
                entries={leaderboard.entries}
                highlightAddress={leaderboard.me?.claimantAddress}
              />
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                onClick={() => setOffset((current) => Math.max(0, current - limit))}
                disabled={leaderboard.pagination.offset === 0 || loading}
              >
                <ChevronLeft className="size-3.5" />
                Previous
              </Button>
              <span className="text-sm tabular-nums text-[rgba(186,210,241,0.92)]">
                {showingStart}-{showingEnd} of {leaderboard.pagination.total.toLocaleString()}
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
          </Card>
        </>
      ) : null}
    </>
  );
}
