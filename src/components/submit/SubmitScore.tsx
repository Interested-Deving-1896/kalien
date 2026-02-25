import { Loader2, Shield } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface SubmitScoreProps {
  onSubmit: () => void;
  canSubmit: boolean;
  isSubmitting: boolean;
  isConnected: boolean;
  hasPositiveScore: boolean;
  className?: string;
}

export function SubmitScore({
  onSubmit,
  canSubmit,
  isSubmitting,
  isConnected,
  hasPositiveScore,
  className,
}: SubmitScoreProps) {
  const helperText = !isConnected
    ? "Connect your account first"
    : !hasPositiveScore
      ? "Play a game to get started"
      : null;

  return (
    <div
      data-slot="submit-score"
      className={cn("grid gap-2 text-center", className)}
    >
      <Button
        variant={canSubmit ? "active" : "space"}
        size="lg"
        onClick={onSubmit}
        disabled={!canSubmit}
        className="w-full"
        aria-label="Submit score for proof"
      >
        {isSubmitting ? (
          <>
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            Proving...
          </>
        ) : (
          <>
            <Shield className="size-4" aria-hidden="true" />
            Prove My Score
          </>
        )}
      </Button>

      {helperText && !isSubmitting && (
        <p className="m-0 text-xs text-muted-foreground">{helperText}</p>
      )}

      {isSubmitting && (
        <p className="m-0 text-xs text-primary">
          Submitting your game tape for verification...
        </p>
      )}
    </div>
  );
}
