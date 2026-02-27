import { Shield, Loader2, PartyPopper, XCircle, ExternalLink, Gamepad2 } from "lucide-react";
import type { ProofJobStatus } from "@/proof/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ErrorMessage } from "@/components/shared/ErrorMessage";
import { Link } from "@/components/shared/Link";
import { cn } from "@/lib/utils";
import { formatDuration } from "@/lib/format";

export interface ProofProgressProps {
  status: ProofJobStatus | "idle";
  friendlyStatus: string;
  isBusy: boolean;
  hasResult: boolean;
  error: string | null;
  elapsedMs?: number;
  verifiedScore?: number;
  onPlayAgain?: () => void;
  claimStatus?: "idle" | "submitting" | "succeeded" | "failed";
  claimTxHash?: string | null;
  claimError?: string | null;
  className?: string;
}

export function ProofProgress({
  status,
  friendlyStatus,
  isBusy,
  hasResult,
  error,
  elapsedMs,
  verifiedScore,
  onPlayAgain,
  claimStatus = "idle",
  claimTxHash,
  claimError,
  className,
}: ProofProgressProps) {
  const isSucceeded = status === "succeeded";
  const isFailed = status === "failed";
  const displayStatus = friendlyStatus || status;

  return (
    <Card
      data-slot="proof-progress"
      className={cn(
        "gap-4",
        isSucceeded && hasResult && "border-secondary/35",
        isFailed && "border-destructive/35",
        className,
      )}
      aria-live="polite"
      aria-label="Proof progress"
    >
      {/* Status header */}
      <div className="flex items-center gap-3">
        {/* Animated indicator */}
        <div
          className={cn(
            "flex size-10 shrink-0 items-center justify-center rounded-full",
            isBusy && "animate-pulse bg-primary/15 text-primary",
            isSucceeded && hasResult && "bg-secondary/15 text-secondary",
            isFailed && "bg-destructive/15 text-destructive",
            !isBusy && !isSucceeded && !isFailed && "bg-muted text-muted-foreground",
          )}
        >
          {isBusy ? (
            <Loader2 className="size-5 animate-spin" aria-hidden="true" />
          ) : isSucceeded && hasResult ? (
            <PartyPopper className="size-5" aria-hidden="true" />
          ) : isFailed ? (
            <XCircle className="size-5" aria-hidden="true" />
          ) : (
            <Shield className="size-5" aria-hidden="true" />
          )}
        </div>

        <div className="min-w-0 flex-1">
          <p
            className={cn(
              "m-0 font-display text-sm font-semibold uppercase tracking-[0.05em]",
              isBusy && "text-primary",
              isSucceeded && hasResult && "text-secondary",
              isFailed && "text-destructive",
              !isBusy && !isSucceeded && !isFailed && "text-card-foreground",
            )}
          >
            {displayStatus}
          </p>

          {/* Proof time + verified score after completion */}
          {isSucceeded && hasResult && (
            <p className="m-0 mt-0.5 text-xs text-muted-foreground">
              {elapsedMs !== undefined && <span>Proved in {formatDuration(elapsedMs)}</span>}
              {elapsedMs !== undefined && verifiedScore !== undefined && (
                <span className="mx-1.5 text-border" aria-hidden="true">
                  |
                </span>
              )}
              {verifiedScore !== undefined && (
                <span>
                  Verified score:{" "}
                  <strong className="text-secondary">{verifiedScore.toLocaleString()}</strong>
                </span>
              )}
            </p>
          )}
        </div>
      </div>

      {/* Indeterminate pulse bar during proving */}
      {isBusy && (
        <div
          className="h-1 w-full overflow-hidden rounded-full bg-primary/10"
          role="progressbar"
          aria-label="Proof in progress"
        >
          <div className="h-full w-1/3 animate-pulse rounded-full bg-primary/50" />
        </div>
      )}

      {/* Claim success with tx hash */}
      {claimStatus === "succeeded" && claimTxHash && (
        <p className="m-0 text-xs text-muted-foreground">
          Score submitted on-chain.{" "}
          <code className="break-all text-secondary/80">{claimTxHash}</code>
        </p>
      )}
      {claimStatus === "succeeded" && !claimTxHash && (
        <p className="m-0 text-xs text-secondary">Score successfully submitted on-chain!</p>
      )}
      {claimStatus === "submitting" && (
        <p className="m-0 text-xs text-muted-foreground">Submitting score on-chain...</p>
      )}

      {/* Error display */}
      <ErrorMessage message={error} />
      <ErrorMessage message={claimError} />

      {/* Hint + navigation during active proof */}
      {isBusy && (
        <>
          <p className="m-0 text-xs text-muted-foreground">
            This can take a while. Feel free to play again or check your pending proofs.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {onPlayAgain && (
              <Button variant="ghost" size="sm" onClick={onPlayAgain}>
                <Gamepad2 className="size-3.5" aria-hidden="true" />
                Play Again
              </Button>
            )}
            <Button variant="ghost" size="sm" asChild>
              <Link href="/proofs" className="no-underline">
                <ExternalLink className="size-3.5" aria-hidden="true" />
                View Proofs
              </Link>
            </Button>
          </div>
        </>
      )}

      {/* On-chain claim is automatic via backend queue when proof succeeds. */}
    </Card>
  );
}
