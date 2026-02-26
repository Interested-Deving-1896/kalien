import { Fragment, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import type { ProofJobPublic, ProverBackend } from "@/proof/api";
import { timeAgo } from "@/time";
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/shared/Skeleton";
import { ProofStatusBadge } from "./ProofStatusBadge";
import { BackendBadge } from "./BackendBadge";
import { JobDetails } from "./JobDetails";

function getDisplayBackend(job: ProofJobPublic): ProverBackend | null {
  if (!job.proverAttempts || job.proverAttempts.length === 0) return null;
  const inProgress = job.proverAttempts.find((a) => a.outcome === "in_progress");
  if (inProgress) return inProgress.backend;
  const last = job.proverAttempts[job.proverAttempts.length - 1];
  return last?.backend ?? null;
}

function SkeletonRows() {
  return (
    <>
      {Array.from({ length: 5 }, (_, i) => (
        <TableRow key={i}>
          <TableCell>
            <Skeleton wide />
          </TableCell>
          <TableCell>
            <Skeleton />
          </TableCell>
          <TableCell>
            <Skeleton />
          </TableCell>
          <TableCell>
            <Skeleton />
          </TableCell>
          <TableCell>
            <Skeleton />
          </TableCell>
          <TableCell>
            <Skeleton />
          </TableCell>
        </TableRow>
      ))}
    </>
  );
}

export function JobsTable({ jobs, isLoading }: { jobs: ProofJobPublic[]; isLoading: boolean }) {
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);

  const toggleExpand = (jobId: string) => {
    setExpandedJobId((current) => (current === jobId ? null : jobId));
  };

  return (
    <Table aria-label="Proof jobs">
      <TableHeader>
        <TableRow>
          <TableHead scope="col">Status</TableHead>
          <TableHead scope="col">Score</TableHead>
          <TableHead scope="col">Backend</TableHead>
          <TableHead scope="col">Attempts</TableHead>
          <TableHead scope="col">Created</TableHead>
          <TableHead scope="col" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {isLoading && jobs.length === 0 ? (
          <SkeletonRows />
        ) : (
          jobs.map((job) => {
            const isExpanded = expandedJobId === job.jobId;
            const backend = getDisplayBackend(job);
            const attempts = job.proverAttempts?.length ?? 0;

            return (
              <Fragment key={job.jobId}>
                <TableRow
                  className="cursor-pointer hover:bg-[rgba(16,38,64,0.35)]"
                  onClick={() => toggleExpand(job.jobId)}
                >
                  <TableCell>
                    <ProofStatusBadge job={job} />
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {job.tape.metadata.finalScore.toLocaleString()}
                  </TableCell>
                  <TableCell>
                    {backend ? (
                      <BackendBadge backend={backend} />
                    ) : (
                      <span className="text-muted-foreground text-sm">—</span>
                    )}
                  </TableCell>
                  <TableCell className="tabular-nums text-sm text-muted-foreground">
                    {attempts}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {timeAgo(job.createdAt)}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleExpand(job.jobId);
                      }}
                      aria-label={isExpanded ? "Collapse details" : "Expand details"}
                    >
                      {isExpanded ? (
                        <ChevronUp className="size-4" />
                      ) : (
                        <ChevronDown className="size-4" />
                      )}
                    </Button>
                  </TableCell>
                </TableRow>
                {isExpanded && (
                  <TableRow>
                    <TableCell colSpan={6} className="p-0">
                      <JobDetails job={job} />
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            );
          })
        )}
      </TableBody>
    </Table>
  );
}
