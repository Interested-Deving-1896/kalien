import { useState, useEffect, useRef } from "react";
import {
  ChevronDown,
  ExternalLink,
  Download,
  Play,
  Clock,
  Cpu,
  Zap,
  Trophy,
  DollarSign,
  RotateCw,
} from "lucide-react";
import type { ClaimAttempt, ProofJobPublic, ProverAttempt } from "@/proof/api";
import { getTapeDownloadUrl, retryFailedClaim, retryFailedProof, getProofJob } from "@/proof/api";
import { ErrorDetailDialog } from "./ErrorDetailDialog";
import { boundlessExplorerUrl, getActiveBackend } from "@/proof/helpers";
import { formatBytes, formatCycles, formatDuration, formatHex32 } from "@/lib/format";
import { timeAgo } from "@/lib/time";
import { cn } from "@/lib/utils";
import { STELLAR_EXPLORER_BASE } from "@/consts";
import { navigate } from "@/hooks/useLocation";
import { ProofStatusBadge } from "./ProofStatusBadge";
import { BackendBadge } from "./BackendBadge";

function getSuccessfulAttempt(job: ProofJobPublic): ProverAttempt | null {
  if (!job.proverAttempts || job.proverAttempts.length === 0) return null;
  for (let i = job.proverAttempts.length - 1; i >= 0; i -= 1) {
    const attempt = job.proverAttempts[i];
    if (attempt.outcome === "success") return attempt;
  }
  return null;
}

function computeWallClockMs(attempt: ProverAttempt): number | null {
  if (!attempt.startedAt || !attempt.endedAt) return null;
  const ms = new Date(attempt.endedAt).getTime() - new Date(attempt.startedAt).getTime();
  return ms > 0 ? ms : null;
}

function computeJobWallClockMs(job: ProofJobPublic): number | null {
  if (!job.createdAt || !job.completedAt) return null;
  const ms = new Date(job.completedAt).getTime() - new Date(job.createdAt).getTime();
  return ms > 0 ? ms : null;
}

function parseIsoMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function formatCostUsd(usd: number): string {
  if (usd >= 0.01) return `$${usd.toFixed(2)}`;
  // Show up to 7 decimal places but trim trailing zeros
  const raw = usd.toFixed(7).replace(/0+$/, "").replace(/\.$/, "");
  return `$${raw}`;
}

const CYCLE_INDEXING_WINDOW_MS = 20 * 60 * 1_000;

function isPositiveNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

type AttemptOutcome = ProverAttempt["outcome"] | ClaimAttempt["outcome"];

function attemptOutcomeLabel(outcome: AttemptOutcome): string {
  switch (outcome) {
    case "in_progress":
      return "In Progress";
    case "success":
      return "Succeeded";
    case "failed":
      return "Failed";
    default:
      return outcome;
  }
}

/** Returns a string describing what a synthetic (non-hex) tx hash means. */
function syntheticTxNote(txHash: string | null | undefined): string | null {
  if (txHash === "superseded-by-higher-score") {
    return "A higher score for this seed was already on-chain — this claim was not needed";
  }
  if (txHash === "prior-attempt") {
    return "Claim landed in a prior delivery — tx hash not captured";
  }
  return null;
}

function claimStatusLabel(status: string, txHash?: string | null): string {
  if (status === "succeeded" && txHash === "superseded-by-higher-score") {
    return "Superseded";
  }
  switch (status) {
    case "queued":
      return "Queued";
    case "submitting":
      return "Submitting";
    case "retrying":
      return "Retrying";
    case "succeeded":
      return "Succeeded";
    case "failed":
      return "Failed";
    default:
      return status;
  }
}

function claimStatusColor(status: string, txHash?: string | null): string {
  if (status === "succeeded" && txHash === "superseded-by-higher-score") {
    return "text-purple-400";
  }
  switch (status) {
    case "succeeded":
      return "text-secondary";
    case "failed":
      return "text-destructive";
    case "retrying":
      return "text-warning";
    case "submitting":
    case "queued":
      return "text-primary";
    default:
      return "text-muted-foreground";
  }
}

export function ProofJobCard({
  job: initialJob,
  onJobUpdate,
  readOnly,
}: {
  job: ProofJobPublic;
  onJobUpdate?: (job: ProofJobPublic) => void;
  readOnly?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [job, setJob] = useState(initialJob);
  const [claimRetrying, setClaimRetrying] = useState(false);
  const [claimRetryError, setClaimRetryError] = useState<string | null>(null);
  const [proofRetrying, setProofRetrying] = useState(false);
  const [proofRetryError, setProofRetryError] = useState<string | null>(null);
  const [fastPollingMode, setFastPollingMode] = useState<"claim" | "proof" | null>(null);
  const onJobUpdateRef = useRef(onJobUpdate);
  onJobUpdateRef.current = onJobUpdate;
  const cycleBackfillInFlightRef = useRef(false);

  // Keep in sync with parent prop updates — only if parent is strictly newer
  // to avoid overwriting local state after a retry API response.
  useEffect(() => {
    if (claimRetrying || proofRetrying) return;
    if (new Date(initialJob.updatedAt) > new Date(job.updatedAt)) {
      setJob(initialJob);
    }
  }, [initialJob, job.updatedAt, claimRetrying, proofRetrying]);

  // Fast-poll this specific job after a manual retry until the target phase settles.
  useEffect(() => {
    if (!fastPollingMode) return;

    const INTERVAL_MS = 2_500;
    const TIMEOUT_MS = 60_000;
    const startedAt = Date.now();

    const timerId = setInterval(() => {
      if (Date.now() - startedAt > TIMEOUT_MS) {
        setFastPollingMode(null);
        return;
      }
      void (async () => {
        try {
          const response = await getProofJob(job.jobId);
          const updated = response.job;
          setJob(updated);
          onJobUpdateRef.current?.(updated);
          if (fastPollingMode === "claim") {
            if (updated.claim.status === "succeeded" || updated.claim.status === "failed") {
              setFastPollingMode(null);
            }
            return;
          }
          if (updated.status === "succeeded" || updated.status === "failed") {
            setFastPollingMode(null);
          }
        } catch {
          // ignore transient poll errors
        }
      })();
    }, INTERVAL_MS);

    return () => clearInterval(timerId);
  }, [fastPollingMode, job.jobId]);

  const score = job.tape.metadata.finalScore;
  const backend = getActiveBackend(job);
  const result = job.result?.summary ?? null;
  const resultStats = result?.stats ?? null;
  const successAttempt = getSuccessfulAttempt(job);
  const successBackend = successAttempt?.backend ?? null;
  const wallClockMs =
    (successAttempt ? computeWallClockMs(successAttempt) : null) ?? computeJobWallClockMs(job);
  const resultElapsedMs = isPositiveNumber(result?.elapsedMs) ? result.elapsedMs : null;
  const vastCycles = isPositiveNumber(resultStats?.total_cycles) ? resultStats.total_cycles : null;
  const attemptTotalCycles = isPositiveNumber(successAttempt?.totalCycles)
    ? successAttempt.totalCycles
    : null;
  const totalCycles = vastCycles ?? attemptTotalCycles;
  const vastSegments = isPositiveNumber(resultStats?.segments) ? resultStats.segments : null;
  const actualCostUsd = successAttempt?.actualCostUsd;
  const maxPriceUsd = successAttempt?.maxPriceUsd;
  const proverAddr = successAttempt?.proverAddress;
  const waitingForBoundlessCycles =
    job.status === "succeeded" && successBackend === "boundless" && totalCycles == null;
  const cycleAnchorMs =
    parseIsoMs(successAttempt?.endedAt) ?? parseIsoMs(job.completedAt) ?? parseIsoMs(job.updatedAt);
  const isCycleIndexingPending =
    waitingForBoundlessCycles &&
    (cycleAnchorMs == null || Date.now() - cycleAnchorMs < CYCLE_INDEXING_WINDOW_MS);
  const cycleValue =
    totalCycles != null && vastSegments != null
      ? `${formatCycles(totalCycles)} · ${vastSegments.toLocaleString()} seg`
      : totalCycles != null
        ? formatCycles(totalCycles)
        : null;
  const durationLabel =
    resultElapsedMs != null
      ? "Proved In"
      : wallClockMs != null
        ? successBackend === "boundless"
          ? "Fulfilled In"
          : "Completed In"
        : null;
  const durationValue =
    resultElapsedMs != null
      ? formatDuration(resultElapsedMs)
      : wallClockMs != null
        ? formatDuration(wallClockMs)
        : null;
  const costLabel = actualCostUsd != null ? "Actual Cost" : maxPriceUsd != null ? "Max Cost" : null;
  const costValue =
    actualCostUsd != null
      ? formatCostUsd(actualCostUsd)
      : maxPriceUsd != null
        ? formatCostUsd(maxPriceUsd)
        : null;
  const proverValue = proverAddr ? `${proverAddr.slice(0, 6)}…${proverAddr.slice(-4)}` : null;
  const metricItems: Array<{
    key: string;
    label: string;
    value: string;
    icon?: React.ComponentType<{ className?: string }>;
    highlight?: boolean;
  }> = [];
  if (cycleValue != null) {
    metricItems.push({
      key: "cycles",
      label: "Total Cycles",
      value: cycleValue,
      icon: Cpu,
    });
  }
  if (durationLabel != null && durationValue != null) {
    metricItems.push({
      key: "duration",
      label: durationLabel,
      value: durationValue,
      icon: Zap,
      highlight: true,
    });
  }
  if (costLabel != null && costValue != null) {
    metricItems.push({
      key: "cost",
      label: costLabel,
      value: costValue,
      icon: DollarSign,
    });
  }
  if (proverValue != null) {
    metricItems.push({ key: "prover", label: "Prover", value: proverValue });
  }
  const showProofMetrics = metricItems.length > 0;
  const metricsColumnsLgClass =
    metricItems.length >= 4
      ? "lg:grid-cols-4"
      : metricItems.length === 3
        ? "lg:grid-cols-3"
        : metricItems.length === 2
          ? "lg:grid-cols-2"
          : "lg:grid-cols-1";
  const cycleBackfillJobId = expanded && isCycleIndexingPending ? job.jobId : null;

  // While expanded: for succeeded Boundless jobs missing cycles, poll single-job
  // reads so indexer backfill can appear without a page reload.
  useEffect(() => {
    if (!cycleBackfillJobId) return;

    let cancelled = false;
    let intervalId: number | null = null;

    const refresh = async () => {
      if (cycleBackfillInFlightRef.current) return;
      cycleBackfillInFlightRef.current = true;
      try {
        const response = await getProofJob(cycleBackfillJobId);
        if (cancelled) return;

        setJob(response.job);
        onJobUpdateRef.current?.(response.job);

        const refreshedAttempt = getSuccessfulAttempt(response.job);
        if (isPositiveNumber(refreshedAttempt?.totalCycles) && intervalId != null) {
          window.clearInterval(intervalId);
          intervalId = null;
        }
      } catch {
        // ignore — cycles will stay unavailable until a later refresh succeeds
      } finally {
        cycleBackfillInFlightRef.current = false;
      }
    };

    void refresh();
    intervalId = window.setInterval(refresh, 10_000);

    return () => {
      cancelled = true;
      if (intervalId != null) {
        window.clearInterval(intervalId);
      }
    };
  }, [cycleBackfillJobId]);

  const stellarTxUrl =
    job.claim.txHash && /^[0-9a-f]{64}$/i.test(job.claim.txHash)
      ? `${STELLAR_EXPLORER_BASE}/tx/${job.claim.txHash}`
      : null;
  const isClaimed = job.claim.status === "succeeded";
  const canRetryClaim = !readOnly && job.status === "succeeded" && job.claim.status === "failed";
  const canRetryProof = !readOnly && job.status === "failed" && !job.result;
  const hasProverAttempts = (job.proverAttempts?.length ?? 0) > 0;
  const showProverAttempts = hasProverAttempts || canRetryProof || proofRetryError != null;

  // Synthesize a single legacy attempt from aggregate tracking when
  // claimAttempts[] is empty but claim work has been done.
  let claimAttempts = job.claimAttempts ?? [];
  if (claimAttempts.length === 0 && job.claim.attempts > 0) {
    const outcome =
      job.claim.status === "succeeded"
        ? ("success" as const)
        : job.claim.status === "failed"
          ? ("failed" as const)
          : ("in_progress" as const);
    claimAttempts = [
      {
        index: 0,
        startedAt: job.claim.lastAttemptAt ?? job.updatedAt,
        endedAt: outcome !== "in_progress" ? (job.claim.submittedAt ?? job.updatedAt) : null,
        outcome,
        error: job.claim.lastError,
        errorDetail: null,
        txHash: job.claim.txHash,
      },
    ];
  }

  const showClaimInfo = job.status === "succeeded";
  const detailsId = `proof-job-details-${job.jobId}`;

  async function handleRetryClaim() {
    setClaimRetrying(true);
    setClaimRetryError(null);
    try {
      const response = await retryFailedClaim(job.jobId);
      setJob(response.job);
      onJobUpdate?.(response.job);
      setFastPollingMode("claim");
    } catch (err) {
      setClaimRetryError(err instanceof Error ? err.message : "retry failed");
    } finally {
      setClaimRetrying(false);
    }
  }

  async function handleRetryProof() {
    setProofRetrying(true);
    setProofRetryError(null);
    try {
      const response = await retryFailedProof(job.jobId);
      setJob(response.job);
      onJobUpdate?.(response.job);
      setFastPollingMode("proof");
    } catch (err) {
      setProofRetryError(err instanceof Error ? err.message : "retry failed");
    } finally {
      setProofRetrying(false);
    }
  }

  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border transition-colors",
        isClaimed
          ? "border-secondary/25 bg-[radial-gradient(circle_at_0%_0%,rgba(102,231,196,0.06),transparent_50%),linear-gradient(160deg,rgba(8,16,29,0.84),rgba(6,13,24,0.96))]"
          : "border-border/40 bg-[radial-gradient(circle_at_12%_8%,rgba(94,165,255,0.08),transparent_42%),linear-gradient(160deg,rgba(8,16,29,0.84),rgba(6,13,24,0.96))]",
        "shadow-[0_8px_24px_rgba(0,0,0,0.25),inset_0_1px_0_rgba(255,255,255,0.04)]",
      )}
    >
      {/* Main row - always visible */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-controls={detailsId}
        aria-label={expanded ? "Hide Proof Details" : "Show Proof Details"}
        className="flex w-full cursor-pointer items-center gap-3 bg-transparent px-4 py-3 text-left transition-colors hover:bg-[rgba(16,38,64,0.25)]"
      >
        {/* Score */}
        <div className="min-w-[60px]">
          <span className="flex items-center gap-1.5">
            <Trophy className="size-3.5 text-secondary" aria-hidden="true" />
            <span className="font-display text-lg tabular-nums font-semibold tracking-tight text-card-foreground">
              {score.toLocaleString()}
            </span>
          </span>
        </div>

        {/* Seed */}
        <span className="hidden text-xs tabular-nums text-muted-foreground sm:block">
          {formatHex32(job.tape.metadata.seed)}
        </span>

        {/* Status badge */}
        <div className="flex-1">
          <ProofStatusBadge job={job} />
        </div>

        {/* Backend */}
        {backend && (
          <div className="hidden sm:block">
            <BackendBadge backend={backend} />
          </div>
        )}

        {/* Time */}
        <span className="hidden text-xs text-muted-foreground sm:block">
          {timeAgo(job.createdAt)}
        </span>

        {/* Expand */}
        <ChevronDown
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            expanded && "rotate-180",
          )}
          aria-hidden="true"
        />
      </button>

      {/* Expanded details */}
      {expanded && (
        <div id={detailsId} className="grid gap-4 border-t border-border/20 px-4 py-4">
          {/* Stats grid */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatItem icon={Trophy} label="Score" value={score.toLocaleString()} />
            <StatItem label="Seed" value={formatHex32(job.tape.metadata.seed)} />
            <StatItem
              icon={Clock}
              label="Frames"
              value={job.tape.metadata.frameCount.toLocaleString()}
            />
            <StatItem label="Tape Size" value={formatBytes(job.tape.sizeBytes)} />
          </div>

          {/* Proof metrics */}
          {showProofMetrics && (
            <div>
              <h4 className="m-0 mb-2 font-display text-[0.65rem] uppercase tracking-[0.08em] text-muted-foreground">
                Proof Metrics
              </h4>
              <div className={cn("grid grid-cols-2 gap-3", metricsColumnsLgClass)}>
                {metricItems.map((metric) => (
                  <StatItem
                    key={metric.key}
                    icon={metric.icon}
                    label={metric.label}
                    value={metric.value}
                    highlight={metric.highlight}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Attempt history */}
          {showProverAttempts && (
            <div>
              <h4 className="m-0 mb-2 font-display text-[0.65rem] uppercase tracking-[0.08em] text-muted-foreground">
                Prover Attempts ({job.proverAttempts.length})
                {canRetryProof && (
                  <button
                    type="button"
                    onClick={handleRetryProof}
                    disabled={proofRetrying}
                    className={cn(
                      "ml-2 inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-2 py-0.5 text-[0.65rem] normal-case tracking-normal text-primary transition-colors hover:bg-primary/10",
                      proofRetrying && "cursor-not-allowed opacity-50",
                    )}
                  >
                    <RotateCw className={cn("size-3", proofRetrying && "animate-spin")} />
                    {proofRetrying ? "Retrying…" : "Retry"}
                  </button>
                )}
              </h4>
              {proofRetryError && (
                <p className="m-0 mb-2 text-xs text-destructive/80">
                  Retry failed. Refresh and try again: {proofRetryError}
                </p>
              )}
              {hasProverAttempts ? (
                <div className="grid gap-1.5">
                  {job.proverAttempts.map((attempt) => {
                    const explorerUrl = attempt.statusUrl
                      ? boundlessExplorerUrl(attempt.statusUrl)
                      : null;
                    return (
                      <div
                        key={attempt.index}
                        className="flex flex-wrap items-center gap-2 rounded-lg border border-border/15 bg-[rgba(8,16,29,0.4)] px-3 py-2 text-xs"
                      >
                        <span className="tabular-nums text-muted-foreground">
                          #{attempt.index + 1}
                        </span>
                        <BackendBadge backend={attempt.backend} />
                        <span
                          className={cn(
                            "font-display uppercase tracking-wide",
                            attempt.outcome === "success" && "text-secondary",
                            attempt.outcome === "failed" && "text-destructive",
                            attempt.outcome === "in_progress" && "text-primary",
                          )}
                        >
                          {attemptOutcomeLabel(attempt.outcome)}
                        </span>
                        {attempt.endedAt && (
                          <span className="text-muted-foreground">{timeAgo(attempt.endedAt)}</span>
                        )}
                        {attempt.fulfillmentTxHash && (
                          <a
                            href={`https://basescan.org/tx/${attempt.fulfillmentTxHash}`}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-secondary no-underline hover:underline"
                            onClick={(e) => e.stopPropagation()}
                          >
                            Tx
                            <ExternalLink className="size-3" aria-hidden="true" />
                          </a>
                        )}
                        {explorerUrl && (
                          <a
                            href={explorerUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="ml-auto inline-flex items-center gap-1 text-primary no-underline hover:underline"
                            onClick={(e) => e.stopPropagation()}
                          >
                            Explorer
                            <ExternalLink className="size-3" aria-hidden="true" />
                          </a>
                        )}
                        {attempt.error && (
                          <ErrorDetailDialog error={attempt.errorDetail ?? attempt.error}>
                            <button
                              type="button"
                              className="m-0 w-full cursor-pointer truncate bg-transparent text-left text-xs text-destructive/80 hover:text-destructive"
                              onClick={(e) => e.stopPropagation()}
                            >
                              {attempt.error}
                            </button>
                          </ErrorDetailDialog>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="m-0 text-xs text-muted-foreground">
                  No prover attempts are recorded for this failed proof yet.
                </p>
              )}
            </div>
          )}

          {/* Claim status */}
          {showClaimInfo && (
            <div>
              <h4 className="m-0 mb-2 font-display text-[0.65rem] uppercase tracking-[0.08em] text-muted-foreground">
                Claim
                <span
                  className={cn(
                    "ml-2 normal-case tracking-normal",
                    claimStatusColor(job.claim.status, job.claim.txHash),
                  )}
                >
                  {claimStatusLabel(job.claim.status, job.claim.txHash)}
                </span>
                {canRetryClaim && (
                  <button
                    type="button"
                    onClick={handleRetryClaim}
                    disabled={claimRetrying}
                    className={cn(
                      "ml-2 inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-2 py-0.5 text-[0.65rem] normal-case tracking-normal text-primary transition-colors hover:bg-primary/10",
                      claimRetrying && "cursor-not-allowed opacity-50",
                    )}
                  >
                    <RotateCw className={cn("size-3", claimRetrying && "animate-spin")} />
                    {claimRetrying ? "Retrying…" : "Retry"}
                  </button>
                )}
              </h4>
              {claimRetryError && (
                <p className="m-0 mb-2 text-xs text-destructive/80">
                  Retry failed. Refresh and try again: {claimRetryError}
                </p>
              )}
              {claimAttempts.length === 0 ? (
                <p className="m-0 text-xs text-muted-foreground">
                  No claim attempts yet. Submission starts automatically.
                </p>
              ) : (
                <div className="grid gap-1.5">
                  {claimAttempts.map((attempt) => (
                    <div
                      key={attempt.index}
                      className="flex flex-wrap items-center gap-2 rounded-lg border border-border/15 bg-[rgba(8,16,29,0.4)] px-3 py-2 text-xs"
                    >
                      <span className="tabular-nums text-muted-foreground">
                        #{attempt.index + 1}
                      </span>
                      <span
                        className={cn(
                          "font-display uppercase tracking-wide",
                          attempt.outcome === "success" && "text-secondary",
                          attempt.outcome === "failed" && "text-destructive",
                          attempt.outcome === "in_progress" && "text-primary",
                        )}
                      >
                        {attemptOutcomeLabel(attempt.outcome)}
                      </span>
                      {attempt.endedAt && (
                        <span className="text-muted-foreground">{timeAgo(attempt.endedAt)}</span>
                      )}
                      {attempt.txHash && /^[0-9a-f]{64}$/i.test(attempt.txHash) && (
                        <a
                          href={`${STELLAR_EXPLORER_BASE}/tx/${attempt.txHash}`}
                          target="_blank"
                          rel="noreferrer"
                          className="ml-auto inline-flex items-center gap-1 text-secondary no-underline hover:underline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          Tx
                          <ExternalLink className="size-3" aria-hidden="true" />
                        </a>
                      )}
                      {syntheticTxNote(attempt.txHash) && (
                        <p className="m-0 w-full text-xs text-muted-foreground">
                          {syntheticTxNote(attempt.txHash)}
                        </p>
                      )}
                      {attempt.error && (
                        <ErrorDetailDialog error={attempt.errorDetail ?? attempt.error}>
                          <button
                            type="button"
                            className="m-0 w-full cursor-pointer truncate bg-transparent text-left text-xs text-destructive/80 hover:text-destructive"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {attempt.error}
                          </button>
                        </ErrorDetailDialog>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Links */}
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => navigate(`/?replay=${job.jobId}`)}
              className="inline-flex cursor-pointer items-center gap-1.5 bg-transparent text-sm text-primary transition-colors hover:text-primary/80"
            >
              <Play className="size-3.5" aria-hidden="true" />
              Play Tape
            </button>
            <a
              href={getTapeDownloadUrl(job.jobId)}
              download
              className="inline-flex items-center gap-1.5 text-sm text-primary no-underline hover:underline"
            >
              <Download className="size-3.5" aria-hidden="true" />
              Download Tape
            </a>
            {stellarTxUrl && (
              <a
                href={stellarTxUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-sm text-secondary no-underline hover:underline"
              >
                <ExternalLink className="size-3.5" aria-hidden="true" />
                Stellar Tx
              </a>
            )}
          </div>

          {/* Errors */}
          {job.error && (
            <div className="rounded-lg border border-destructive/40 bg-[rgba(125,32,32,0.25)] px-3 py-2.5 text-sm text-destructive">
              {job.error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StatItem({
  icon: Icon,
  label,
  value,
  highlight,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div className="rounded-lg border border-border/15 bg-[rgba(8,16,29,0.3)] px-3 py-2">
      <p className="m-0 font-display text-[0.6rem] uppercase tracking-[0.06em] text-muted-foreground">
        {Icon && <Icon className="mr-1 inline size-3" aria-hidden="true" />}
        {label}
      </p>
      <p
        className={cn(
          "m-0 mt-0.5 text-sm tabular-nums",
          highlight ? "font-semibold text-secondary" : "text-card-foreground",
        )}
      >
        {value}
      </p>
    </div>
  );
}
