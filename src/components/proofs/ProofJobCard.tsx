import { useState } from "react";
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
import type { ProofJobPublic, ProverAttempt } from "@/proof/api";
import { getTapeDownloadUrl, retryFailedClaim } from "@/proof/api";
import { ErrorDetailDialog } from "./ErrorDetailDialog";
import { boundlessExplorerUrl, getActiveBackend } from "@/proof/helpers";
import { formatBytes, formatDuration, formatHex32 } from "@/lib/format";
import { timeAgo } from "@/lib/time";
import { cn } from "@/lib/utils";
import { STELLAR_EXPLORER_TESTNET_BASE } from "@/consts";
import { navigate } from "@/hooks/useLocation";
import { ProofStatusBadge } from "./ProofStatusBadge";
import { BackendBadge } from "./BackendBadge";

function getSuccessfulAttempt(job: ProofJobPublic): ProverAttempt | null {
  return job.proverAttempts?.find((a) => a.outcome === "success") ?? null;
}

function computeWallClockMs(attempt: ProverAttempt): number | null {
  if (!attempt.startedAt || !attempt.endedAt) return null;
  const ms = new Date(attempt.endedAt).getTime() - new Date(attempt.startedAt).getTime();
  return ms > 0 ? ms : null;
}

function formatCostUsd(usd: number): string {
  if (usd < 0.01) return `<$0.01`;
  return `$${usd.toFixed(2)}`;
}

function claimStatusLabel(status: string): string {
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

function claimStatusColor(status: string): string {
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
}: {
  job: ProofJobPublic;
  onJobUpdate?: (job: ProofJobPublic) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [job, setJob] = useState(initialJob);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  // Keep in sync with parent prop updates
  if (initialJob.updatedAt !== job.updatedAt && !retrying) {
    setJob(initialJob);
  }

  const score = job.tape.metadata.finalScore;
  const backend = getActiveBackend(job);
  const result = job.result?.summary ?? null;
  const stellarTxUrl = job.claim.txHash
    ? `${STELLAR_EXPLORER_TESTNET_BASE}/tx/${job.claim.txHash}`
    : null;
  const isClaimed = job.claim.status === "succeeded";
  const canRetryClaim = job.status === "succeeded" && job.claim.status === "failed";

  // Synthesize a single legacy attempt from aggregate tracking when
  // claimAttempts[] is empty but claim work has been done.
  let claimAttempts = job.claimAttempts ?? [];
  if (claimAttempts.length === 0 && job.claim.attempts > 0) {
    const outcome =
      job.claim.status === "succeeded"
        ? "success" as const
        : job.claim.status === "failed"
          ? "failed" as const
          : "in_progress" as const;
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

  const showClaimInfo =
    job.status === "succeeded" && claimAttempts.length > 0;

  async function handleRetryClaim() {
    setRetrying(true);
    setRetryError(null);
    try {
      const response = await retryFailedClaim(job.jobId);
      setJob(response.job);
      onJobUpdate?.(response.job);
    } catch (err) {
      setRetryError(err instanceof Error ? err.message : "retry failed");
    } finally {
      setRetrying(false);
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
        onClick={() => setExpanded((v) => !v)}
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
        <div className="grid gap-4 border-t border-border/20 px-4 py-4">
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

          {/* Proof results — VastAI provides cycles/segments/elapsed; Boundless does not */}
          {result &&
            (() => {
              const hasProverStats = result.stats.total_cycles > 0 || result.stats.segments > 0;
              const successAttempt = getSuccessfulAttempt(job);
              const wallClockMs = successAttempt ? computeWallClockMs(successAttempt) : null;
              const maxPriceUsd = successAttempt?.maxPriceUsd;

              const actualCostUsd = successAttempt?.actualCostUsd;
              const proverAddr = successAttempt?.proverAddress;

              return hasProverStats ? (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  <StatItem
                    icon={Cpu}
                    label="Total Cycles"
                    value={result.stats.total_cycles.toLocaleString()}
                  />
                  <StatItem label="Segments" value={result.stats.segments.toLocaleString()} />
                  <StatItem
                    icon={Zap}
                    label="Proved In"
                    value={formatDuration(result.elapsedMs)}
                    highlight
                  />
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  {wallClockMs != null && (
                    <StatItem
                      icon={Zap}
                      label="Fulfilled In"
                      value={formatDuration(wallClockMs)}
                      highlight
                    />
                  )}
                  {actualCostUsd != null ? (
                    <StatItem
                      icon={DollarSign}
                      label="Actual Cost"
                      value={formatCostUsd(actualCostUsd)}
                    />
                  ) : maxPriceUsd != null ? (
                    <StatItem
                      icon={DollarSign}
                      label="Max Cost"
                      value={formatCostUsd(maxPriceUsd)}
                    />
                  ) : null}
                  {proverAddr && (
                    <StatItem
                      label="Prover"
                      value={`${proverAddr.slice(0, 6)}...${proverAddr.slice(-4)}`}
                    />
                  )}
                </div>
              );
            })()}

          {/* Attempt history */}
          {job.proverAttempts && job.proverAttempts.length > 0 && (
            <div>
              <h4 className="m-0 mb-2 font-display text-[0.65rem] uppercase tracking-[0.08em] text-muted-foreground">
                Prover Attempts ({job.proverAttempts.length})
              </h4>
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
                        {attempt.outcome === "in_progress" ? "In Progress" : attempt.outcome}
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
                          <ExternalLink className="size-3" />
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
                          <ExternalLink className="size-3" />
                        </a>
                      )}
                      {attempt.error && (
                        <ErrorDetailDialog error={attempt.errorDetail ?? attempt.error}>
                          <button
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
            </div>
          )}

          {/* Claim status — shown when proof succeeded and claim has been attempted */}
          {showClaimInfo && (
            <div>
              <h4 className="m-0 mb-2 font-display text-[0.65rem] uppercase tracking-[0.08em] text-muted-foreground">
                Claim
                <span className={cn("ml-2 normal-case tracking-normal", claimStatusColor(job.claim.status))}>
                  {claimStatusLabel(job.claim.status)}
                </span>
                {canRetryClaim && (
                  <button
                    onClick={handleRetryClaim}
                    disabled={retrying}
                    className={cn(
                      "ml-2 inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-2 py-0.5 text-[0.65rem] normal-case tracking-normal text-primary transition-colors hover:bg-primary/10",
                      retrying && "cursor-not-allowed opacity-50",
                    )}
                  >
                    <RotateCw className={cn("size-3", retrying && "animate-spin")} />
                    {retrying ? "Retrying..." : "Retry"}
                  </button>
                )}
              </h4>
              {retryError && (
                <p className="m-0 mb-2 text-xs text-destructive/80">Retry error: {retryError}</p>
              )}
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
                      {attempt.outcome === "in_progress" ? "In Progress" : attempt.outcome}
                    </span>
                    {attempt.endedAt && (
                      <span className="text-muted-foreground">{timeAgo(attempt.endedAt)}</span>
                    )}
                    {attempt.txHash && (
                      <a
                        href={`${STELLAR_EXPLORER_TESTNET_BASE}/tx/${attempt.txHash}`}
                        target="_blank"
                        rel="noreferrer"
                        className="ml-auto inline-flex items-center gap-1 text-secondary no-underline hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        Tx
                        <ExternalLink className="size-3" />
                      </a>
                    )}
                    {attempt.error && (
                      <ErrorDetailDialog error={attempt.errorDetail ?? attempt.error}>
                        <button
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
            </div>
          )}

          {/* Links */}
          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={() => navigate(`/?replay=${job.jobId}`)}
              className="inline-flex cursor-pointer items-center gap-1.5 bg-transparent text-sm text-primary transition-colors hover:text-primary/80"
            >
              <Play className="size-3.5" />
              Play Tape
            </button>
            <a
              href={getTapeDownloadUrl(job.jobId)}
              download
              className="inline-flex items-center gap-1.5 text-sm text-primary no-underline hover:underline"
            >
              <Download className="size-3.5" />
              Download Tape
            </a>
            {stellarTxUrl && (
              <a
                href={stellarTxUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-sm text-secondary no-underline hover:underline"
              >
                <ExternalLink className="size-3.5" />
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
