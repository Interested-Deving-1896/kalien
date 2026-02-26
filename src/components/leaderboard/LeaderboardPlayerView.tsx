import { useCallback, useEffect, useState } from "react";
import { ChevronLeft } from "lucide-react";
import { abbreviateAddress } from "@/lib/format";
import {
  getLeaderboardPlayer,
  LeaderboardApiError,
  type LeaderboardPlayerResponse,
  updateLeaderboardProfile,
} from "./api";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/shared/Skeleton";
import { ErrorMessage } from "@/components/shared/ErrorMessage";
import { PlayerCard } from "./PlayerCard";
import { EditProfile } from "./EditProfile";
import { RecentRunsTable } from "./RecentRunsTable";

export interface LeaderboardPlayerViewProps {
  playerAddress: string;
}

function isSmartAccountContractAddress(address: string): boolean {
  return address.trim().startsWith("C");
}

function toNullableTrimmed(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function SkeletonRows({ count, cols }: { count: number; cols: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <TableRow key={i}>
          {Array.from({ length: cols }, (__, j) => (
            <TableCell key={j}>
              <Skeleton wide={j === 1 || j === cols - 2} />
            </TableCell>
          ))}
        </TableRow>
      ))}
    </>
  );
}

export function LeaderboardPlayerView({ playerAddress }: LeaderboardPlayerViewProps) {
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

  // Fetch player data
  useEffect(() => {
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
        if (cancelled) return;
        setPlayerData(response);
        if (!isPageChange) {
          setProfileUsername(response.player.profile?.username ?? "");
          setProfileLinkUrl(response.player.profile?.linkUrl ?? "");
        }
      } catch (reason) {
        if (cancelled) return;
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

  const saveProfile = useCallback(async () => {
    if (!playerData) return;

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
      const walletModule = await import("../../wallet/smartAccount");
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
        if (!current) return current;
        return {
          ...current,
          player: {
            ...current.player,
            profile: updated.profile,
          },
        };
      });
      setProfileSavedAt(updated.profile.updatedAt);
    } catch (reason: unknown) {
      const detail =
        reason instanceof LeaderboardApiError || reason instanceof Error
          ? reason.message
          : "failed to save profile";
      setProfileSaveError(detail);
    } finally {
      setSavingProfile(false);
    }
  }, [playerData, profileLinkUrl, profileUsername]);

  const supportsProfileAuth =
    playerData !== null && isSmartAccountContractAddress(playerData.player.claimant_address);

  return (
    <>
      {/* Hero Header */}
      <header className="animate-rise flex flex-col items-start justify-between gap-3 rounded-xl border border-[rgba(122,185,255,0.34)] bg-[radial-gradient(circle_at_110%_0%,rgba(102,231,196,0.12),transparent_40%),linear-gradient(160deg,rgba(7,14,25,0.8),rgba(5,11,20,0.95))] p-[clamp(0.95rem,2.6vw,1.2rem)] shadow-[0_22px_70px_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.07)] sm:flex-row">
        <div>
          <h1 className="m-0 font-display text-[clamp(1.75rem,4.2vw,2.4rem)] tracking-[0.09em] uppercase [text-shadow:0_0_16px_rgba(79,196,255,0.26)]">
            {playerData?.player.profile?.username?.trim() || abbreviateAddress(playerAddress)}
          </h1>
          <p className="m-0 mt-1 text-[rgba(205,238,226,0.92)]">
            Profile, rankings, and recent proved runs.
          </p>
        </div>
        <a
          className="inline-flex items-center gap-1.5 font-display text-sm uppercase tracking-wider text-[#9de0ff] no-underline hover:underline"
          href="/leaderboard"
        >
          <ChevronLeft className="size-4" />
          Back To Leaderboard
        </a>
      </header>

      {/* Loading state */}
      {playerLoading ? (
        <Card>
          <Table aria-label="Loading player data">
            <TableBody>
              <SkeletonRows count={3} cols={6} />
            </TableBody>
          </Table>
        </Card>
      ) : null}

      <ErrorMessage message={playerError} />

      {playerData ? (
        <>
          <PlayerCard player={playerData.player} />

          <EditProfile
            claimantAddress={playerData.player.claimant_address}
            username={profileUsername}
            linkUrl={profileLinkUrl}
            onUsernameChange={setProfileUsername}
            onLinkUrlChange={setProfileLinkUrl}
            onSave={saveProfile}
            isSaving={savingProfile}
            saveError={profileSaveError}
            savedAt={profileSavedAt}
            supported={supportsProfileAuth}
          />

          <RecentRunsTable
            runs={playerData.player.recent_runs}
            pagination={playerData.player.runs_pagination}
            offset={runsOffset}
            onOffsetChange={setRunsOffset}
            isLoading={runsLoading}
            limit={runsLimit}
          />
        </>
      ) : null}
    </>
  );
}
