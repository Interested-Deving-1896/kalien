import * as React from "react";

import { cn } from "@/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "min-w-0 rounded-md border border-input bg-[rgba(13,22,40,0.55)] px-2.5 py-2",
        "font-display text-card-foreground text-sm tracking-wide",
        "placeholder:text-muted-foreground",
        "focus:outline-2 focus:outline-ring focus:outline-offset-1",
        "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
