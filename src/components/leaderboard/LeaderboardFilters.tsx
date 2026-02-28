import { Search, X, User } from "lucide-react";
import type { LeaderboardWindow } from "@/leaderboard/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export interface TimeWindowPickerProps {
  windowKey: LeaderboardWindow;
  onWindowChange: (w: LeaderboardWindow) => void;
}

export interface RankingsSearchProps {
  searchInput: string;
  onSearchChange: (v: string) => void;
  onFind: () => void;
  onClear: () => void;
  onFindMe: (() => void) | null;
  findActive: boolean;
}

const WINDOWS: { key: LeaderboardWindow; label: string }[] = [
  { key: "10m", label: "10 min" },
  { key: "day", label: "24h" },
  { key: "all", label: "All Time" },
];

export function TimeWindowPicker({ windowKey, onWindowChange }: TimeWindowPickerProps) {
  return (
    <div
      className="inline-flex w-fit flex-wrap gap-0.5 rounded-full border border-[rgba(99,156,226,0.37)] bg-[rgba(11,20,34,0.7)] p-0.5"
      role="group"
      aria-label="Time window selector"
    >
      {WINDOWS.map((w) => (
        <Button
          key={w.key}
          variant={w.key === windowKey ? "active" : "ghost"}
          size="sm"
          className="rounded-full px-4"
          onClick={() => onWindowChange(w.key)}
          aria-pressed={w.key === windowKey}
        >
          {w.label}
        </Button>
      ))}
    </div>
  );
}

export function RankingsSearch({
  searchInput,
  onSearchChange,
  onFind,
  onClear,
  onFindMe,
  findActive,
}: RankingsSearchProps) {
  return (
    <form
      className="flex items-center gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        onFind();
      }}
    >
      {onFindMe && !findActive && (
        <Button type="button" size="sm" variant="ghost" className="shrink-0" onClick={onFindMe}>
          <User className="size-3.5" />
          Find Me
        </Button>
      )}
      {findActive && (
        <Button type="button" size="sm" variant="ghost" className="shrink-0" onClick={onClear}>
          <X className="size-3.5" />
          Clear
        </Button>
      )}
      <div className="relative min-w-0 flex-1">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="text"
          value={searchInput}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Search by address..."
          aria-label="Search for a player address"
          className="h-8 pl-8 text-xs"
        />
      </div>
      <Button type="submit" size="sm" className="shrink-0">
        <Search className="size-3.5" />
        Find
      </Button>
    </form>
  );
}
