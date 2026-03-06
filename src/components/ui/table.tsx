import * as React from "react";

import { cn } from "@/lib/utils";

function Table({ className, ...props }: React.ComponentProps<"table">) {
  return (
    <div
      data-slot="table-container"
      className="table-scroll-hint relative w-full overflow-x-auto rounded-lg border border-border-subtle"
    >
      <table
        data-slot="table"
        className={cn("w-full border-collapse text-sm", className)}
        {...props}
      />
    </div>
  );
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return <thead data-slot="table-header" className={cn("[&_tr]:border-b", className)} {...props} />;
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn(
        "[&_tr:last-child]:border-0 [&_tr:nth-child(2n)]:bg-[rgba(9,18,32,0.55)] [&_tr:hover]:bg-[rgba(18,42,68,0.42)]",
        className,
      )}
      {...props}
    />
  );
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "sticky top-0 z-[1] border-b border-[rgba(104,161,237,0.2)] bg-[rgba(6,14,24,0.94)] px-2 py-2 text-left align-top whitespace-normal break-words sm:py-2.5 sm:whitespace-nowrap",
        "font-display text-xs tracking-wider uppercase text-[rgba(161,201,255,0.95)]",
        className,
      )}
      {...props}
    />
  );
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn("border-b border-[rgba(104,161,237,0.2)] transition-colors", className)}
      {...props}
    />
  );
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        "px-2 py-2 text-left align-top whitespace-normal break-words sm:py-2.5 sm:whitespace-nowrap",
        className,
      )}
      {...props}
    />
  );
}

export { Table, TableHeader, TableBody, TableHead, TableRow, TableCell };
