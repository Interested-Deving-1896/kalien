import { cn } from "@/lib/utils";

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
