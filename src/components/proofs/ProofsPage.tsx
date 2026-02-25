import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import {
  listProofJobs,
  isTerminalProofStatus,
  type ProofJobPublic,
} from "@/proof/api";
import { timeAgo } from "@/time";
import { useWallet } from "@/hooks/useWallet";
import { PageShell } from "@/components/shared/PageShell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ErrorMessage } from "@/components/shared/ErrorMessage";
import { JobsTable } from "./JobsTable";

const AUTO_REFRESH_ACTIVE_MS = 15_000;

function hasActiveJobs(jobs: ProofJobPublic[]): boolean {
  return jobs.some((job) => !isTerminalProofStatus(job.status));
}

export function ProofsPage() {
  const wallet = useWallet();

  const [jobs, setJobs] = useState<ProofJobPublic[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [limit] = useState(25);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRefreshAt, setLastRefreshAt] = useState<string | null>(null);

  const fetchJobsRef = useRef<(() => void) | undefined>(undefined);

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
            const detail =
              reason instanceof Error ? reason.message : "failed to load proof jobs";
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

  fetchJobsRef.current = () => fetchJobs(true);

  // Primary data fetch
  useEffect(() => {
    if (!wallet.address || wallet.isBusy) return;

    let cancelled = false;
    setLoading(true);
    setError(null);

    void (async () => {
      try {
        const response = await listProofJobs(wallet.address, { limit, offset });
        if (!cancelled) {
          setJobs(response.jobs);
          setTotal(response.total);
          setNextOffset(response.next_offset);
          setLastRefreshAt(new Date().toISOString());
        }
      } catch (reason) {
        if (cancelled) return;
        const detail =
          reason instanceof Error ? reason.message : "failed to load proof jobs";
        setError(detail);
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [wallet.address, wallet.isBusy, limit, offset]);

  // Auto-refresh when there are active (non-terminal) jobs
  useEffect(() => {
    if (!wallet.address || !hasActiveJobs(jobs)) return;

    const interval = setInterval(() => {
      fetchJobsRef.current?.();
    }, AUTO_REFRESH_ACTIVE_MS);

    return () => clearInterval(interval);
  }, [wallet.address, jobs]);

  const showingStart = total > 0 ? offset + 1 : 0;
  const showingEnd = offset + jobs.length;

  return (
    <PageShell glow>
      {/* Hero Header */}
      <header className="animate-rise flex flex-col items-start justify-between gap-3 rounded-xl border border-[rgba(122,185,255,0.34)] bg-[radial-gradient(circle_at_110%_0%,rgba(102,231,196,0.12),transparent_40%),linear-gradient(160deg,rgba(7,14,25,0.8),rgba(5,11,20,0.95))] p-[clamp(0.95rem,2.6vw,1.2rem)] shadow-[0_22px_70px_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.07)] sm:flex-row">
        <div>
          <h1 className="m-0 font-display text-[clamp(1.75rem,4.2vw,2.4rem)] tracking-[0.09em] uppercase [text-shadow:0_0_16px_rgba(79,196,255,0.26)]">
            My Proofs
          </h1>
          <p className="m-0 mt-1 text-[rgba(205,238,226,0.92)]">
            Your submitted proof jobs and their verification status.
          </p>
        </div>
        <div className="grid justify-items-end gap-2">
          <Button
            size="sm"
            onClick={() => fetchJobs(false)}
            disabled={loading || !wallet.isConnected}
            title={lastRefreshAt ? `Last refreshed ${timeAgo(lastRefreshAt)}` : "Refresh"}
          >
            <RefreshCw className="size-3.5" />
            Refresh
          </Button>
        </div>
      </header>

      <ErrorMessage message={error} />

      {/* No wallet connected */}
      {!wallet.isConnected && !wallet.isBusy && (
        <Card className="animate-rise">
          <div className="grid justify-items-center gap-3 py-8 text-center">
            <p className="m-0 text-[rgba(186,210,241,0.92)]">
              Connect your wallet on the game page to view your proofs.
            </p>
            <Button variant="active" asChild>
              <a href="/" className="no-underline">
                Go Play
              </a>
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
        <Card className="animate-rise">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="m-0 font-display text-sm tracking-[0.08em] uppercase text-[rgba(176,219,255,0.95)]">
              Proof Jobs
            </h2>
            {total > 0 && (
              <span className="text-sm tabular-nums text-muted-foreground">
                {showingStart}–{showingEnd} of {total.toLocaleString()}
              </span>
            )}
          </div>

          {!loading && jobs.length === 0 && !error ? (
            <div className="grid justify-items-center gap-3 py-8 text-center">
              <p className="m-0 text-[rgba(186,210,241,0.92)]">No proof jobs yet.</p>
              <p className="m-0 text-sm text-muted-foreground">
                Play the game and prove your score to see jobs here.
              </p>
              <Button variant="active" asChild>
                <a href="/" className="no-underline">
                  Go Play
                </a>
              </Button>
            </div>
          ) : (
            <JobsTable jobs={jobs} isLoading={loading && jobs.length === 0} />
          )}

          {/* Pagination */}
          {(offset > 0 || nextOffset !== null) && (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                onClick={() => setOffset((current) => Math.max(0, current - limit))}
                disabled={offset === 0 || loading}
              >
                Previous
              </Button>
              <span className="text-sm tabular-nums text-muted-foreground">
                {showingStart}–{showingEnd} of {total.toLocaleString()}
              </span>
              <Button
                size="sm"
                onClick={() => {
                  if (nextOffset !== null) {
                    setOffset(nextOffset);
                  }
                }}
                disabled={nextOffset === null || loading}
              >
                Next
              </Button>
            </div>
          )}
        </Card>
      )}
    </PageShell>
  );
}
