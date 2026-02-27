import type * as React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AsteroidsCanvas } from "../AsteroidsCanvas";
import type { AsteroidsGame } from "@/game/AsteroidsGame";
import type { CompletedGameRun } from "@/game/types";
import { useSeed } from "@/hooks/useSeed";
import { getTapeDownloadUrl } from "@/proof/api";
import { ControlsHint } from "./ControlsHint";
import { MobileAutopilotButton } from "./MobileAutopilotButton";
import { cn } from "@/lib/utils";

export interface GamePanelProps {
  onGameOver: (run: CompletedGameRun) => void;
  overlay?: React.ReactNode;
  replayJobId?: string | null;
  className?: string;
}

export function GamePanel({ onGameOver, overlay, replayJobId, className }: GamePanelProps) {
  const gameRef = useRef<AsteroidsGame | null>(null);
  const [game, setGame] = useState<AsteroidsGame | null>(null);
  const [autopilotOn, setAutopilotOn] = useState(false);
  const { seed, seedId, secondsLeft } = useSeed();

  // Keep the game's pending seed in sync with the on-chain seed
  useEffect(() => {
    if (gameRef.current) {
      gameRef.current.setCurrentSeed(seed, seedId, secondsLeft);
    }
  }, [seed, seedId, secondsLeft]);

  const handleGameReady = useCallback(
    (g: AsteroidsGame) => {
      gameRef.current = g;
      setGame(g);
      setAutopilotOn(false);
      // Apply current seed state immediately (can be null while epoch seed loads).
      g.setCurrentSeed(seed, seedId, secondsLeft);
    },
    [seed, seedId, secondsLeft],
  );

  useEffect(() => {
    if (!replayJobId || !game) return;

    const controller = new AbortController();
    fetch(getTapeDownloadUrl(replayJobId), { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`tape fetch failed: ${res.status}`);
        return res.arrayBuffer();
      })
      .then((buf) => game.loadReplay(new Uint8Array(buf)))
      .catch((err) => {
        if (!controller.signal.aborted) console.error("replay load failed:", err);
      });

    return () => controller.abort();
  }, [replayJobId, game]);

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
