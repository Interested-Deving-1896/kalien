import type * as React from "react";
import { useCallback, useRef, useState } from "react";
import { AsteroidsCanvas } from "../AsteroidsCanvas";
import type { AsteroidsGame } from "@/game/AsteroidsGame";
import type { CompletedGameRun } from "@/game/types";
import { ControlsHint } from "./ControlsHint";
import { MobileAutopilotButton } from "./MobileAutopilotButton";
import { cn } from "@/lib/utils";

export interface GamePanelProps {
  onGameOver: (run: CompletedGameRun) => void;
  overlay?: React.ReactNode;
  className?: string;
}

export function GamePanel({ onGameOver, overlay, className }: GamePanelProps) {
  const gameRef = useRef<AsteroidsGame | null>(null);
  const [autopilotOn, setAutopilotOn] = useState(false);

  const handleGameReady = useCallback((game: AsteroidsGame) => {
    gameRef.current = game;
    setAutopilotOn(false);
  }, []);

  const handleToggleAutopilot = useCallback(() => {
    const game = gameRef.current;
    if (!game) return;
    game.toggleAutopilot();
    setAutopilotOn(game.isAutopilotEnabled());
  }, []);

  const handleGameOver = useCallback(
    (run: CompletedGameRun) => {
      setAutopilotOn(false);
      onGameOver(run);
    },
    [onGameOver],
  );

  return (
    <section
      data-slot="game-panel"
      className={cn("grid gap-2", className)}
      aria-label="Asteroids game"
    >
      <div
        className={cn(
          "relative grid place-items-center overflow-hidden rounded-xl border border-[rgba(166,255,228,0.25)]",
          "bg-[linear-gradient(180deg,rgba(12,22,30,0.7),rgba(5,12,18,0.9))]",
          "p-[clamp(0.5rem,1.5vw,0.8rem)]",
          "shadow-[0_24px_80px_rgba(0,0,0,0.55),inset_0_1px_0_rgba(255,255,255,0.08)]",
        )}
      >
        <AsteroidsCanvas onGameOver={handleGameOver} onGameReady={handleGameReady} />

        <MobileAutopilotButton active={autopilotOn} onToggle={handleToggleAutopilot} />

        {/* Overlay renders on top of canvas, within the rounded border */}
        {overlay}
      </div>

      <ControlsHint />
    </section>
  );
}
