import { Medal, Play, Trophy } from "lucide-react";
import type { LeaderboardEntry } from "@/leaderboard/api";
import { abbreviateAddress, formatHex32, formatMetric } from "@/lib/format";
import { isSafeUrl } from "@/lib/validation";
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
import { SkeletonRows } from "@/components/shared/Skeleton";
import { Link } from "@/components/shared/Link";
import { RelativeTime } from "./RelativeTime";
import { claimStatusBadgeVariant } from "./helpers";
import { navigate } from "@/hooks/useLocation";

export interface RankingsTableProps {
  entries: LeaderboardEntry[];
  highlightAddress?: string;
  isLoading?: boolean;
}

function displayName(entry: LeaderboardEntry): string {
  return entry.profile?.username?.trim() || abbreviateAddress(entry.claimantAddress);
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
            <TableHead scope="col" />
          </TableRow>
        </TableHeader>
        <TableBody>
          <SkeletonRows count={5} cols={9} />
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
          <TableHead scope="col" />
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
                <Link
                  href={`/leaderboard/${entry.claimantAddress}`}
                  className="text-link no-underline hover:underline"
                >
                  {displayName(entry)}
                </Link>
                <code className="text-text-soft">
                  {abbreviateAddress(entry.claimantAddress)}
                </code>
                {entry.profile?.linkUrl && isSafeUrl(entry.profile.linkUrl) ? (
                  <a
                    href={entry.profile.linkUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-link no-underline hover:underline"
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
            <TableCell>
              {entry.proofJobId && (
                <button
                  onClick={() => navigate(`/?replay=${entry.proofJobId}`)}
                  className="inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-2 py-1 text-xs text-primary transition-colors hover:bg-primary/10"
                  title="Replay this run"
                >
                  <Play className="size-3" />
                  <span className="hidden sm:inline">Replay</span>
                </button>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
