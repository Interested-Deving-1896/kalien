import Keyboard from "lucide-react/dist/esm/icons/keyboard";
import { cn } from "@/lib/utils";

type ControlsHintMode = "play" | "replay" | "replay-loading" | "replay-error";

export function ControlsHint({
  className,
  mode = "play",
  endlessModeEnabled = false,
}: {
  className?: string;
  mode?: ControlsHintMode;
  endlessModeEnabled?: boolean;
}) {
  const isReplay = mode === "replay";
  const isReplayLoading = mode === "replay-loading";
  const isReplayError = mode === "replay-error";

  return (
    <div
      data-slot="controls-hint"
      className={cn(
        "flex items-center justify-center gap-2 rounded-lg border border-border/40 bg-surface-dim px-4 py-2",
        className,
      )}
    >
      <Keyboard className="hidden size-4 text-muted-foreground sm:block" aria-hidden="true" />

      {/* Desktop: full key listing */}
      <p className="m-0 hidden text-xs tracking-wide text-muted-foreground sm:block">
        {isReplayError ? (
          <>Replay unavailable. Return home to play live.</>
        ) : isReplayLoading ? (
          <>Loading replay tape. Live controls stay locked until playback is ready.</>
        ) : isReplay ? (
          <>
            <Kbd>1</Kbd> <Kbd>2</Kbd> <Kbd>4</Kbd> speed
            <Sep />
            <Kbd>P</Kbd> pause
            <Sep />
            <Kbd>M</Kbd> mute
            <Sep />
            <Kbd>Esc</Kbd> exit
          </>
        ) : (
          <>
            <Kbd>Arrows</Kbd> move
            <Sep />
            <Kbd>Space</Kbd> fire
            <Sep />
            <Kbd>E</Kbd> endless {endlessModeEnabled ? "on" : "off"}
            <Sep />
            <Kbd>P</Kbd> pause
            <Sep />
            <Kbd>R</Kbd> restart
            <Sep />
            <Kbd>M</Kbd> mute
            <Sep />
            <Kbd>D</Kbd> save tape
            <Sep />
            <Kbd>Esc</Kbd> menu
          </>
        )}
      </p>

      {/* Mobile: simplified hint */}
      <p className="m-0 text-xs tracking-wide text-muted-foreground sm:hidden">
        {isReplayError
          ? "Replay unavailable. Return home to play live."
          : isReplayLoading
            ? "Loading replay. Live gameplay is locked."
            : isReplay
              ? "Use the replay controls below to pause, change speed, or exit."
              : "Tap to start. Use the Auto and Endless controls to loop runs."}
      </p>
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-border/50 bg-[rgba(20,40,65,0.5)] px-1.5 py-0.5 font-display text-[0.7rem] text-card-foreground">
      {children}
    </kbd>
  );
}

function Sep() {
  return (
    <span className="mx-1.5 inline-block text-border" aria-hidden="true">
      |
    </span>
  );
}
