import { Link, Trophy, User } from "lucide-react";
import type { LeaderboardPlayerResponse } from "./api";
import { abbreviateAddress, formatMetric } from "@/lib/format";
import { Card } from "@/components/ui/card";
import { StatCard, StatGrid } from "@/components/shared/StatCard";
import { RelativeTime } from "./RelativeTime";

export interface PlayerCardProps {
  player: LeaderboardPlayerResponse["player"];
}

function isSafeUrl(url: string | null | undefined): boolean {
  if (!url) {
    return false;
  }
  const trimmed = url.trim().toLowerCase();
  return trimmed.startsWith("http://") || trimmed.startsWith("https://");
}

function RankValue({ rank }: { rank: number | null }) {
  if (rank === null) {
    return <span>n/a</span>;
  }
  if (rank <= 3) {
    return (
      <span className="inline-flex items-center gap-1">
        <Trophy className="size-3.5 text-[#ffe08f]" />#{rank}
      </span>
    );
  }
  return <span>#{rank}</span>;
}

export function PlayerCard({ player }: PlayerCardProps) {
  const name = player.profile?.username?.trim() || abbreviateAddress(player.claimant_address);

  return (
    <Card>
      {/* Player name and address */}
      <div className="grid gap-1">
        <h2 className="m-0 flex items-center gap-2 font-display text-[clamp(1.2rem,3vw,1.6rem)] tracking-[0.055em] uppercase">
          <User className="size-5 text-primary" />
          {name}
        </h2>
        <p className="m-0">
          <strong className="text-xs uppercase tracking-[0.04em] text-[rgba(146,182,233,0.9)]">
            Address:
          </strong>{" "}
          <code className="break-all text-[rgba(190,216,249,0.92)]">
            {player.claimant_address}
          </code>
        </p>
        {player.profile?.linkUrl && isSafeUrl(player.profile.linkUrl) ? (
          <p className="m-0 flex items-center gap-1.5">
            <Link className="size-3.5 text-[rgba(146,182,233,0.9)]" />
            <a href={player.profile.linkUrl} target="_blank" rel="noreferrer">
              {player.profile.linkUrl}
            </a>
          </p>
        ) : null}
      </div>

      {/* Performance stats */}
      <StatGrid columns={4}>
        <StatCard label="Total Runs" value={player.stats.total_runs.toLocaleString()} />
        <StatCard label="Best Score" value={player.stats.best_score.toLocaleString()} />
        <StatCard label="Total Minted" value={formatMetric(player.stats.total_minted)} />
        <StatCard label="Last Played" value={<RelativeTime value={player.stats.last_played_at} />} />
      </StatGrid>

      <p className="m-0 text-sm text-[rgba(186,210,241,0.92)]">
        Leaderboard rank uses each claimant's single best proved run in the selected window;
        this page also shows your full recent run history and total minted.
      </p>

      {/* Rank badges */}
      <StatGrid columns={3}>
        <StatCard label="10m Rank" value={<RankValue rank={player.ranks.ten_min} />} />
        <StatCard label="24h Rank" value={<RankValue rank={player.ranks.day} />} />
        <StatCard label="All-Time Rank" value={<RankValue rank={player.ranks.all} />} />
      </StatGrid>
    </Card>
  );
}
