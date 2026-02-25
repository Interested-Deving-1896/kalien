import type * as React from "react";
import { cn } from "@/lib/utils";

export interface StatCardProps {
  label: string;
  value: React.ReactNode;
  className?: string;
}

export function StatCard({ label, value, className }: StatCardProps) {
  return (
    <div
      className={cn(
        "rounded-lg border border-[rgba(108,159,230,0.24)] bg-[rgba(13,22,40,0.5)] px-3 py-2",
        className,
      )}
    >
      <dt className="m-0 text-xs uppercase tracking-[0.06em] text-[rgba(146,182,233,0.9)]">
        {label}
      </dt>
      <dd className="m-0 mt-0.5 font-display text-sm text-card-foreground">{value}</dd>
    </div>
  );
}

export interface StatGridProps {
  children: React.ReactNode;
  columns?: 2 | 3 | 4 | 6;
  className?: string;
}

const columnClasses = {
  2: "grid-cols-1 sm:grid-cols-2",
  3: "grid-cols-1 sm:grid-cols-3",
  4: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-4",
  6: "grid-cols-2 sm:grid-cols-3 lg:grid-cols-6",
} as const;

export function StatGrid({ children, columns = 3, className }: StatGridProps) {
  return (
    <dl className={cn("m-0 grid gap-2 p-0", columnClasses[columns], className)}>{children}</dl>
  );
}
