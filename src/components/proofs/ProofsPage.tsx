import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw, Info } from "lucide-react";
import { listProofJobs, isTerminalProofStatus, type ProofJobPublic } from "@/proof/api";
import { timeAgo } from "@/lib/time";
import { useWalletContext } from "@/contexts/WalletContext";
import { PageShell } from "@/components/shared/PageShell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ErrorMessage } from "@/components/shared/ErrorMessage";
import { Link } from "@/components/shared/Link";
import { Pagination } from "@/components/shared/Pagination";
import { ProofJobCard } from "./ProofJobCard";
import { PageHero } from "@/components/shared/PageHero";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { AUTO_REFRESH_PROOFS_MS } from "@/consts";

function hasActiveJobs(jobs: ProofJobPublic[]): boolean {
  return jobs.some((job) => !isTerminalProofStatus(job.status));
}

export function ProofsPage() {
  useDocumentTitle("Proofs");
  const { wallet } = useWalletContext();

  const [jobs, setJobs] = useState<ProofJobPublic[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [limit] = useState(25);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRefreshAt, setLastRefreshAt] = useState<string | null>(null);

  const fetchJobs = useCallback(
    (silent: boolean) => {
      const address = wallet.address;
      if (!address) return;

      if (!silent) {
        setLoading(true);
        setError(null);
      }

      void (async () => {
        try {
          const response = await listProofJobs(address, { limit, offset });
          setJobs(response.jobs);
          setTotal(response.total);
          setNextOffset(response.next_offset);
          setLastRefreshAt(new Date().toISOString());
          if (!silent) {
            setError(null);
          }
        } catch (reason) {
          if (!silent) {
            const detail = reason instanceof Error ? reason.message : "failed to load proof jobs";
            setError(detail);
          }
        } finally {
          if (!silent) {
            setLoading(false);
          }
        }
      })();
    },
    [wallet.address, limit, offset],
  );

  const fetchJobsRef = useRef(fetchJobs);
  fetchJobsRef.current = fetchJobs;

  // Primary data fetch
  useEffect(() => {
    if (!wallet.address || wallet.isBusy) return;
    fetchJobsRef.current(false);
  }, [wallet.address, wallet.isBusy, limit, offset]);

  const activeJobs = hasActiveJobs(jobs);

  // Auto-refresh when there are active (non-terminal) jobs
  useEffect(() => {
    if (!wallet.address || !activeJobs) return;

    const interval = setInterval(() => {
      fetchJobsRef.current?.(true);
    }, AUTO_REFRESH_PROOFS_MS);

    return () => clearInterval(interval);
  }, [wallet.address, activeJobs]);

  return (
    <PageShell glow className="content-start">
      <PageHero title="My Proofs" subtitle="Track your proof jobs and verification status.">
        {wallet.isConnected && (
          <div className="flex items-center gap-2">
            {lastRefreshAt && (
              <span className="text-xs text-muted-foreground">
                Updated {timeAgo(lastRefreshAt)}
              </span>
            )}
            <Button size="sm" onClick={() => fetchJobs(false)} disabled={loading} title="Refresh">
              <RefreshCw className="size-3.5" />
              Refresh
            </Button>
          </div>
        )}
      </PageHero>

      {/* Leaderboard note */}
      <div className="flex items-start gap-2.5 rounded-lg border border-primary/25 bg-[rgba(20,92,136,0.12)] px-3.5 py-2.5">
        <Info className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
        <p className="m-0 text-sm text-text-soft">
          Verified scores are automatically posted to the{" "}
          <Link
            href="/leaderboard"
            className="font-display tracking-wide text-primary no-underline hover:underline"
          >
            leaderboard
          </Link>{" "}
          once proofs have been confirmed on-chain.
        </p>
      </div>

      <ErrorMessage message={error} />

      {/* No wallet connected */}
      {!wallet.isConnected && !wallet.isBusy && (
        <Card className="animate-rise">
          <div className="grid justify-items-center gap-3 py-8 text-center">
            <p className="m-0 text-text-soft">
              Connect your wallet on the game page to view your proofs.
            </p>
            <Button variant="active" asChild>
              <Link href="/" className="no-underline">
                Go Play
              </Link>
            </Button>
          </div>
        </Card>
      )}

      {/* Wallet connecting / restoring */}
      {wallet.isBusy && (
        <Card className="animate-rise">
          <p className="m-0 text-center text-muted-foreground">Restoring wallet session...</p>
        </Card>
      )}

      {/* Jobs list */}
      {wallet.isConnected && (
        <>
          {/* Summary bar */}
          {total > 0 && (
            <h2 className="m-0 font-display text-sm tracking-[0.08em] uppercase text-[rgba(176,219,255,0.95)]">
              Proof Jobs
            </h2>
          )}

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
                <p className="m-0 text-text-soft">No proof jobs yet.</p>
                <p className="m-0 text-sm text-muted-foreground">
                  Play the game and prove your score to see jobs here.
                </p>
                <Button variant="active" asChild>
                  <Link href="/" className="no-underline">
                    Go Play
                  </Link>
                </Button>
              </div>
            </Card>
          )}

          {/* Job cards */}
          {jobs.length > 0 && (
            <div className="grid gap-3">
              {jobs.map((job) => (
                <ProofJobCard key={job.jobId} job={job} />
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
        </>
      )}
    </PageShell>
  );
}
