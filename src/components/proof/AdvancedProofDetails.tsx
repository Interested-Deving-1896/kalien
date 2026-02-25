import { ChevronDown, FileText, Upload } from "lucide-react";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { ErrorMessage } from "@/components/shared/ErrorMessage";
import { StatCard, StatGrid } from "@/components/shared/StatCard";
import { cn } from "@/lib/utils";
import {
  formatHex32,
  abbreviateHex,
  formatDuration,
  abbreviateAddress,
} from "@/lib/format";
import { formatUtcDateTime } from "@/time";
import { TAPE_HEADER_SIZE, TAPE_FOOTER_SIZE } from "@/game/tape";
import type { ProofJobPublic, GatewayHealthResponse } from "@/proof/api";
import type { CompletedGameRun } from "../AsteroidsCanvas";

export interface AdvancedProofDetailsProps {
  job: ProofJobPublic | null;
  health: GatewayHealthResponse | null;
  healthError: string | null;
  run: CompletedGameRun | null;
  walletAddress: string;
  networkPassphrase: string;
  relayerMode: string;
  credentialId: string | null;
  onLoadTape: () => void;
  proofBusy: boolean;
  className?: string;
}

export function AdvancedProofDetails({
  job,
  health,
  healthError,
  run,
  walletAddress,
  networkPassphrase,
  relayerMode,
  credentialId,
  onLoadTape,
  proofBusy,
  className,
}: AdvancedProofDetailsProps) {
  const proverStatus = health?.prover.status ?? "degraded";

  return (
    <Collapsible data-slot="advanced-proof-details" className={cn("w-full", className)}>
      <CollapsibleTrigger
        className={cn(
          "group flex w-full cursor-pointer items-center gap-2 rounded-lg border border-border/30 bg-transparent px-3 py-2",
          "font-display text-xs uppercase tracking-[0.06em] text-muted-foreground",
          "transition-colors hover:border-border/50 hover:text-card-foreground",
        )}
        aria-label="Toggle advanced details"
      >
        <ChevronDown
          className="size-4 transition-transform group-data-[state=open]:rotate-180"
          aria-hidden="true"
        />
        Advanced Details
      </CollapsibleTrigger>

      <CollapsibleContent className="mt-2 grid gap-3">
        {/* Gateway Health */}
        <DetailSection title="Gateway Health">
          <div
            className={cn(
              "grid gap-1 rounded-lg border p-2.5",
              proverStatus === "compatible"
                ? "border-[rgba(122,231,174,0.35)] bg-[rgba(10,36,29,0.45)]"
                : "border-[rgba(255,165,129,0.35)] bg-[rgba(42,22,15,0.42)]",
            )}
          >
            <DetailRow label="Status">
              {health
                ? proverStatus === "compatible"
                  ? "Compatible"
                  : "Degraded"
                : "Loading..."}
            </DetailRow>

            {health?.prover.status === "compatible" && (
              <>
                <DetailRow label="Ruleset">
                  {health.prover.ruleset} /{" "}
                  {health.prover.rules_digest_hex.toUpperCase()}
                </DetailRow>
                <DetailRow label="Prover Image">
                  <code className="text-card-foreground">
                    {abbreviateHex(health.prover.image_id)}
                  </code>
                  {health.expected.image_id ? " (pinned)" : ""}
                </DetailRow>
              </>
            )}

            {health?.prover.status === "degraded" && (
              <ErrorMessage
                message={health.prover.error}
                severity="warning"
              />
            )}

            <ErrorMessage message={healthError} severity="warning" />
          </div>
        </DetailSection>

        {/* Tape / Game Run Metadata */}
        {run && (
          <DetailSection title="Tape Metadata">
            <StatGrid columns={3}>
              <StatCard
                label="Score"
                value={run.record.finalScore.toLocaleString()}
              />
              <StatCard
                label="Frames"
                value={run.frameCount.toLocaleString()}
              />
              <StatCard
                label="Seed"
                value={formatHex32(run.record.seed)}
              />
              <StatCard
                label="Final RNG"
                value={formatHex32(run.record.finalRngState)}
              />
              <StatCard
                label="Tape Bytes"
                value={(
                  TAPE_HEADER_SIZE +
                  run.frameCount +
                  TAPE_FOOTER_SIZE
                ).toLocaleString()}
              />
              <StatCard
                label="Captured"
                value={formatUtcDateTime(run.endedAtMs)}
              />
            </StatGrid>
          </DetailSection>
        )}

        {/* Job Details */}
        {job && (
          <DetailSection title="Job Details">
            <div className="grid gap-1.5 rounded-lg border border-[rgba(104,161,237,0.28)] bg-[rgba(9,18,33,0.7)] p-2.5">
              <DetailRow label="Job ID">
                <code className="break-all">{job.jobId}</code>
              </DetailRow>
              <DetailRow label="Created">
                {formatUtcDateTime(job.createdAt)}
              </DetailRow>
              <DetailRow label="Updated">
                {formatUtcDateTime(job.updatedAt)}
              </DetailRow>
              {job.completedAt && (
                <DetailRow label="Completed">
                  {formatUtcDateTime(job.completedAt)}
                </DetailRow>
              )}
              <DetailRow label="Queue Attempts">
                {job.queue.attempts}
              </DetailRow>
              {job.queue.lastError && (
                <ErrorMessage
                  message={`Last retry: ${job.queue.lastError}`}
                  severity="warning"
                />
              )}
              {job.result?.summary && (
                <>
                  <div className="mt-1 border-t border-secondary/30 pt-1.5" />
                  <DetailRow label="Proof Time">
                    {formatDuration(job.result.summary.elapsedMs)}
                  </DetailRow>
                  <DetailRow label="Receipt">
                    {job.result.summary.producedReceiptKind ??
                      job.result.summary.requestedReceiptKind}
                  </DetailRow>
                  <DetailRow label="Verified Score">
                    {job.result.summary.journal.final_score.toLocaleString()}
                  </DetailRow>
                  <DetailRow label="Verified Frames">
                    {job.result.summary.journal.frame_count.toLocaleString()}
                  </DetailRow>
                  <DetailRow label="Segments">
                    {job.result.summary.stats.segments.toLocaleString()}
                  </DetailRow>
                  <DetailRow label="Claim">
                    {job.claim.status}
                  </DetailRow>
                  {job.claim.txHash && (
                    <DetailRow label="Tx Hash">
                      <code className="break-all">{job.claim.txHash}</code>
                    </DetailRow>
                  )}
                </>
              )}
              {job.claim.lastError && (
                <ErrorMessage
                  message={`Auto claim: ${job.claim.lastError}`}
                  severity="warning"
                />
              )}
              {job.error && (
                <ErrorMessage message={job.error} />
              )}
            </div>
          </DetailSection>
        )}

        {/* Wallet / Network info */}
        <DetailSection title="Network">
          <div className="grid gap-1 text-sm text-muted-foreground">
            {walletAddress && (
              <DetailRow label="Address">
                <code className="text-card-foreground">
                  {abbreviateAddress(walletAddress)}
                </code>
              </DetailRow>
            )}
            <DetailRow label="Network">{networkPassphrase}</DetailRow>
            <DetailRow label="Relayer">
              {relayerMode === "configured"
                ? "Configured"
                : "Not Configured"}
            </DetailRow>
            {credentialId && (
              <DetailRow label="Credential">
                <code className="text-card-foreground">
                  {abbreviateHex(credentialId, 10)}
                </code>
              </DetailRow>
            )}
          </div>
        </DetailSection>

        {/* Action buttons */}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={onLoadTape}
            disabled={proofBusy}
            aria-label="Load a tape file"
          >
            <Upload className="size-3.5" aria-hidden="true" />
            Load Tape
          </Button>

          {job?.result && (
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                const res = await fetch(
                  `/api/proofs/jobs/${job.jobId}/result`,
                );
                const blob = new Blob([await res.text()], {
                  type: "application/json",
                });
                const url = URL.createObjectURL(blob);
                window.open(url, "_blank");
                URL.revokeObjectURL(url);
              }}
              aria-label="Open raw proof JSON"
            >
              <FileText className="size-3.5" aria-hidden="true" />
              Raw Proof JSON
            </Button>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function DetailSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <h3 className="m-0 font-display text-[0.7rem] uppercase tracking-[0.08em] text-muted-foreground">
        {title}
      </h3>
      {children}
    </div>
  );
}

function DetailRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <p className="m-0 text-sm leading-relaxed">
      <strong className="text-[rgba(146,182,233,0.9)]">{label}:</strong>{" "}
      <span className="text-card-foreground">{children}</span>
    </p>
  );
}
