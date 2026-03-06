import { cn } from "@/lib/utils";
import { formatHex32 } from "@/lib/format";
import { useLocation } from "@/hooks/useLocation";
import { useSeed } from "@/hooks/useSeed";
import { Link } from "./shared/Link";
import { HeaderWallet } from "./wallet/HeaderWallet";

const NAV_LINKS = [
  { href: "/", label: "Game" },
  { href: "/proofs", label: "Proofs" },
  { href: "/leaderboard", label: "Leaderboard" },
] as const;

function formatCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function SeedStatus() {
  const { seed, secondsLeft } = useSeed();

  return (
    <span className="flex min-w-0 max-w-full items-center gap-1.5 overflow-hidden rounded border border-[rgba(82,255,191,0.2)] bg-[rgba(82,255,191,0.06)] px-2 py-1 font-mono text-[0.6rem] text-[rgba(82,255,191,0.6)] sm:text-[0.65rem]">
      <span className="shrink-0 text-[rgba(82,255,191,0.4)]">seed</span>
      <span className="truncate text-[rgba(82,255,191,0.8)]">
        {seed !== null ? formatHex32(seed) : "···"}
      </span>
      <span className="shrink-0 text-[rgba(82,255,191,0.25)]">·</span>
      <span className="shrink-0" title="next seed in">
        {formatCountdown(secondsLeft)}
      </span>
    </span>
  );
}

export function SiteHeader() {
  const pathname = useLocation();

  return (
    <nav className="mx-auto w-full max-w-[1240px] border-b border-border-subtle px-[clamp(1rem,3vw,2rem)] py-3">
      <div className="flex min-w-0 flex-col gap-3 sm:grid sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:items-center sm:gap-4">
        <div className="order-1 flex min-w-0 flex-wrap items-center gap-2.5 sm:flex-nowrap">
          <Link
            className="translate-y-px font-display text-[clamp(1.1rem,2.4vw,1.35rem)] leading-none font-bold tracking-widest uppercase text-[#d6fff0] no-underline [text-shadow:0_0_14px_rgba(82,255,191,0.28),0_0_1px_rgba(214,255,240,0.9)] hover:text-[#eafff7]"
            href="/"
          >
            Kalien
          </Link>
          <SeedStatus />
        </div>

        <div className="order-2 flex justify-start sm:justify-center">
          <HeaderWallet />
        </div>

        <div className="order-3 flex min-w-0 flex-wrap items-center gap-2 sm:justify-end sm:gap-5">
          {NAV_LINKS.map((link) => {
            const active = link.href === "/" ? pathname === "/" : pathname.startsWith(link.href);
            return (
              <Link
                key={link.href}
                href={link.href}
                className={cn(
                  "rounded-full border border-transparent px-3 py-2 font-display text-[0.75rem] tracking-wider uppercase text-[rgba(157,224,255,0.72)] no-underline transition-[color,border-color,background-color] duration-150 hover:border-[rgba(157,224,255,0.22)] hover:bg-[rgba(9,18,32,0.62)] hover:text-link",
                  "sm:rounded-none sm:border-x-0 sm:border-t-0 sm:border-b-2 sm:bg-transparent sm:px-0 sm:pt-2 sm:pb-1.5 sm:text-[0.8rem]",
                  active
                    ? "border-[rgba(157,224,255,0.38)] bg-[rgba(14,34,56,0.72)] text-link [text-shadow:0_0_8px_rgba(157,224,255,0.3)] sm:border-[rgba(157,224,255,0.55)] sm:bg-transparent"
                    : "",
                )}
              >
                {link.label}
              </Link>
            );
          })}
        </div>
      </div>
    </nav>
  );
}
