import Search from "lucide-react/dist/esm/icons/search";
import User from "lucide-react/dist/esm/icons/user";
import X from "lucide-react/dist/esm/icons/x";
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
      className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:flex-nowrap sm:justify-end"
      onSubmit={(event) => {
        event.preventDefault();
        onFind();
      }}
    >
      <div className="relative min-w-0 basis-full sm:basis-auto sm:flex-1">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground sm:left-2.5 sm:size-3.5" />
        <Input
          type="text"
          value={searchInput}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Search by address…"
          aria-label="Search for a player address"
          className="h-10 pl-9 text-sm sm:h-8 sm:pl-8 sm:text-xs"
        />
      </div>
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
      <Button type="submit" size="sm" className="shrink-0">
        <Search className="size-3.5" />
        Find
      </Button>
    </form>
  );
}
