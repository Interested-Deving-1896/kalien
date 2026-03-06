import type { ReactNode } from "react";

export interface PageHeroProps {
  title: string;
  subtitle: string;
  children?: ReactNode;
}

export function PageHero({ title, subtitle, children }: PageHeroProps) {
  return (
    <header className="animate-rise flex min-w-0 flex-col items-start justify-between gap-3 rounded-xl border border-border-subtle bg-[radial-gradient(circle_at_110%_0%,rgba(102,231,196,0.12),transparent_40%),linear-gradient(160deg,rgba(7,14,25,0.8),rgba(5,11,20,0.95))] p-[clamp(0.95rem,2.6vw,1.2rem)] shadow-[0_22px_70px_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.07)] sm:flex-row sm:items-center">
      <div className="min-w-0">
        <h1 className="m-0 font-display text-[clamp(1.75rem,4.2vw,2.4rem)] tracking-[0.09em] uppercase [text-shadow:0_0_16px_rgba(79,196,255,0.26)]">
          {title}
        </h1>
        <p className="m-0 mt-1 text-[rgba(205,238,226,0.92)]">{subtitle}</p>
      </div>
      {children ? <div className="w-full min-w-0 sm:w-auto">{children}</div> : null}
    </header>
  );
}
