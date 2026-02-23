import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type ClaimStatus,
  getLeaderboard,
  getLeaderboardPlayer,
  LeaderboardApiError,
  type LeaderboardEntry,
  type LeaderboardPageResponse,
  type LeaderboardPlayerResponse,
  type LeaderboardWindow,
  updateLeaderboardProfile,
} from "./api";
import { formatUtcDateTime, timeAgo } from "../time";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "@/components/ui/table";

const AUTO_REFRESH_MS = 60_000;

function abbreviateAddress(value: string): string {
  if (value.length <= 16) {
    return value;
  }
  return `${value.slice(0, 8)}...${value.slice(-8)}`;
}

function formatHex32(value: number): string {
  return `0x${(value >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;
}

function displayName(entry: LeaderboardEntry): string {
  return entry.profile?.username?.trim() || abbreviateAddress(entry.claimantAddress);
}

function getPlayerAddressFromPath(pathname: string): string | null {
  const segments = pathname.split("/").filter(Boolean);
  if (segments[0] !== "leaderboard") {
    return null;
  }

  return segments[1] ?? null;
}

function toNullableTrimmed(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function windowLabel(window: LeaderboardWindow): string {
  if (window === "10m") {
    return "10m";
  }
  if (window === "day") {
    return "24h";
  }
  return "All";
}

function windowSubtitle(window: LeaderboardWindow): string {
  if (window === "10m") {
    return "Last 10 minutes";
  }
  if (window === "day") {
    return "Last 24 hours";
  }
  return "All-time history";
}

function claimStatusBadgeVariant(status: ClaimStatus): "success" | "error" | "info" {
  switch (status) {
    case "succeeded":
      return "success";
    case "failed":
      return "error";
    default:
      return "info";
  }
}

function rankClass(rank: number): string {
  if (rank === 1) {
    return "font-display tracking-wider font-bold text-[#ffe08f]";
  }
  if (rank === 2) {
    return "font-display tracking-wider font-bold text-[#d8ecff]";
  }
  if (rank === 3) {
    return "font-display tracking-wider font-bold text-[#ffcda2]";
  }
  return "font-display tracking-wider";
}

function formatMetric(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString() : "n/a";
}

function isSmartAccountContractAddress(address: string): boolean {
  return address.trim().startsWith("C");
}

function isSafeUrl(url: string | null | undefined): boolean {
  if (!url) {
    return false;
  }
  const trimmed = url.trim().toLowerCase();
  return trimmed.startsWith("http://") || trimmed.startsWith("https://");
}

function RelativeTime({ value }: { value: string | null | undefined }) {
  const [, forceUpdate] = useState(0);

  useEffect(() => {
    if (!value) {
      return;
    }
    const interval = setInterval(() => forceUpdate((n) => n + 1), 15_000);
    return () => clearInterval(interval);
  }, [value]);

  if (!value) {
    return <span>n/a</span>;
  }

  return <span title={formatUtcDateTime(value)}>{timeAgo(value)}</span>;
}

function SkeletonCell({ wide }: { wide?: boolean }) {
  return (
    <span
      className={cn("block h-3.5 rounded bg-primary/20 animate-pulse", wide ? "w-28" : "w-14")}
    />
  );
}

function SkeletonRows({ count, cols }: { count: number; cols: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <TableRow key={i}>
          {Array.from({ length: cols }, (__, j) => (
            <TableCell key={j}>
              <SkeletonCell wide={j === 1 || j === cols - 2} />
            </TableCell>
          ))}
        </TableRow>
      ))}
    </>
  );
}

export function LeaderboardPage() {
  const pathname = typeof window !== "undefined" ? window.location.pathname : "/leaderboard";
  const playerAddress = useMemo(() => getPlayerAddressFromPath(pathname), [pathname]);

  const [windowKey, setWindowKey] = useState<LeaderboardWindow>("all");
  const [offset, setOffset] = useState(0);
  const [limit] = useState(25);
  const [searchInput, setSearchInput] = useState("");
  const [findAddress, setFindAddress] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [leaderboard, setLeaderboard] = useState<LeaderboardPageResponse | null>(null);

  const [playerLoading, setPlayerLoading] = useState(false);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [playerData, setPlayerData] = useState<LeaderboardPlayerResponse | null>(null);
  const [profileUsername, setProfileUsername] = useState("");
  const [profileLinkUrl, setProfileLinkUrl] = useState("");
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileSaveError, setProfileSaveError] = useState<string | null>(null);
  const [profileSavedAt, setProfileSavedAt] = useState<string | null>(null);
  const [runsOffset, setRunsOffset] = useState(0);
  const [runsLimit] = useState(25);
  const [runsLoading, setRunsLoading] = useState(false);

  const [lastRefreshAt, setLastRefreshAt] = useState<string | null>(null);

  const fetchLeaderboardRef = useRef<(() => void) | undefined>(undefined);

  const fetchLeaderboard = useCallback(
    (silent: boolean) => {
      if (playerAddress) {
        return;
      }

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
    [findAddress, limit, offset, playerAddress, windowKey],
  );

  fetchLeaderboardRef.current = () => fetchLeaderboard(true);

  useEffect(() => {
    if (playerAddress) {
      return;
    }

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
        if (cancelled) {
          return;
        }
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
  }, [findAddress, limit, offset, playerAddress, windowKey]);

  useEffect(() => {
    if (playerAddress) {
      return;
    }

    const interval = setInterval(() => {
      fetchLeaderboardRef.current?.();
    }, AUTO_REFRESH_MS);

    return () => clearInterval(interval);
  }, [playerAddress]);

  useEffect(() => {
    if (!playerAddress) {
      return;
    }

    let cancelled = false;
    const isPageChange = playerData !== null;
    if (isPageChange) {
      setRunsLoading(true);
    } else {
      setPlayerLoading(true);
      setPlayerError(null);
      setProfileSaveError(null);
      setProfileSavedAt(null);
    }

    void (async () => {
      try {
        const response = await getLeaderboardPlayer(playerAddress, {
          runsLimit: runsLimit,
          runsOffset: runsOffset,
        });
        if (cancelled) {
          return;
        }
        setPlayerData(response);
        if (!isPageChange) {
          setProfileUsername(response.player.profile?.username ?? "");
          setProfileLinkUrl(response.player.profile?.linkUrl ?? "");
        }
      } catch (reason) {
        if (cancelled) {
          return;
        }
        const detail =
          reason instanceof LeaderboardApiError || reason instanceof Error
            ? reason.message
            : "failed to load player";
        setPlayerError(detail);
      } finally {
        if (!cancelled) {
          setPlayerLoading(false);
          setRunsLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- playerData excluded to avoid loop
  }, [playerAddress, runsOffset, runsLimit]);

  const applyFindMe = useCallback(() => {
    const next = toNullableTrimmed(searchInput);
    setFindAddress(next);
    setOffset(0);
  }, [searchInput]);

  const clearFindMe = useCallback(() => {
    setSearchInput("");
    setFindAddress(null);
    setOffset(0);
  }, []);

  const saveProfile = useCallback(async () => {
    if (!playerData) {
      return;
    }

    const claimantAddress = playerData.player.claimant_address;
    if (!isSmartAccountContractAddress(claimantAddress)) {
      setProfileSavedAt(null);
      setProfileSaveError(
        "profile edits are only supported for smart-account claimant contract addresses",
      );
      return;
    }

    setSavingProfile(true);
    setProfileSaveError(null);
    setProfileSavedAt(null);

    try {
      const walletModule = await import("../wallet/smartAccount");
      const walletSession =
        await walletModule.resolveSmartWalletSessionForClaimant(claimantAddress);
      const updated = await updateLeaderboardProfile(
        claimantAddress,
        {
          username: toNullableTrimmed(profileUsername),
          linkUrl: toNullableTrimmed(profileLinkUrl),
        },
        walletSession.credentialId,
      );

      setPlayerData((current) => {
        if (!current) {
          return current;
        }
        return {
          ...current,
          player: {
            ...current.player,
            profile: updated.profile,
          },
        };
      });
      setProfileSavedAt(updated.profile.updatedAt);
    } catch (reason) {
      const detail =
        reason instanceof LeaderboardApiError || reason instanceof Error
          ? reason.message
          : "failed to save profile";
      setProfileSaveError(detail);
    } finally {
      setSavingProfile(false);
    }
  }, [playerData, profileLinkUrl, profileUsername]);

  const supportsPlayerProfileAuth =
    playerData !== null && isSmartAccountContractAddress(playerData.player.claimant_address);

  /* ─── Player Profile View ─── */
  if (playerAddress) {
    return (
      <main className="leaderboard-glow mx-auto grid min-h-screen max-w-[1240px] gap-4 p-[clamp(1rem,3vw,2rem)]">
        {/* Hero Header */}
        <header className="animate-rise flex flex-col items-start justify-between gap-3 rounded-xl border border-[rgba(122,185,255,0.34)] bg-[radial-gradient(circle_at_110%_0%,rgba(102,231,196,0.12),transparent_40%),linear-gradient(160deg,rgba(7,14,25,0.8),rgba(5,11,20,0.95))] p-[clamp(0.95rem,2.6vw,1.2rem)] shadow-[0_22px_70px_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.07)] sm:flex-row">
          <div>
            <h1 className="m-0 font-display text-[clamp(1.75rem,4.2vw,2.4rem)] tracking-[0.09em] uppercase [text-shadow:0_0_16px_rgba(79,196,255,0.26)]">
              Player
            </h1>
            <p className="m-0 mt-1 text-[rgba(205,238,226,0.92)]">
              Profile, rankings, and recent proved runs.
            </p>
          </div>
          <a
            className="font-display text-sm uppercase tracking-wider text-[#9de0ff] no-underline hover:underline"
            href="/leaderboard"
          >
            Back To Leaderboard
          </a>
        </header>

        {playerLoading ? (
          <Card>
            <Table aria-label="Loading player data">
              <TableBody>
                <SkeletonRows count={3} cols={6} />
              </TableBody>
            </Table>
          </Card>
        ) : null}
        {playerError ? <p className="m-0 text-[#ffabab]">{playerError}</p> : null}

        {playerData ? (
          <>
            {/* Player Info Card */}
            <Card>
              <h2 className="m-0 font-display tracking-[0.055em] uppercase">
                {playerData.player.profile?.username ??
                  abbreviateAddress(playerData.player.claimant_address)}
              </h2>
              <p className="m-0">
                <strong>Address:</strong>{" "}
                <code className="break-all text-[rgba(190,216,249,0.92)]">
                  {playerData.player.claimant_address}
                </code>
              </p>
              {playerData.player.profile?.linkUrl &&
              isSafeUrl(playerData.player.profile.linkUrl) ? (
                <p className="m-0">
                  <strong>Link:</strong>{" "}
                  <a href={playerData.player.profile.linkUrl} target="_blank" rel="noreferrer">
                    {playerData.player.profile.linkUrl}
                  </a>
                </p>
              ) : null}
              <dl className="m-0 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {[
                  ["Total Runs", playerData.player.stats.total_runs.toLocaleString()],
                  ["Best Score", playerData.player.stats.best_score.toLocaleString()],
                  ["Total Minted", formatMetric(playerData.player.stats.total_minted)],
                ].map(([label, val]) => (
                  <div
                    key={label}
                    className="rounded-lg border border-[rgba(108,159,230,0.24)] bg-[rgba(12,22,39,0.62)] px-2 py-2"
                  >
                    <dt className="m-0 text-xs uppercase tracking-[0.06em] text-[rgba(146,182,233,0.9)]">
                      {label}
                    </dt>
                    <dd className="m-0 mt-0.5 font-display text-sm text-card-foreground">{val}</dd>
                  </div>
                ))}
                <div className="rounded-lg border border-[rgba(108,159,230,0.24)] bg-[rgba(12,22,39,0.62)] px-2 py-2">
                  <dt className="m-0 text-xs uppercase tracking-[0.06em] text-[rgba(146,182,233,0.9)]">
                    Last Played
                  </dt>
                  <dd className="m-0 mt-0.5 font-display text-sm text-card-foreground">
                    <RelativeTime value={playerData.player.stats.last_played_at} />
                  </dd>
                </div>
              </dl>
              <p className="m-0 text-[rgba(186,210,241,0.92)]">
                Leaderboard rank uses each claimant's single best proved run in the selected window;
                this page also shows your full recent run history and total minted.
              </p>
              <dl className="m-0 grid grid-cols-1 gap-2 sm:grid-cols-3">
                {[
                  ["10m Rank", playerData.player.ranks.ten_min ?? "n/a"],
                  ["24h Rank", playerData.player.ranks.day ?? "n/a"],
                  ["All-Time Rank", playerData.player.ranks.all ?? "n/a"],
                ].map(([label, val]) => (
                  <div
                    key={label}
                    className="rounded-lg border border-[rgba(108,159,230,0.24)] bg-[rgba(12,22,39,0.62)] px-2 py-2"
                  >
                    <dt className="m-0 text-xs uppercase tracking-[0.06em] text-[rgba(146,182,233,0.9)]">
                      {label}
                    </dt>
                    <dd className="m-0 mt-0.5 font-display text-sm text-card-foreground">{val}</dd>
                  </div>
                ))}
              </dl>
            </Card>

            {/* Edit Profile */}
            {supportsPlayerProfileAuth ? (
              <Card>
                <h3 className="m-0 font-display tracking-[0.055em] uppercase">Edit Profile</h3>
                <p className="m-0 text-[rgba(186,210,241,0.92)]">
                  Saving requires a passkey prompt for the claimant wallet tied to this address.
                </p>
                <div className="grid gap-2.5">
                  <label className="grid gap-1.5 text-xs uppercase tracking-[0.04em]">
                    Username
                    <Input
                      type="text"
                      value={profileUsername}
                      onChange={(event) => setProfileUsername(event.target.value)}
                      placeholder="Your leaderboard name"
                      maxLength={32}
                    />
                  </label>
                  <label className="grid gap-1.5 text-xs uppercase tracking-[0.04em]">
                    Link URL
                    <Input
                      type="url"
                      value={profileLinkUrl}
                      onChange={(event) => setProfileLinkUrl(event.target.value)}
                      placeholder="https://"
                      maxLength={240}
                    />
                  </label>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button onClick={saveProfile} disabled={savingProfile}>
                    {savingProfile ? "Saving..." : "Save Profile"}
                  </Button>
                  {profileSavedAt ? (
                    <span className="text-sm text-[rgba(186,210,241,0.92)]">
                      Saved <RelativeTime value={profileSavedAt} />
                    </span>
                  ) : null}
                </div>
                {profileSaveError ? <p className="m-0 text-[#ffabab]">{profileSaveError}</p> : null}
              </Card>
            ) : (
              <Card>
                <h3 className="m-0 font-display tracking-[0.055em] uppercase">Edit Profile</h3>
                <p className="m-0 text-[rgba(186,210,241,0.92)]">
                  Profile edits are available only for smart-account claimant contract addresses.
                </p>
              </Card>
            )}

            {/* Recent Runs */}
            <Card>
              <h3 className="m-0 font-display tracking-[0.055em] uppercase">Recent Runs</h3>
              <p className="m-0 text-[rgba(186,210,241,0.92)]">
                Recent runs includes every proved submission for this claimant (not just the best
                run).
              </p>
              {playerData.player.recent_runs.length === 0 && runsOffset === 0 ? (
                <p className="m-0 text-[rgba(186,210,241,0.92)]">No proved runs yet.</p>
              ) : (
                <>
                  <Table aria-label="Recent proved runs">
                    <TableHeader>
                      <TableRow>
                        <TableHead scope="col">Score</TableHead>
                        <TableHead scope="col">Frames</TableHead>
                        <TableHead scope="col">Minted (this run)</TableHead>
                        <TableHead scope="col">Seed</TableHead>
                        <TableHead scope="col">Completed</TableHead>
                        <TableHead scope="col">Claim</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {playerData.player.recent_runs.map((run) => (
                        <TableRow key={run.jobId}>
                          <TableCell className="text-right tabular-nums">
                            {run.score.toLocaleString()}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatMetric(run.frameCount)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatMetric(run.mintedDelta)}
                          </TableCell>
                          <TableCell className="font-display tracking-[0.04em]">
                            {formatHex32(run.seed)}
                          </TableCell>
                          <TableCell>
                            <RelativeTime value={run.completedAt} />
                          </TableCell>
                          <TableCell>
                            <StatusBadge variant={claimStatusBadgeVariant(run.claimStatus)}>
                              {run.claimStatus}
                            </StatusBadge>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      onClick={() => setRunsOffset((c) => Math.max(0, c - runsLimit))}
                      disabled={runsOffset === 0 || runsLoading}
                    >
                      Previous
                    </Button>
                    <span className="text-sm text-[rgba(186,210,241,0.92)]">
                      {runsOffset + 1}-
                      {Math.min(
                        runsOffset + playerData.player.recent_runs.length,
                        playerData.player.runs_pagination.total,
                      )}{" "}
                      of {playerData.player.runs_pagination.total}
                    </span>
                    <Button
                      size="sm"
                      onClick={() => {
                        if (playerData.player.runs_pagination.next_offset !== null) {
                          setRunsOffset(playerData.player.runs_pagination.next_offset);
                        }
                      }}
                      disabled={
                        playerData.player.runs_pagination.next_offset === null || runsLoading
                      }
                    >
                      Next
                    </Button>
                  </div>
                </>
              )}
            </Card>
          </>
        ) : null}
      </main>
    );
  }

  /* ─── Leaderboard List View ─── */
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
    <main className="leaderboard-glow mx-auto grid min-h-screen max-w-[1240px] gap-4 p-[clamp(1rem,3vw,2rem)]">
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
              variant="success"
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
            Refresh
          </Button>
        </div>
      </header>

      {/* Filters */}
      <Card className="animate-rise">
        <div className="grid gap-1">
          <h2 className="m-0 font-display text-sm tracking-[0.08em] uppercase">Filters</h2>
          <p className="m-0 text-sm text-[rgba(176,202,237,0.92)]">
            Switch horizon or lookup a claimant contract address.
          </p>
        </div>
        <div
          className="inline-flex w-fit flex-wrap gap-1.5 rounded-xl border border-[rgba(99,156,226,0.37)] bg-[rgba(11,20,34,0.7)] p-1"
          role="group"
          aria-label="Time window selector"
        >
          {(["10m", "day", "all"] as LeaderboardWindow[]).map((w) => (
            <Button
              key={w}
              variant={w === windowKey ? "active" : "space"}
              size="sm"
              onClick={() => {
                setWindowKey(w);
                setOffset(0);
              }}
              aria-pressed={w === windowKey}
            >
              {windowLabel(w)}
            </Button>
          ))}
        </div>

        <form
          className="flex flex-col gap-2 sm:flex-row"
          onSubmit={(event) => {
            event.preventDefault();
            applyFindMe();
          }}
        >
          <Input
            type="text"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="Find address (G... or C...)"
            aria-label="Search for a player address"
            className="flex-1 sm:min-w-[260px]"
          />
          <Button type="submit" size="sm">
            Find Me
          </Button>
          <Button size="sm" onClick={clearFindMe} disabled={!findAddress}>
            Clear
          </Button>
        </form>
      </Card>

      {error ? <p className="m-0 text-[#ffabab]">{error}</p> : null}

      {/* Loading skeleton */}
      {loading && !leaderboard ? (
        <Card className="animate-rise">
          <h2 className="m-0 font-display text-sm tracking-[0.08em] uppercase text-[rgba(176,219,255,0.95)]">
            Rankings
          </h2>
          <Table aria-label="Loading leaderboard rankings">
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Rank</TableHead>
                <TableHead scope="col">Player</TableHead>
                <TableHead scope="col">Score</TableHead>
                <TableHead scope="col">Frames</TableHead>
                <TableHead scope="col">Minted (this run)</TableHead>
                <TableHead scope="col">Seed</TableHead>
                <TableHead scope="col">Completed</TableHead>
                <TableHead scope="col">Claim</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <SkeletonRows count={5} cols={8} />
            </TableBody>
          </Table>
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

            <dl className="m-0 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {[
                ["Tracked Players", leaderboard.pagination.total.toLocaleString()],
                ["Top Score", topEntry ? topEntry.score.toLocaleString() : "n/a"],
                ["Event Rows", leaderboard.ingestion?.total_events?.toLocaleString() ?? "n/a"],
                [
                  "Highest Ledger",
                  leaderboard.ingestion?.highest_ledger?.toLocaleString() ?? "n/a",
                ],
              ].map(([label, val]) => (
                <div
                  key={label}
                  className="rounded-lg border border-[rgba(108,159,230,0.24)] bg-[rgba(12,22,39,0.62)] px-2 py-2"
                >
                  <dt className="m-0 text-xs uppercase tracking-[0.06em] text-[rgba(146,182,233,0.9)]">
                    {label}
                  </dt>
                  <dd className="m-0 mt-0.5 font-display text-sm text-card-foreground">{val}</dd>
                </div>
              ))}
            </dl>

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
              <Table aria-label="Leaderboard rankings">
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">Rank</TableHead>
                    <TableHead scope="col">Player</TableHead>
                    <TableHead scope="col">Score</TableHead>
                    <TableHead scope="col">Frames</TableHead>
                    <TableHead scope="col">Minted (this run)</TableHead>
                    <TableHead scope="col">Seed</TableHead>
                    <TableHead scope="col">Completed</TableHead>
                    <TableHead scope="col">Claim</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {leaderboard.entries.map((entry) => (
                    <TableRow
                      key={entry.jobId}
                      className={
                        leaderboard.me?.claimantAddress === entry.claimantAddress
                          ? "!bg-[rgba(16,67,84,0.34)]"
                          : ""
                      }
                    >
                      <TableCell className={rankClass(entry.rank)}>#{entry.rank}</TableCell>
                      <TableCell>
                        <div className="grid gap-1">
                          <a
                            href={`/leaderboard/${entry.claimantAddress}`}
                            className="text-[#9ce8ff] no-underline hover:underline"
                          >
                            {displayName(entry)}
                          </a>
                          <code className="text-[rgba(190,216,249,0.92)]">
                            {abbreviateAddress(entry.claimantAddress)}
                          </code>
                          {entry.profile?.linkUrl && isSafeUrl(entry.profile.linkUrl) ? (
                            <a
                              href={entry.profile.linkUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="text-[#9ce8ff] no-underline hover:underline"
                            >
                              Link
                            </a>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {entry.score.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatMetric(entry.frameCount)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatMetric(entry.mintedDelta)}
                      </TableCell>
                      <TableCell className="font-display tracking-[0.04em]">
                        {formatHex32(entry.seed)}
                      </TableCell>
                      <TableCell>
                        <RelativeTime value={entry.completedAt} />
                      </TableCell>
                      <TableCell>
                        <StatusBadge variant={claimStatusBadgeVariant(entry.claimStatus)}>
                          {entry.claimStatus}
                        </StatusBadge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                onClick={() => setOffset((current) => Math.max(0, current - limit))}
                disabled={leaderboard.pagination.offset === 0 || loading}
              >
                Previous
              </Button>
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
              </Button>
            </div>
          </Card>
        </>
      ) : null}
    </main>
  );
}
