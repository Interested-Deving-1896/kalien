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

export function SiteHeader() {
  const pathname = useLocation();
  const { seed, secondsLeft } = useSeed();

  return (
    <nav className="mx-auto grid max-w-[1240px] grid-cols-[1fr_auto_1fr] items-center gap-4 border-b border-border-subtle px-[clamp(1rem,3vw,2rem)] py-2.5">
      <div className="flex items-center gap-2.5">
        <Link
          className="font-display text-[clamp(1.1rem,2.4vw,1.35rem)] font-bold tracking-widest uppercase text-[#d6fff0] no-underline [text-shadow:0_0_14px_rgba(82,255,191,0.28),0_0_1px_rgba(214,255,240,0.9)] hover:text-[#eafff7]"
          href="/"
        >
          Kalien
        </Link>
        <span className="flex items-center gap-1.5 rounded border border-[rgba(82,255,191,0.2)] bg-[rgba(82,255,191,0.06)] px-2 py-0.5 font-mono text-[0.65rem] text-[rgba(82,255,191,0.6)]">
          <span className="text-[rgba(82,255,191,0.4)]">seed</span>
          <span className="text-[rgba(82,255,191,0.8)]">
            {seed !== null ? formatHex32(seed) : "···"}
          </span>
          <span className="text-[rgba(82,255,191,0.25)]">·</span>
          <span title="next seed in">{formatCountdown(secondsLeft)}</span>
        </span>
      </div>

      <div className="flex justify-center">
        <HeaderWallet />
      </div>

      <div className="flex items-center justify-end gap-5">
        {NAV_LINKS.map((link) => {
          const active = link.href === "/" ? pathname === "/" : pathname.startsWith(link.href);
          return (
            <Link
              key={link.href}
              href={link.href}
              className={cn(
                "border-b-2 border-transparent pb-px font-display text-[0.8rem] tracking-wider uppercase text-[rgba(157,224,255,0.65)] no-underline transition-[color,border-color] duration-150 hover:text-link",
                active &&
                  "border-[rgba(157,224,255,0.55)] text-link [text-shadow:0_0_8px_rgba(157,224,255,0.3)]",
              )}
            >
              {link.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
