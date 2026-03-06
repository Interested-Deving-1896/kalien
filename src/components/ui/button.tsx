import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import * as Slot from "@radix-ui/react-slot";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-display text-sm tracking-[0.045em] uppercase transition-all cursor-pointer disabled:pointer-events-none disabled:opacity-50 disabled:cursor-not-allowed [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:ring-ring/50 focus-visible:ring-[3px]",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        space:
          "border border-primary/60 bg-gradient-to-b from-[rgba(23,72,105,0.8)] to-[rgba(13,45,73,0.92)] text-accent-foreground hover:enabled:-translate-y-px hover:enabled:shadow-[0_8px_18px_rgba(18,71,112,0.35)]",
        active:
          "border border-secondary/75 bg-gradient-to-b from-[rgba(28,94,72,0.85)] to-[rgba(20,70,54,0.95)] text-accent-foreground shadow-[0_10px_24px_rgba(16,82,61,0.32)]",
        "destructive-outline":
          "border border-destructive/50 bg-[rgba(125,32,32,0.35)] text-destructive hover:bg-[rgba(160,40,40,0.5)]",
        destructive: "bg-destructive text-white hover:bg-destructive/90",
        outline: "border border-border bg-transparent hover:bg-accent hover:text-accent-foreground",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-10 px-4 py-2 sm:h-9",
        xs: "h-9 gap-1.5 px-2.5 text-[0.72rem] sm:h-6 sm:gap-1 sm:px-2 sm:text-xs",
        sm: "h-10 gap-1.5 px-4 text-xs sm:h-8 sm:px-3",
        lg: "h-11 px-6 sm:h-10",
        icon: "size-10 sm:size-9",
      },
    },
    defaultVariants: {
      variant: "space",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "space",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : "button";

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
