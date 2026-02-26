import { useCallback, useEffect, useState } from "react";
import { ChevronLeft } from "lucide-react";
import { abbreviateAddress } from "@/lib/format";
import { toNullableTrimmed } from "@/lib/validation";
import {
  getLeaderboardPlayer,
  LeaderboardApiError,
  type LeaderboardPlayerResponse,
  updateLeaderboardProfile,
} from "@/leaderboard/api";
import { Card } from "@/components/ui/card";
import { Table, TableBody } from "@/components/ui/table";
import { SkeletonRows } from "@/components/shared/Skeleton";
import { ErrorMessage } from "@/components/shared/ErrorMessage";
import { PlayerCard } from "./PlayerCard";
import { EditProfile } from "./EditProfile";
import { RecentRunsTable } from "./RecentRunsTable";
import { PageHero } from "@/components/shared/PageHero";
import { resolveSmartWalletSessionForClaimant } from "@/wallet/smartAccount";

export interface LeaderboardPlayerViewProps {
  playerAddress: string;
}

function isSmartAccountContractAddress(address: string): boolean {
  return address.trim().startsWith("C");
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
      const walletSession =
        await resolveSmartWalletSessionForClaimant(claimantAddress);
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
      <PageHero
        title={playerData?.player.profile?.username?.trim() || abbreviateAddress(playerAddress)}
        subtitle="Profile, rankings, and recent proved runs."
      >
        <a
          className="inline-flex items-center gap-1.5 font-display text-sm uppercase tracking-wider text-[#9de0ff] no-underline hover:underline"
          href="/leaderboard"
        >
          <ChevronLeft className="size-4" />
          Back To Leaderboard
        </a>
      </PageHero>

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
