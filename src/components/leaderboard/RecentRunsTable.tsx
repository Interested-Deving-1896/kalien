import type { LeaderboardPlayerResponse } from "@/leaderboard/api";
import { formatHex32, formatMetric } from "@/lib/format";
import { Card } from "@/components/ui/card";
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
import { Pagination } from "@/components/shared/Pagination";
import { RelativeTime } from "./RelativeTime";
import { claimStatusBadgeVariant } from "./helpers";

export interface RecentRunsTableProps {
  runs: LeaderboardPlayerResponse["player"]["recent_runs"];
  pagination: LeaderboardPlayerResponse["player"]["runs_pagination"];
  offset: number;
  onOffsetChange: (offset: number) => void;
  isLoading: boolean;
  limit: number;
}

export function RecentRunsTable({
  runs,
  pagination,
  offset,
  onOffsetChange,
  isLoading,
  limit,
}: RecentRunsTableProps) {
  return (
    <Card>
      <h3 className="m-0 font-display tracking-[0.055em] uppercase">Recent Runs</h3>
      <p className="m-0 text-sm text-text-soft">
        Recent runs includes every proved submission for this claimant (not just the best run).
      </p>
      {runs.length === 0 && offset === 0 ? (
        <p className="m-0 text-text-soft">No proved runs yet.</p>
      ) : (
        <>
          <Table aria-label="Recent proved runs">
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Score</TableHead>
                <TableHead scope="col">Frames</TableHead>
                <TableHead scope="col">KALIEN Earned</TableHead>
                <TableHead scope="col">Seed</TableHead>
                <TableHead scope="col">Completed</TableHead>
                <TableHead scope="col">Claim</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <SkeletonRows count={3} cols={6} />
              ) : (
                runs.map((run) => (
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
                ))
              )}
            </TableBody>
          </Table>
          <Pagination
            offset={offset}
            limit={limit}
            total={pagination.total}
            nextOffset={pagination.next_offset}
            onOffsetChange={onOffsetChange}
            disabled={isLoading}
          />
        </>
      )}
    </Card>
  );
}
