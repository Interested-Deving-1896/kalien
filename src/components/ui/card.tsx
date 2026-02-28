import * as React from "react";

import { cn } from "@/lib/utils";

function Card({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card"
      className={cn(
        "flex flex-col gap-3 rounded-xl border border-border p-[clamp(0.8rem,2vw,1rem)]",
        "bg-[radial-gradient(circle_at_12%_8%,rgba(94,165,255,0.15),transparent_42%),linear-gradient(160deg,rgba(8,16,29,0.84),rgba(6,13,24,0.96))]",
        "shadow-[0_14px_44px_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.06)]",
        className,
      )}
      {...props}
    />
  );
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn("flex items-center justify-between gap-3", className)}
      {...props}
    />
  );
}

function CardTitle({ className, ...props }: React.ComponentProps<"h2">) {
  return (
    <h2
      data-slot="card-title"
      className={cn("m-0 font-display text-[1.05rem] tracking-[0.08em] uppercase", className)}
      {...props}
    />
  );
}

function CardDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="card-description"
      className={cn("m-0 text-muted-foreground text-sm", className)}
      {...props}
    />
  );
}

export { Card, CardHeader, CardTitle, CardDescription };
