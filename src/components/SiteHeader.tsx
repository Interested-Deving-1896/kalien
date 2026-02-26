import { useState, useRef, useEffect, useCallback } from "react";
import { Coins, ChevronDown, LogOut, Loader2, User, Copy, Check, UserPlus } from "lucide-react";
import { cn } from "@/lib/utils";
import { useWalletContext } from "@/contexts/WalletContext";
import { abbreviateAddress } from "@/lib/format";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { ErrorMessage } from "./shared/ErrorMessage";

const NAV_LINKS = [
  { href: "/", label: "Game" },
  { href: "/proofs", label: "Proofs" },
  { href: "/leaderboard", label: "Leaderboard" },
] as const;

function HeaderWallet() {
  const { wallet, balance } = useWalletContext();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const copyAddress = useCallback(() => {
    void navigator.clipboard.writeText(wallet.address).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [wallet.address]);

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  if (wallet.action === "restoring") {
    return (
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
        <span className="hidden text-xs sm:inline">Loading...</span>
      </div>
    );
  }

  if (!wallet.isConnected) {
    return (
      <div ref={ref} className="relative">
        <button
          onClick={() => setOpen((v) => !v)}
          className={cn(
            "flex cursor-pointer items-center gap-2 rounded-lg border border-border/40 bg-[rgba(8,16,29,0.6)] px-2.5 py-1.5 text-left transition-colors hover:border-border/60 hover:bg-[rgba(8,16,29,0.8)]",
            open && "border-primary/40",
          )}
          aria-expanded={open}
          aria-haspopup="true"
        >
          <UserPlus className="size-3.5 text-primary" aria-hidden="true" />
          <span className="font-display text-xs tracking-wide text-card-foreground">Sign In</span>
          <ChevronDown
            className={cn(
              "size-3 text-muted-foreground transition-transform",
              open && "rotate-180",
            )}
            aria-hidden="true"
          />
        </button>

        {open && (
          <div className="absolute right-1/2 top-full z-50 mt-1.5 w-[260px] translate-x-1/2 overflow-hidden rounded-lg border border-border/50 bg-[rgba(8,16,29,0.95)] shadow-[0_12px_40px_rgba(0,0,0,0.5)]">
            <div className="grid gap-3 p-3">
              <Input
                type="text"
                placeholder="Choose a username"
                value={wallet.userName}
                onChange={(e) => wallet.setUserName(e.target.value)}
                disabled={wallet.isBusy}
                aria-label="Username"
              />
              <Button
                variant="active"
                size="sm"
                onClick={() => {
                  void wallet.create();
                }}
                disabled={wallet.isBusy}
                className="w-full"
              >
                {wallet.action === "creating" ? (
                  <>
                    <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                    Creating...
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
                  onClick={() => {
                    void wallet.connect();
                  }}
                  disabled={wallet.isBusy}
                  className="h-auto p-0 text-xs"
                >
                  {wallet.action === "connecting" ? "Connecting..." : "Sign In"}
                </Button>
              </div>
              <ErrorMessage message={wallet.error} />
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex cursor-pointer items-center gap-2 rounded-lg border border-border/40 bg-[rgba(8,16,29,0.6)] px-2.5 py-1.5 text-left transition-colors hover:border-border/60 hover:bg-[rgba(8,16,29,0.8)]",
          open && "border-primary/40",
        )}
        aria-expanded={open}
        aria-haspopup="true"
      >
        {/* Balance pill */}
        <span className="flex items-center gap-1.5">
          <Coins className="size-3.5 text-secondary" aria-hidden="true" />
          <span className="font-display text-xs tabular-nums tracking-wide text-card-foreground">
            {balance.formattedBalance}
          </span>
        </span>

        <span className="h-4 w-px bg-border/40" aria-hidden="true" />

        {/* Address */}
        <span className="hidden items-center gap-1 sm:flex">
          <User className="size-3 text-muted-foreground" aria-hidden="true" />
          <span className="font-display text-xs text-muted-foreground">
            {abbreviateAddress(wallet.address)}
          </span>
        </span>

        <ChevronDown
          className={cn("size-3 text-muted-foreground transition-transform", open && "rotate-180")}
          aria-hidden="true"
        />
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1.5 w-[240px] overflow-hidden rounded-lg border border-border/50 bg-[rgba(8,16,29,0.95)] shadow-[0_12px_40px_rgba(0,0,0,0.5)]">
          {/* Account info with copy */}
          <div className="border-b border-border/30 px-3 py-2.5">
            <p className="m-0 font-display text-[0.65rem] uppercase tracking-[0.06em] text-muted-foreground">
              Account
            </p>
            <button
              onClick={copyAddress}
              className="mt-0.5 flex w-full cursor-pointer items-center gap-1.5 rounded bg-transparent p-0 text-left transition-colors hover:text-primary"
              title="Copy address"
            >
              <span className="min-w-0 flex-1 text-xs text-card-foreground">
                {abbreviateAddress(wallet.address)}
              </span>
              {copied ? (
                <Check className="size-3 shrink-0 text-secondary" aria-hidden="true" />
              ) : (
                <Copy className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
              )}
            </button>
          </div>

          {/* Balance */}
          <div className="border-b border-border/30 px-3 py-2.5">
            <p className="m-0 font-display text-[0.65rem] uppercase tracking-[0.06em] text-muted-foreground">
              Balance
            </p>
            <p className="m-0 mt-0.5 flex items-center gap-1.5 text-xs text-card-foreground">
              <Coins className="size-3 text-secondary" aria-hidden="true" />
              {balance.formattedBalance}
            </p>
          </div>

          {/* Sign out */}
          <div className="px-2 py-1.5">
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start text-xs"
              onClick={() => {
                setOpen(false);
                void wallet.disconnect();
              }}
              disabled={wallet.isBusy}
            >
              {wallet.action === "disconnecting" ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <LogOut className="size-3.5" aria-hidden="true" />
              )}
              Sign Out
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function SiteHeader() {
  const pathname = typeof window !== "undefined" ? window.location.pathname : "/";

  return (
    <nav className="mx-auto grid max-w-[1240px] grid-cols-[1fr_auto_1fr] items-center gap-4 border-b border-[rgba(122,185,255,0.18)] px-[clamp(1rem,3vw,2rem)] py-2.5">
      <a
        className="font-display text-[clamp(1.1rem,2.4vw,1.35rem)] font-bold tracking-widest uppercase text-[#d6fff0] no-underline [text-shadow:0_0_14px_rgba(82,255,191,0.28),0_0_1px_rgba(214,255,240,0.9)] hover:text-[#eafff7]"
        href="/"
      >
        Kalien
      </a>

      <div className="flex justify-center">
        <HeaderWallet />
      </div>

      <div className="flex items-center justify-end gap-5">
        {NAV_LINKS.map((link) => {
          const active = link.href === "/" ? pathname === "/" : pathname.startsWith(link.href);
          return (
            <a
              key={link.href}
              href={link.href}
              className={cn(
                "border-b-2 border-transparent pb-px font-display text-[0.8rem] tracking-wider uppercase text-[rgba(157,224,255,0.65)] no-underline transition-[color,border-color] duration-150 hover:text-[#9de0ff]",
                active &&
                  "border-[rgba(157,224,255,0.55)] text-[#9de0ff] [text-shadow:0_0_8px_rgba(157,224,255,0.3)]",
              )}
            >
              {link.label}
            </a>
          );
        })}
      </div>
    </nav>
  );
}
