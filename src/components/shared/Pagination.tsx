import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";

interface PaginationProps {
  offset: number;
  limit: number;
  total: number;
  nextOffset: number | null;
  onOffsetChange: (offset: number) => void;
  disabled?: boolean;
}

export function Pagination({ offset, limit, total, nextOffset, onOffsetChange, disabled }: PaginationProps) {
  const start = total === 0 ? 0 : offset + 1;
  const end = Math.min(offset + limit, total);
  const hasPrev = offset > 0;
  const hasNext = nextOffset !== null;

  return (
    <div className="flex items-center justify-between border-t border-border/40 px-4 py-3 text-xs text-muted-foreground">
      <span>
        {start}&ndash;{end} of {total.toLocaleString()}
      </span>
      <div className="flex gap-1">
        <Button
          variant="ghost"
          size="sm"
          disabled={!hasPrev || disabled}
          onClick={() => onOffsetChange(Math.max(0, offset - limit))}
          aria-label="Previous page"
        >
          <ChevronLeft className="size-4" />
          Previous
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={!hasNext || disabled}
          onClick={() => hasNext && onOffsetChange(nextOffset)}
          aria-label="Next page"
        >
          Next
          <ChevronRight className="size-4" />
        </Button>
      </div>
    </div>
  );
}
