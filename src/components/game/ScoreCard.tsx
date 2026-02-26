import { Trophy, Clock } from "lucide-react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { formatFramesAsTime } from "@/lib/format";
import type { CompletedGameRun } from "../AsteroidsCanvas";

export interface ScoreCardProps {
  run: CompletedGameRun;
  className?: string;
}

export function ScoreCard({ run, className }: ScoreCardProps) {
  const score = run.record.finalScore;
  const duration = formatFramesAsTime(run.frameCount);
  const isHighScore = score >= 5000;

  return (
    <Card
      data-slot="score-card"
      className={cn(
        "items-center text-center",
        isHighScore &&
          "border-secondary/40 shadow-[0_14px_44px_rgba(0,0,0,0.35),0_0_60px_rgba(144,246,200,0.08),inset_0_1px_0_rgba(255,255,255,0.06)]",
        className,
      )}
      aria-label={`Final score: ${score.toLocaleString()}`}
    >
      {/* Trophy icon */}
      <div
        className={cn(
          "flex size-12 items-center justify-center rounded-full",
          isHighScore ? "bg-secondary/15 text-secondary" : "bg-primary/15 text-primary",
        )}
      >
        <Trophy className="size-6" aria-hidden="true" />
      </div>

      {/* Heading */}
      <p className="m-0 font-display text-xs uppercase tracking-[0.1em] text-muted-foreground">
        {isHighScore ? "Amazing Score!" : "Game Over"}
      </p>

      {/* Big score */}
      <p
        className={cn(
          "m-0 font-display text-4xl font-bold tracking-tight",
          isHighScore ? "text-secondary" : "text-card-foreground",
        )}
      >
        {score.toLocaleString()}
      </p>

      {/* Duration */}
      <div className="flex items-center justify-center gap-1.5 text-muted-foreground">
        <Clock className="size-3.5" aria-hidden="true" />
        <span className="text-sm">{duration}</span>
      </div>
    </Card>
  );
}
