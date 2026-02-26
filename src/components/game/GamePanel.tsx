import { AsteroidsCanvas, type CompletedGameRun } from "../AsteroidsCanvas";
import { ControlsHint } from "./ControlsHint";
import { cn } from "@/lib/utils";

export interface GamePanelProps {
  onGameOver: (run: CompletedGameRun) => void;
  className?: string;
}

export function GamePanel({ onGameOver, className }: GamePanelProps) {
  return (
    <section
      data-slot="game-panel"
      className={cn("grid gap-2", className)}
      aria-label="Asteroids game"
    >
      <div
        className={cn(
          "grid place-items-center rounded-xl border border-[rgba(166,255,228,0.25)]",
          "bg-[linear-gradient(180deg,rgba(12,22,30,0.7),rgba(5,12,18,0.9))]",
          "p-[clamp(0.5rem,1.5vw,0.8rem)]",
          "shadow-[0_24px_80px_rgba(0,0,0,0.55),inset_0_1px_0_rgba(255,255,255,0.08)]",
        )}
      >
        <AsteroidsCanvas onGameOver={onGameOver} />
      </div>

      <ControlsHint />
    </section>
  );
}
