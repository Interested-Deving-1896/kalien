import Check from "lucide-react/dist/esm/icons/check";
import { cn } from "@/lib/utils";

export interface Step {
  key: string;
  label: string;
}

export interface StepIndicatorProps {
  steps: Step[];
  currentStepKey: string;
  completedStepKeys: string[];
  className?: string;
}

export function StepIndicator({
  steps,
  currentStepKey,
  completedStepKeys,
  className,
}: StepIndicatorProps) {
  const currentIndex = steps.findIndex((s) => s.key === currentStepKey);

  return (
    <div data-slot="step-indicator" className={cn("w-full", className)}>
      {/* Desktop: horizontal step row */}
      <div
        className="hidden items-center justify-center gap-0 sm:flex"
        role="list"
        aria-label="Progress steps"
      >
        {steps.map((step, i) => {
          const isCompleted = completedStepKeys.includes(step.key);
          const isCurrent = step.key === currentStepKey;

          return (
            <div key={step.key} className="flex items-center" role="listitem">
              {/* Connector line before (skip first) */}
              {i > 0 && (
                <div
                  className={cn(
                    "h-0.5 w-8 sm:w-12",
                    isCompleted || isCurrent ? "bg-secondary/50" : "bg-border/40",
                  )}
                  aria-hidden="true"
                />
              )}

              <div className="flex flex-col items-center gap-1.5">
                {/* Circle */}
                <div
                  className={cn(
                    "flex size-8 items-center justify-center rounded-full border-2 transition-all",
                    isCompleted && "border-secondary bg-secondary/20 text-secondary",
                    isCurrent &&
                      !isCompleted &&
                      "animate-pulse border-primary bg-primary/20 text-primary shadow-[0_0_12px_rgba(102,199,255,0.35)]",
                    !isCompleted &&
                      !isCurrent &&
                      "border-muted-foreground/40 text-muted-foreground",
                  )}
                  aria-current={isCurrent ? "step" : undefined}
                >
                  {isCompleted ? (
                    <Check className="size-4" aria-hidden="true" />
                  ) : (
                    <span className="font-display text-xs font-semibold">{i + 1}</span>
                  )}
                </div>

                {/* Label */}
                <span
                  className={cn(
                    "text-center font-display text-[0.65rem] uppercase tracking-[0.06em]",
                    isCompleted && "text-secondary",
                    isCurrent && !isCompleted && "text-primary",
                    !isCompleted && !isCurrent && "text-muted-foreground",
                  )}
                >
                  {step.label}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Mobile: compact text */}
      <p className="m-0 text-center font-display text-xs uppercase tracking-[0.06em] text-muted-foreground sm:hidden">
        Step {currentIndex + 1} of {steps.length}:{" "}
        <span className="text-primary">{steps[currentIndex]?.label ?? ""}</span>
      </p>
    </div>
  );
}
