import { cn } from "@/lib/utils";
import { HeaderWallet } from "./wallet/HeaderWallet";

const NAV_LINKS = [
  { href: "/", label: "Game" },
  { href: "/proofs", label: "Proofs" },
  { href: "/leaderboard", label: "Leaderboard" },
] as const;

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
