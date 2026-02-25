import { Search, X } from "lucide-react";
import type { LeaderboardWindow } from "./api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export interface LeaderboardFiltersProps {
  windowKey: LeaderboardWindow;
  onWindowChange: (w: LeaderboardWindow) => void;
  searchInput: string;
  onSearchChange: (v: string) => void;
  onFind: () => void;
  onClear: () => void;
  findActive: boolean;
}

const WINDOWS: { key: LeaderboardWindow; label: string }[] = [
  { key: "10m", label: "10 min" },
  { key: "day", label: "24h" },
  { key: "all", label: "All Time" },
];

export function LeaderboardFilters({
  windowKey,
  onWindowChange,
  searchInput,
  onSearchChange,
  onFind,
  onClear,
  findActive,
}: LeaderboardFiltersProps) {
  return (
    <div className="animate-rise grid gap-4">
      {/* Time Period */}
      <div className="grid gap-1.5">
        <span className="font-display text-xs tracking-[0.08em] uppercase text-[rgba(176,202,237,0.92)]">
          Time Period
        </span>
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
      </div>

      {/* Search Players */}
      <div className="grid gap-1.5">
        <span className="font-display text-xs tracking-[0.08em] uppercase text-[rgba(176,202,237,0.92)]">
          Search Players
        </span>
        <form
          className="flex flex-col gap-2 sm:flex-row"
          onSubmit={(event) => {
            event.preventDefault();
            onFind();
          }}
        >
          <div className="relative flex-1 sm:min-w-[260px]">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="text"
              value={searchInput}
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder="Address (G... or C...)"
              aria-label="Search for a player address"
              className="pl-8"
            />
          </div>
          <Button type="submit" size="sm">
            <Search className="size-3.5" />
            Find
          </Button>
          {findActive ? (
            <Button size="sm" onClick={onClear}>
              <X className="size-3.5" />
              Clear
            </Button>
          ) : null}
        </form>
      </div>
    </div>
  );
}
