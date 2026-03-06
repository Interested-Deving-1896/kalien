import ChevronLeft from "lucide-react/dist/esm/icons/chevron-left";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import { Button } from "@/components/ui/button";

interface PaginationProps {
  offset: number;
  limit: number;
  total: number;
  nextOffset: number | null;
  onOffsetChange: (offset: number) => void;
  disabled?: boolean;
}

export function Pagination({
  offset,
  limit,
  total,
  nextOffset,
  onOffsetChange,
  disabled,
}: PaginationProps) {
  const start = total === 0 ? 0 : offset + 1;
  const end = Math.min(offset + limit, total);
  const hasPrev = offset > 0;
  const hasNext = nextOffset !== null;

  return (
    <div className="flex flex-col gap-3 border-t border-border/40 px-4 py-3 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
      <span className="text-center sm:text-left">
        {start}&ndash;{end} of {total.toLocaleString()}
      </span>
      <div className="grid grid-cols-2 gap-2 sm:flex">
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-center sm:w-auto"
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
          className="w-full justify-center sm:w-auto"
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
