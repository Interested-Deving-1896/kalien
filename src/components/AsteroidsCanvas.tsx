import { useEffect, useRef } from "react";
import { AsteroidsGame } from "../game/AsteroidsGame";
import type { CompletedGameRun } from "../game/types";

interface AsteroidsCanvasProps {
  onGameOver?: (run: CompletedGameRun) => void;
  onGameReady?: (game: AsteroidsGame) => void;
}

export function AsteroidsCanvas({ onGameOver, onGameReady }: AsteroidsCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const onGameOverRef = useRef(onGameOver);
  const onGameReadyRef = useRef(onGameReady);

  useEffect(() => {
    onGameOverRef.current = onGameOver;
  }, [onGameOver]);

  useEffect(() => {
    onGameReadyRef.current = onGameReady;
  }, [onGameReady]);

  useEffect(() => {
    const canvas = canvasRef.current;

    if (!canvas) {
      return;
    }

    const game = new AsteroidsGame({ canvas });
    onGameReadyRef.current?.(game);

    let modeBefore = game.getMode();
    let watcherFrame: number | null = null;
    let gameOverDelayTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const GAME_OVER_DELAY_MS = 1250;

    const watchModeTransitions = () => {
      if (disposed) {
        return;
      }

      const modeNow = game.getMode();
      if (modeNow === "game-over" && modeBefore !== "game-over") {
        if (gameOverDelayTimer !== null) {
          clearTimeout(gameOverDelayTimer);
          gameOverDelayTimer = null;
        }
        const record = game.getRunRecord();
        const wasReplay = modeBefore === "replay";
        if (record) {
          gameOverDelayTimer = setTimeout(() => {
            if (!disposed) {
              onGameOverRef.current?.({
                record,
                frameCount: record.inputs.length,
                endedAtMs: Date.now(),
                isReplay: wasReplay,
              });
            }
          }, GAME_OVER_DELAY_MS);
        }
      } else if (
        modeBefore === "game-over" &&
        modeNow !== "game-over" &&
        gameOverDelayTimer !== null
      ) {
        clearTimeout(gameOverDelayTimer);
        gameOverDelayTimer = null;
      }

      modeBefore = modeNow;
      watcherFrame = window.requestAnimationFrame(watchModeTransitions);
    };

    watcherFrame = window.requestAnimationFrame(watchModeTransitions);

    return () => {
      disposed = true;
      if (watcherFrame !== null) {
        window.cancelAnimationFrame(watcherFrame);
      }
      if (gameOverDelayTimer !== null) {
        clearTimeout(gameOverDelayTimer);
      }
      game.dispose();
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="block w-full aspect-[4/3] rounded-md outline-none touch-manipulation bg-[#05080d]"
    />
  );
}
