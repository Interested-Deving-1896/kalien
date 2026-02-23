import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const statusBadgeVariants = cva(
  "inline-flex items-center justify-center gap-1 rounded-full border px-2.5 py-[0.2rem] font-display text-xs tracking-[0.04em] uppercase whitespace-nowrap",
  {
    variants: {
      variant: {
        idle: "text-muted-foreground border-muted-foreground/40 bg-muted",
        info: "text-primary border-primary/45 bg-[rgba(20,92,136,0.36)]",
        success: "text-secondary border-secondary/50 bg-[rgba(26,108,71,0.35)]",
        error: "text-destructive border-destructive/54 bg-[rgba(125,32,32,0.35)]",
        warning: "text-warning border-warning/50 bg-[rgba(42,22,15,0.42)]",
        muted: "text-[rgba(184,214,247,0.95)] border-[rgba(141,182,226,0.45)] bg-[rgba(35,64,92,0.35)]",
      },
    },
    defaultVariants: {
      variant: "idle",
    },
  }
)

function StatusBadge({
  className,
  variant,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof statusBadgeVariants>) {
  return (
    <span
      data-slot="status-badge"
      className={cn(statusBadgeVariants({ variant, className }))}
      {...props}
    />
  )
}

export { StatusBadge, statusBadgeVariants }
