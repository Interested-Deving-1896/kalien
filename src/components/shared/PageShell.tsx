import type * as React from "react";
import { cn } from "@/lib/utils";

export function PageShell({
  children,
  className,
  glow,
}: {
  children: React.ReactNode;
  className?: string;
  glow?: boolean;
}) {
  return (
    <main
      className={cn(
        "mx-auto grid w-full min-w-0 min-h-screen max-w-[1240px] gap-4 p-[clamp(1rem,3vw,2rem)]",
        glow && "leaderboard-glow",
        className,
      )}
    >
      {children}
    </main>
  );
}
