import { type MouseEvent, type AnchorHTMLAttributes } from "react";
import { navigate } from "@/hooks/useLocation";

export function Link({ href, onClick, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement>) {
  const handleClick = (e: MouseEvent<HTMLAnchorElement>) => {
    // Allow default for external links, new tabs, etc.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    if (href && (href.startsWith("http") || href.startsWith("//"))) return;

    e.preventDefault();
    onClick?.(e);
    if (href) navigate(href);
  };

  return <a href={href} onClick={handleClick} {...rest}>{children}</a>;
}
