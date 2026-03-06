import Bot from "lucide-react/dist/esm/icons/bot";
import { Button } from "@/components/ui/button";

interface MobileAutopilotButtonProps {
  active: boolean;
  onToggle: () => void;
  endlessEnabled?: boolean;
  onToggleEndless?: () => void;
}

export function MobileAutopilotButton({
  active,
  onToggle,
  endlessEnabled = false,
  onToggleEndless,
}: MobileAutopilotButtonProps) {
  return (
    <div className="absolute right-3 bottom-3 z-10 flex flex-col items-end gap-2 sm:hidden">
      <Button
        variant={active ? "active" : "space"}
        size="default"
        className="gap-2 px-4 opacity-90 active:opacity-100"
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
        aria-label={active ? "Disable autopilot" : "Enable autopilot"}
      >
        <Bot className="size-4" />
        <span className="text-[0.72rem]">{active ? "AUTO ON" : "AUTO OFF"}</span>
      </Button>

      <div className="flex max-w-[calc(100vw-1.5rem)] items-center justify-end gap-2">
        <Button
          type="button"
          variant={endlessEnabled ? "active" : "space"}
          size="sm"
          className="h-8 rounded-full px-3 text-[0.62rem]"
          onClick={(e) => {
            e.stopPropagation();
            onToggleEndless?.();
          }}
          aria-label={endlessEnabled ? "Disable endless mode" : "Enable endless mode"}
        >
          <span>{endlessEnabled ? "ENDLESS ON" : "ENDLESS OFF"}</span>
        </Button>
      </div>
    </div>
  );
}
