import Play from "lucide-react/dist/esm/icons/play";
import type { LeaderboardPlayerResponse } from "@/leaderboard/api";
import { formatHex32, formatMetric } from "@/lib/format";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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
import { navigate } from "@/hooks/useLocation";

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
  const renderReplayButton = (proofJobId: string | null) => {
    if (!proofJobId) {
      return null;
    }

    return (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="justify-center px-3 text-primary hover:bg-primary/10 hover:text-primary"
        onClick={() => navigate(`/replay/${proofJobId}`)}
        title="Replay this run"
      >
        <Play className="size-3.5" />
        Replay
      </Button>
    );
  };

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
          {isLoading ? (
            <Table aria-label="Recent proved runs">
              <TableHeader>
                <TableRow>
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
                  <TableHead scope="col">
                    <span className="sr-only">Replay</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <SkeletonRows count={3} cols={7} />
              </TableBody>
            </Table>
          ) : (
            <Table aria-label="Recent proved runs">
              <TableHeader>
                <TableRow>
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
                  <TableHead scope="col">
                    <span className="sr-only">Replay</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((run) => (
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
                    <TableCell>{renderReplayButton(run.proofJobId)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
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
