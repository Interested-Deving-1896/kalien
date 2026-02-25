import { ChevronLeft, ChevronRight } from "lucide-react";
import type { ClaimStatus, LeaderboardPlayerResponse } from "./api";
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
import { Skeleton } from "@/components/shared/Skeleton";
import { RelativeTime } from "./RelativeTime";

export interface RecentRunsTableProps {
  runs: LeaderboardPlayerResponse["player"]["recent_runs"];
  pagination: LeaderboardPlayerResponse["player"]["runs_pagination"];
  offset: number;
  onOffsetChange: (offset: number) => void;
  isLoading: boolean;
  limit: number;
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

export function RecentRunsTable({
  runs,
  pagination,
  offset,
  onOffsetChange,
  isLoading,
  limit,
}: RecentRunsTableProps) {
  const showingStart = Math.min(pagination.total, offset + 1);
  const showingEnd = Math.min(offset + runs.length, pagination.total);

  return (
    <Card>
      <h3 className="m-0 font-display tracking-[0.055em] uppercase">Recent Runs</h3>
      <p className="m-0 text-sm text-[rgba(186,210,241,0.92)]">
        Recent runs includes every proved submission for this claimant (not just the best run).
      </p>
      {runs.length === 0 && offset === 0 ? (
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
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              onClick={() => onOffsetChange(Math.max(0, offset - limit))}
              disabled={offset === 0 || isLoading}
            >
              <ChevronLeft className="size-3.5" />
              Previous
            </Button>
            <span className="text-sm tabular-nums text-[rgba(186,210,241,0.92)]">
              {showingStart}-{showingEnd} of {pagination.total}
            </span>
            <Button
              size="sm"
              onClick={() => {
                if (pagination.next_offset !== null) {
                  onOffsetChange(pagination.next_offset);
                }
              }}
              disabled={pagination.next_offset === null || isLoading}
            >
              Next
              <ChevronRight className="size-3.5" />
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}
