export function SiteFooter() {
  return (
    <footer className="mx-auto flex max-w-[1240px] items-center justify-center border-t border-border-subtle px-[clamp(1rem,3vw,2rem)] py-3">
      <a
        href="https://github.com/kalepail/kalien"
        target="_blank"
        rel="noopener noreferrer"
        className="font-mono text-[0.7rem] text-[rgba(157,224,255,0.5)] no-underline transition-colors duration-150 hover:text-link"
      >
        github.com/kalepail/kalien
      </a>
    </footer>
  );
}
