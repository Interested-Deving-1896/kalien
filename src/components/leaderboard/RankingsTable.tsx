import { Medal, Trophy } from "lucide-react";
import type { ClaimStatus, LeaderboardEntry } from "./api";
import { abbreviateAddress, formatHex32, formatMetric } from "@/lib/format";
import { cn } from "@/lib/utils";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import { Skeleton } from "@/components/shared/Skeleton";
import { RelativeTime } from "./RelativeTime";

export interface RankingsTableProps {
  entries: LeaderboardEntry[];
  highlightAddress?: string;
  isLoading?: boolean;
}

function isSafeUrl(url: string | null | undefined): boolean {
  if (!url) {
    return false;
  }
  const trimmed = url.trim().toLowerCase();
  return trimmed.startsWith("http://") || trimmed.startsWith("https://");
}

function displayName(entry: LeaderboardEntry): string {
  return entry.profile?.username?.trim() || abbreviateAddress(entry.claimantAddress);
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

function RankBadge({ rank }: { rank: number }) {
  if (rank === 1) {
    return (
      <span className="inline-flex items-center gap-1 font-display font-bold tracking-wider text-[#ffe08f]">
        <Trophy className="size-4" />#{rank}
      </span>
    );
  }
  if (rank === 2) {
    return (
      <span className="inline-flex items-center gap-1 font-display font-bold tracking-wider text-[#d8ecff]">
        <Medal className="size-4" />#{rank}
      </span>
    );
  }
  if (rank === 3) {
    return (
      <span className="inline-flex items-center gap-1 font-display font-bold tracking-wider text-[#ffcda2]">
        <Medal className="size-4" />#{rank}
      </span>
    );
  }
  return <span className="font-display tracking-wider">#{rank}</span>;
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

export function RankingsTable({ entries, highlightAddress, isLoading }: RankingsTableProps) {
  if (isLoading) {
    return (
      <Table aria-label="Loading leaderboard rankings">
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Rank</TableHead>
            <TableHead scope="col">Player</TableHead>
            <TableHead scope="col" className="text-right">
              Score
            </TableHead>
            <TableHead scope="col" className="text-right">
              Frames
            </TableHead>
            <TableHead scope="col" className="text-right">
              KALIEN Earned
            </TableHead>
            <TableHead scope="col">Seed</TableHead>
            <TableHead scope="col">Completed</TableHead>
            <TableHead scope="col">Claim</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <SkeletonRows count={5} cols={8} />
        </TableBody>
      </Table>
    );
  }

  return (
    <Table aria-label="Leaderboard rankings">
      <TableHeader>
        <TableRow>
          <TableHead scope="col">Rank</TableHead>
          <TableHead scope="col">Player</TableHead>
          <TableHead scope="col" className="text-right">
            Score
          </TableHead>
          <TableHead scope="col" className="text-right">
            Frames
          </TableHead>
          <TableHead scope="col" className="text-right">
            KALIEN Earned
          </TableHead>
          <TableHead scope="col">Seed</TableHead>
          <TableHead scope="col">Completed</TableHead>
          <TableHead scope="col">Claim</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.map((entry) => (
          <TableRow
            key={entry.jobId}
            className={cn(
              highlightAddress === entry.claimantAddress && "!bg-[rgba(16,67,84,0.34)]",
            )}
          >
            <TableCell>
              <RankBadge rank={entry.rank} />
            </TableCell>
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
  );
}
