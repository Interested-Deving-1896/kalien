import { Bot } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface MobileAutopilotButtonProps {
  active: boolean;
  onToggle: () => void;
}

export function MobileAutopilotButton({ active, onToggle }: MobileAutopilotButtonProps) {
  return (
    <Button
      variant={active ? "active" : "space"}
      size="sm"
      className={cn(
        "absolute bottom-3 right-3 z-10 sm:hidden",
        "gap-1.5 opacity-80 active:opacity-100",
      )}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      aria-label={active ? "Disable autopilot" : "Enable autopilot"}
    >
      <Bot className="size-4" />
      <span className="text-[0.65rem]">{active ? "AUTO ON" : "AUTO OFF"}</span>
    </Button>
  );
}
