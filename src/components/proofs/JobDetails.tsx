import type * as React from "react";
import { ExternalLink, Download } from "lucide-react";
import type { ProofJobPublic, ProverAttempt } from "@/proof/api";
import { getTapeDownloadUrl } from "@/proof/api";
import { formatDuration } from "@/lib/format";
import { formatUtcDateTime, timeAgo } from "@/time";
import { BackendBadge } from "./BackendBadge";

function formatSeedHex(seed: number): string {
  return `0x${(seed >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function boundlessExplorerUrl(statusUrl: string): string | null {
  if (!statusUrl.startsWith("boundless:")) return null;
  const requestId = statusUrl.slice("boundless:".length);
  try {
    const hex = BigInt(requestId).toString(16);
    return `https://explorer.beboundless.xyz/requests/0x${hex}`;
  } catch {
    return null;
  }
}

function AttemptRow({ attempt }: { attempt: ProverAttempt }) {
  const explorerUrl = attempt.statusUrl ? boundlessExplorerUrl(attempt.statusUrl) : null;

  return (
    <tr className="border-t border-[rgba(104,161,237,0.15)]">
      <td className="py-1.5 pr-3 text-sm tabular-nums text-muted-foreground">
        #{attempt.index + 1}
      </td>
      <td className="py-1.5 pr-3">
        <BackendBadge backend={attempt.backend} />
      </td>
      <td className="py-1.5 pr-3 text-sm text-muted-foreground">
        {formatUtcDateTime(attempt.startedAt)}
      </td>
      <td className="py-1.5 pr-3 text-sm text-muted-foreground">
        {attempt.endedAt ? timeAgo(attempt.endedAt) : "—"}
      </td>
      <td className="py-1.5 pr-3">
        <span
          className={
            attempt.outcome === "success"
              ? "text-secondary text-sm font-display uppercase tracking-wide"
              : attempt.outcome === "failed"
                ? "text-destructive text-sm font-display uppercase tracking-wide"
                : "text-primary text-sm font-display uppercase tracking-wide"
          }
        >
          {attempt.outcome === "in_progress" ? "In Progress" : attempt.outcome}
        </span>
        {attempt.error && <p className="m-0 mt-0.5 text-xs text-destructive/80">{attempt.error}</p>}
      </td>
      <td className="py-1.5 text-sm">
        {explorerUrl && (
          <a
            href={explorerUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-primary no-underline hover:underline"
          >
            Explorer
            <ExternalLink className="size-3" />
          </a>
        )}
      </td>
    </tr>
  );
}

export function JobDetails({ job }: { job: ProofJobPublic }) {
  const seed = job.tape.metadata.seed;
  const frameCount = job.tape.metadata.frameCount;
  const tapeSize = job.tape.sizeBytes;
  const result = job.result?.summary ?? null;

  const stellarTxUrl = job.claim.txHash
    ? `https://stellar.expert/explorer/testnet/tx/${job.claim.txHash}`
    : null;

  return (
    <div className="grid gap-4 rounded-b-lg border border-t-0 border-[rgba(104,161,237,0.2)] bg-[rgba(7,13,24,0.7)] px-4 py-4">
      {/* Game Info */}
      <section className="grid gap-2">
        <h4 className="m-0 font-display text-[0.7rem] uppercase tracking-[0.08em] text-muted-foreground">
          Game Info
        </h4>
        <div className="grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-4">
          <DetailItem label="Score">{job.tape.metadata.finalScore.toLocaleString()}</DetailItem>
          <DetailItem label="Seed">{formatSeedHex(seed)}</DetailItem>
          <DetailItem label="Frames">{frameCount.toLocaleString()}</DetailItem>
          <DetailItem label="Tape Size">{formatBytes(tapeSize)}</DetailItem>
        </div>
      </section>

      {/* Proof Stats */}
      {result && (
        <section className="grid gap-2">
          <h4 className="m-0 font-display text-[0.7rem] uppercase tracking-[0.08em] text-muted-foreground">
            Proof Stats
          </h4>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-3">
            <DetailItem label="Total Cycles">
              {result.stats.total_cycles.toLocaleString()}
            </DetailItem>
            <DetailItem label="User Cycles">{result.stats.user_cycles.toLocaleString()}</DetailItem>
            <DetailItem label="Segments">{result.stats.segments.toLocaleString()}</DetailItem>
            <DetailItem label="Elapsed">{formatDuration(result.elapsedMs)}</DetailItem>
            <DetailItem label="Receipt Kind">
              {result.producedReceiptKind ?? result.requestedReceiptKind}
            </DetailItem>
          </div>
        </section>
      )}

      {/* Attempt History */}
      {job.proverAttempts && job.proverAttempts.length > 0 && (
        <section className="grid gap-2">
          <h4 className="m-0 font-display text-[0.7rem] uppercase tracking-[0.08em] text-muted-foreground">
            Attempt History
          </h4>
          <div className="overflow-x-auto rounded-lg border border-[rgba(104,161,237,0.2)]">
            <table className="w-full min-w-[600px]">
              <thead>
                <tr className="border-b border-[rgba(104,161,237,0.2)]">
                  <th className="px-0 pb-2 pr-3 pt-2 text-left font-display text-[0.65rem] uppercase tracking-[0.06em] text-muted-foreground">
                    #
                  </th>
                  <th className="pb-2 pr-3 pt-2 text-left font-display text-[0.65rem] uppercase tracking-[0.06em] text-muted-foreground">
                    Backend
                  </th>
                  <th className="pb-2 pr-3 pt-2 text-left font-display text-[0.65rem] uppercase tracking-[0.06em] text-muted-foreground">
                    Started
                  </th>
                  <th className="pb-2 pr-3 pt-2 text-left font-display text-[0.65rem] uppercase tracking-[0.06em] text-muted-foreground">
                    Ended
                  </th>
                  <th className="pb-2 pr-3 pt-2 text-left font-display text-[0.65rem] uppercase tracking-[0.06em] text-muted-foreground">
                    Outcome
                  </th>
                  <th className="pb-2 pt-2 text-left font-display text-[0.65rem] uppercase tracking-[0.06em] text-muted-foreground">
                    Link
                  </th>
                </tr>
              </thead>
              <tbody>
                {job.proverAttempts.map((attempt) => (
                  <AttemptRow key={attempt.index} attempt={attempt} />
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Links */}
      <section className="flex flex-wrap gap-3">
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
      </section>

      {/* Errors */}
      {job.error && (
        <div className="rounded-lg border border-destructive/40 bg-[rgba(125,32,32,0.25)] px-3 py-2.5 text-sm text-destructive">
          {job.error}
        </div>
      )}

      {job.claim.lastError && (
        <div className="rounded-lg border border-warning/40 bg-[rgba(42,22,15,0.42)] px-3 py-2.5 text-sm text-warning">
          Claim error: {job.claim.lastError}
        </div>
      )}
    </div>
  );
}

function DetailItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <p className="m-0 text-sm">
      <span className="block font-display text-[0.65rem] uppercase tracking-[0.06em] text-muted-foreground">
        {label}
      </span>
      <span className="text-card-foreground">{children}</span>
    </p>
  );
}
