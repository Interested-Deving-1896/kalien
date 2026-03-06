import type * as React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import AlertTriangle from "lucide-react/dist/esm/icons/alert-triangle";
import LoaderCircle from "lucide-react/dist/esm/icons/loader-circle";
import Pause from "lucide-react/dist/esm/icons/pause";
import Play from "lucide-react/dist/esm/icons/play";
import X from "lucide-react/dist/esm/icons/x";
import { AsteroidsCanvas } from "../AsteroidsCanvas";
import type { AsteroidsGame, ReplaySessionState } from "@/game/AsteroidsGame";
import type { CompletedGameRun } from "@/game/types";
import { getSeedSnapshot, subscribeToSeed } from "@/hooks/useSeed";
import { getTapeDownloadUrl } from "@/proof/api";
import { navigate } from "@/hooks/useLocation";
import { ControlsHint } from "./ControlsHint";
import { MobileAutopilotButton } from "./MobileAutopilotButton";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface GamePanelProps {
  onGameOver: (run: CompletedGameRun) => void;
  onGameInstance?: (game: AsteroidsGame) => void;
  overlay?: React.ReactNode;
  replayJobId?: string | null;
  className?: string;
}

const DEFAULT_REPLAY_STATE: ReplaySessionState = {
  active: false,
  paused: false,
  speed: 1,
};

function MobileReplayControls({
  paused,
  speed,
  onTogglePause,
  onSetSpeed,
  onExit,
}: {
  paused: boolean;
  speed: ReplaySessionState["speed"];
  onTogglePause: () => void;
  onSetSpeed: (speed: ReplaySessionState["speed"]) => void;
  onExit: () => void;
}) {
  return (
    <div className="absolute inset-x-3 bottom-3 z-10 sm:hidden">
      <div className="grid gap-2 rounded-2xl border border-[rgba(112,201,255,0.24)] bg-[linear-gradient(180deg,rgba(6,16,28,0.92),rgba(4,10,20,0.98))] p-2.5 shadow-[0_18px_40px_rgba(0,0,0,0.42)] backdrop-blur-md">
        <div className="flex items-center justify-between gap-3 px-1">
          <div className="min-w-0">
            <p className="m-0 font-display text-[0.62rem] uppercase tracking-[0.12em] text-primary/80">
              Replay Controls
            </p>
            <p className="m-0 text-[0.7rem] text-text-soft">
              {paused ? "Paused" : `Running at ${speed}x`}
            </p>
          </div>
          <Button type="button" variant="ghost" size="xs" onClick={onExit}>
            <X className="size-3.5" />
            Exit
          </Button>
        </div>

        <div className="grid grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] gap-2">
          <Button
            type="button"
            variant={paused ? "active" : "space"}
            size="sm"
            className="justify-center"
            onClick={onTogglePause}
          >
            {paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
            {paused ? "Resume" : "Pause"}
          </Button>

          <div className="grid grid-cols-3 gap-2">
            {[1, 2, 4].map((nextSpeed) => (
              <Button
                key={nextSpeed}
                type="button"
                variant={speed === nextSpeed ? "active" : "ghost"}
                size="sm"
                className="justify-center px-0"
                onClick={() => onSetSpeed(nextSpeed as ReplaySessionState["speed"])}
              >
                {nextSpeed}x
              </Button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function GamePanel({
  onGameOver,
  onGameInstance,
  overlay,
  replayJobId,
  className,
}: GamePanelProps) {
  const gameRef = useRef<AsteroidsGame | null>(null);
  const [gameReady, setGameReady] = useState(false);
  const [autopilotOn, setAutopilotOn] = useState(false);
  const [replayError, setReplayError] = useState<string | null>(null);
  const [isReplayLoading, setIsReplayLoading] = useState(Boolean(replayJobId));
  const [replayState, setReplayState] = useState<ReplaySessionState>(DEFAULT_REPLAY_STATE);
  const isReplayRoute = Boolean(replayJobId);

  // Keep the game's pending seed in sync without re-rendering the full panel every second.
  useEffect(() => {
    const syncSeed = () => {
      const { seed, seedId, secondsLeft } = getSeedSnapshot();
      gameRef.current?.setCurrentSeed(seed, seedId, secondsLeft);
    };

    syncSeed();
    return subscribeToSeed(syncSeed);
  }, []);

  const handleGameReady = useCallback(
    (g: AsteroidsGame) => {
      gameRef.current = g;
      setGameReady(true);
      setAutopilotOn(false);
      const { seed, seedId, secondsLeft } = getSeedSnapshot();
      g.setCurrentSeed(seed, seedId, secondsLeft);
      g.setReplayPending(Boolean(replayJobId));
      onGameInstance?.(g);
    },
    [replayJobId, onGameInstance],
  );

  // Keep onReplayStateChange in sync with the current replayJobId
  useEffect(() => {
    if (!gameRef.current) return;
    gameRef.current.onReplayStateChange = (state) => {
      setReplayState(state);
      if (!state.active && replayJobId) {
        navigate("/");
      }
    };
  }, [replayJobId, gameReady]);

  useEffect(() => {
    const game = gameRef.current;
    if (!replayJobId || !game) {
      return;
    }

    setIsReplayLoading(true);
    setReplayError(null);
    game.setReplayPending(true);

    const controller = new AbortController();
    fetch(getTapeDownloadUrl(replayJobId), { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(res.status === 404 ? "not_found" : `${res.status}`);
        return res.arrayBuffer();
      })
      .then((buf) => {
        game.loadReplay(new Uint8Array(buf));
        setIsReplayLoading(false);
        return undefined;
      })
      .catch((err) => {
        if (!controller.signal.aborted) {
          setReplayError(err.message);
          setIsReplayLoading(false);
        }
      });

    return () => controller.abort();
  }, [replayJobId, gameReady]);

  useEffect(() => {
    if (replayJobId) {
      return;
    }

    setReplayError(null);
    setIsReplayLoading(false);
    setReplayState(DEFAULT_REPLAY_STATE);
  }, [replayJobId]);

  const handleToggleAutopilot = useCallback(() => {
    const current = gameRef.current;
    if (!current) return;
    current.toggleAutopilot();
    setAutopilotOn(current.isAutopilotEnabled());
  }, []);

  const handleToggleReplayPause = useCallback(() => {
    gameRef.current?.toggleReplayPause();
  }, []);

  const handleReplaySpeedChange = useCallback((speed: ReplaySessionState["speed"]) => {
    gameRef.current?.setReplaySpeed(speed);
  }, []);

  const handleExitReplay = useCallback(() => {
    gameRef.current?.exitReplay();
  }, []);

  const handleGameOver = useCallback(
    (run: CompletedGameRun) => {
      setAutopilotOn(false);
      onGameOver(run);
    },
    [onGameOver],
  );

  const controlsHintMode = replayState.active
    ? "replay"
    : replayError
      ? "replay-error"
      : isReplayRoute
        ? "replay-loading"
        : "play";

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

        {!isReplayRoute && !replayState.active && (
          <MobileAutopilotButton active={autopilotOn} onToggle={handleToggleAutopilot} />
        )}

        {replayState.active && !overlay && !replayError && (
          <MobileReplayControls
            paused={replayState.paused}
            speed={replayState.speed}
            onTogglePause={handleToggleReplayPause}
            onSetSpeed={handleReplaySpeedChange}
            onExit={handleExitReplay}
          />
        )}

        {overlay}

        {isReplayRoute && isReplayLoading && !replayError && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-[rgba(3,7,14,0.82)] backdrop-blur-sm">
            <div className="flex max-w-xs flex-col items-center gap-3 rounded-xl border border-border-subtle bg-[linear-gradient(160deg,rgba(8,16,29,0.92),rgba(6,13,24,0.98))] p-6 text-center shadow-elevated">
              <LoaderCircle className="size-8 animate-spin text-primary" />
              <div className="grid gap-1">
                <p className="m-0 font-display text-sm uppercase tracking-[0.08em] text-card-foreground">
                  Loading Replay
                </p>
                <p className="m-0 text-xs text-text-soft">
                  Preparing the recorded run. Touch controls will appear once playback starts.
                </p>
              </div>
              <Button type="button" variant="ghost" size="sm" onClick={() => navigate("/")}>
                <X className="size-3.5" />
                Back Home
              </Button>
            </div>
          </div>
        )}

        {replayError && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-[rgba(3,7,14,0.82)] backdrop-blur-sm">
            <div className="flex max-w-xs flex-col items-center gap-3 rounded-xl border border-border-subtle bg-[linear-gradient(160deg,rgba(8,16,29,0.92),rgba(6,13,24,0.98))] p-6 text-center shadow-elevated">
              <AlertTriangle className="size-8 text-muted-foreground" />
              <div className="grid gap-1">
                <p className="m-0 font-display text-sm text-card-foreground">
                  {replayError === "not_found" ? "Replay not found" : "Failed to load replay"}
                </p>
                <p className="m-0 text-xs text-text-soft">
                  The shared run could not be opened. Return to the live game instead.
                </p>
              </div>
              <Button type="button" variant="space" size="sm" onClick={() => navigate("/")}>
                <Play className="size-3.5" />
                Play a Game
              </Button>
            </div>
          </div>
        )}
      </div>

      <ControlsHint mode={controlsHintMode} />
    </section>
  );
}
