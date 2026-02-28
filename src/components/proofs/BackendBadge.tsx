import { cn } from "@/lib/utils";
import type { ProverBackend } from "@/proof/api";

export function BackendBadge({ backend }: { backend: ProverBackend }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 font-display text-[0.65rem] tracking-[0.04em] uppercase",
        backend === "boundless"
          ? "border-primary/45 bg-[rgba(20,92,136,0.36)] text-primary"
          : "border-secondary/50 bg-[rgba(26,108,71,0.35)] text-secondary",
      )}
    >
      {backend === "boundless" ? "Boundless" : "Vast.ai"}
    </span>
  );
}
