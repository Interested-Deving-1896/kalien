import { Coins, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ErrorMessage } from "@/components/shared/ErrorMessage";
import { cn } from "@/lib/utils";

export interface TokenBalanceProps {
  formattedBalance: string;
  isRefreshing: boolean;
  error: string | null;
  isConnected: boolean;
  onRefresh: () => void;
  className?: string;
}

export function TokenBalance({
  formattedBalance,
  isRefreshing,
  error,
  isConnected,
  onRefresh,
  className,
}: TokenBalanceProps) {
  if (!isConnected) {
    return null;
  }

  return (
    <div
      data-slot="token-balance"
      className={cn(
        "flex items-center gap-2 rounded-lg border border-border/30 bg-[rgba(8,16,29,0.5)] px-3 py-2",
        className,
      )}
      aria-label="Token balance"
    >
      <Coins className="size-4 shrink-0 text-secondary" aria-hidden="true" />

      <span className="min-w-0 flex-1 font-display text-sm tracking-wide text-card-foreground">
        {formattedBalance}
      </span>

      <Button
        variant="ghost"
        size="icon"
        className="size-7"
        onClick={onRefresh}
        disabled={isRefreshing}
        aria-label="Refresh balance"
      >
        <RefreshCw
          className={cn("size-3.5 text-muted-foreground", isRefreshing && "animate-spin")}
          aria-hidden="true"
        />
      </Button>

      {error && <ErrorMessage message={error} severity="warning" className="text-xs" />}
    </div>
  );
}
