import { useCallback, useEffect, useRef, useState } from "react";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw";
import { listProofJobs, type ProofJobPublic } from "@/proof/api";
import { PageShell } from "@/components/shared/PageShell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ErrorMessage } from "@/components/shared/ErrorMessage";
import { Pagination } from "@/components/shared/Pagination";
import { ProofJobCard } from "./ProofJobCard";
import { PageHero } from "@/components/shared/PageHero";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { useLocation } from "@/hooks/useLocation";
import { RelativeTime } from "@/components/leaderboard/RelativeTime";

function truncateAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-6)}`;
}

function LastUpdatedLabel({ value }: { value: string | null }) {
  if (!value) {
    return null;
  }

  return (
    <span className="text-xs text-muted-foreground">
      Updated <RelativeTime value={value} />
    </span>
  );
}

export function PublicProofsPage() {
  const pathname = useLocation();
  const address = pathname.replace(/^\/proofs\//, "").replace(/\/.*$/, "");

  useDocumentTitle(`Proofs - ${truncateAddress(address)}`, {
    description: `Proof jobs for ${address}`,
    path: `/proofs/${address}`,
  });

  const [jobs, setJobs] = useState<ProofJobPublic[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [limit] = useState(25);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRefreshAt, setLastRefreshAt] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const fetchJobs = useCallback(
    (silent: boolean) => {
      if (!address) return;
      const requestId = ++requestIdRef.current;

      if (!silent) {
        setLoading(true);
        setError(null);
      }

      void (async () => {
        try {
          const response = await listProofJobs(address, { limit, offset });
          if (requestId !== requestIdRef.current) {
            return;
          }
          setJobs(response.jobs);
          setTotal(response.total);
          setNextOffset(response.next_offset);
          setLastRefreshAt(new Date().toISOString());
          if (!silent) {
            setError(null);
          }
        } catch (reason) {
          if (requestId !== requestIdRef.current) {
            return;
          }
          if (!silent) {
            const detail = reason instanceof Error ? reason.message : "failed to load proof jobs";
            setError(detail);
          }
        } finally {
          if (!silent && requestId === requestIdRef.current) {
            setLoading(false);
          }
        }
      })();
    },
    [address, limit, offset],
  );

  const fetchJobsRef = useRef(fetchJobs);
  fetchJobsRef.current = fetchJobs;

  useEffect(() => {
    if (!address) {
      requestIdRef.current += 1;
      return;
    }
    fetchJobsRef.current(false);
  }, [address, limit, offset]);

  return (
    <PageShell glow className="content-start">
      <PageHero
        title="Player Proofs"
        subtitle={`Viewing proof jobs for ${truncateAddress(address)}`}
      >
        <div className="flex flex-wrap items-center gap-2 sm:justify-end">
          <LastUpdatedLabel value={lastRefreshAt} />
          <Button size="sm" onClick={() => fetchJobs(false)} disabled={loading} title="Refresh">
            <RefreshCw className="size-3.5" />
            Refresh
          </Button>
        </div>
      </PageHero>

      <p className="m-0 rounded-lg border border-border/30 bg-[rgba(8,16,29,0.5)] px-3.5 py-2.5 font-mono text-xs break-all text-muted-foreground">
        {address}
      </p>

      <ErrorMessage message={error} />

      {/* Loading skeleton */}
      {loading && jobs.length === 0 && !error && (
        <div className="grid gap-3">
          {Array.from({ length: 3 }, (_, i) => (
            <div
              key={i}
              className="h-24 animate-pulse rounded-xl border border-border/30 bg-[rgba(8,16,29,0.5)]"
            />
          ))}
        </div>
      )}

      {/* Empty state */}
      {!loading && jobs.length === 0 && !error && (
        <Card className="animate-rise">
          <div className="grid justify-items-center gap-3 py-8 text-center">
            <p className="m-0 text-text-soft">No proof jobs found for this address.</p>
          </div>
        </Card>
      )}

      {/* Summary bar */}
      {total > 0 && (
        <h2 className="m-0 font-display text-sm tracking-[0.08em] uppercase text-[rgba(176,219,255,0.95)]">
          Proof Jobs
        </h2>
      )}

      {/* Job cards */}
      {jobs.length > 0 && (
        <div className="grid gap-3">
          {jobs.map((job) => (
            <ProofJobCard key={job.jobId} job={job} readOnly />
          ))}
        </div>
      )}

      {/* Pagination */}
      {(offset > 0 || nextOffset !== null) && (
        <Pagination
          offset={offset}
          limit={limit}
          total={total}
          nextOffset={nextOffset}
          onOffsetChange={setOffset}
          disabled={loading}
        />
      )}
    </PageShell>
  );
}
