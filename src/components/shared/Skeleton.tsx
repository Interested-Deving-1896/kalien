import { cn } from "@/lib/utils";
import { TableRow, TableCell } from "@/components/ui/table";

export function Skeleton({ className, wide }: { className?: string; wide?: boolean }) {
  return (
    <span
      className={cn(
        "block h-3.5 animate-pulse rounded bg-primary/20",
        wide ? "w-28" : "w-14",
        className,
      )}
    />
  );
}

export function SkeletonRows({ count, cols }: { count: number; cols: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <TableRow key={i}>
          {Array.from({ length: cols }, (__, j) => (
            <TableCell key={j}>
              <Skeleton wide={j === 1 || j === cols - 2} />
            </TableCell>
          ))}
        </TableRow>
      ))}
    </>
  );
}
