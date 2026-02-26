import { CheckCircle2, LogOut, Loader2 } from "lucide-react";
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ErrorMessage } from "@/components/shared/ErrorMessage";
import { cn } from "@/lib/utils";
import { abbreviateAddress } from "@/lib/format";

export interface WalletConnectProps {
  isConnected: boolean;
  isBusy: boolean;
  action: string;
  address: string;
  userName: string;
  error: string | null;
  onSetUserName: (name: string) => void;
  onConnect: () => void;
  onCreate: () => void;
  onDisconnect: () => void;
  className?: string;
}

export function WalletConnect({
  isConnected,
  isBusy,
  action,
  address,
  userName,
  error,
  onSetUserName,
  onConnect,
  onCreate,
  onDisconnect,
  className,
}: WalletConnectProps) {
  if (isConnected) {
    return (
      <Card
        data-slot="wallet-connect"
        className={cn("flex-row items-center gap-3 border-secondary/30 py-3", className)}
        aria-label="Account connected"
      >
        <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-secondary/15 text-secondary">
          <CheckCircle2 className="size-4" aria-hidden="true" />
        </div>

        <div className="min-w-0 flex-1">
          <p className="m-0 font-display text-xs font-semibold uppercase tracking-[0.05em] text-secondary">
            Account Connected
          </p>
          <p className="m-0 text-xs text-muted-foreground">{abbreviateAddress(address)}</p>
        </div>

        <Button
          variant="ghost"
          size="sm"
          onClick={onDisconnect}
          disabled={isBusy}
          aria-label="Sign out"
        >
          {action === "disconnecting" ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <LogOut className="size-3.5" aria-hidden="true" />
          )}
          Sign Out
        </Button>
      </Card>
    );
  }

  return (
    <Card
      data-slot="wallet-connect"
      className={cn("gap-4", className)}
      aria-label="Create your account"
    >
      <CardHeader className="flex-col items-start gap-1">
        <CardTitle className="text-base">Create Your Account</CardTitle>
        <CardDescription>Create a free account to prove scores and earn tokens</CardDescription>
      </CardHeader>

      <div className="grid gap-3">
        <Input
          type="text"
          placeholder="Choose a username"
          value={userName}
          onChange={(e) => onSetUserName(e.target.value)}
          disabled={isBusy}
          aria-label="Username"
        />

        <Button
          variant="active"
          onClick={onCreate}
          disabled={isBusy}
          className="w-full"
          aria-label="Create account"
        >
          {action === "creating" ? (
            <>
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              Creating Account...
            </>
          ) : (
            "Create Account"
          )}
        </Button>

        <div className="flex items-center justify-center gap-1">
          <span className="text-xs text-muted-foreground">Already have an account?</span>
          <Button
            variant="link"
            size="sm"
            onClick={onConnect}
            disabled={isBusy}
            className="h-auto p-0 text-xs"
            aria-label="Sign in to existing account"
          >
            {action === "connecting" || action === "restoring" ? "Connecting..." : "Sign In"}
          </Button>
        </div>
      </div>

      <ErrorMessage message={error} />
    </Card>
  );
}
