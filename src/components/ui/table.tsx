import * as React from "react";

import { cn } from "@/lib/utils";

function Table({ className, ...props }: React.ComponentProps<"table">) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const scrollTimeoutRef = React.useRef<number | null>(null);
  const [scrollState, setScrollState] = React.useState({
    scrollable: false,
    canScrollLeft: false,
    canScrollRight: false,
    isScrolling: false,
  });

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    let frameId = 0;

    const syncScrollState = () => {
      frameId = 0;
      const maxScrollLeft = Math.max(container.scrollWidth - container.clientWidth, 0);
      const scrollable = maxScrollLeft > 2;
      const nextState = {
        scrollable,
        canScrollLeft: scrollable && container.scrollLeft > 2,
        canScrollRight: scrollable && container.scrollLeft < maxScrollLeft - 2,
        isScrolling: scrollTimeoutRef.current !== null,
      };

      setScrollState((currentState) =>
        currentState.scrollable === nextState.scrollable &&
        currentState.canScrollLeft === nextState.canScrollLeft &&
        currentState.canScrollRight === nextState.canScrollRight &&
        currentState.isScrolling === nextState.isScrolling
          ? currentState
          : nextState,
      );
    };

    const requestSync = () => {
      if (frameId !== 0) {
        return;
      }
      frameId = window.requestAnimationFrame(syncScrollState);
    };

    const handleScroll = () => {
      if (scrollTimeoutRef.current === null) {
        setScrollState((currentState) =>
          currentState.isScrolling ? currentState : { ...currentState, isScrolling: true },
        );
      } else {
        window.clearTimeout(scrollTimeoutRef.current);
      }

      scrollTimeoutRef.current = window.setTimeout(() => {
        scrollTimeoutRef.current = null;
        requestSync();
      }, 140);

      requestSync();
    };

    requestSync();
    container.addEventListener("scroll", handleScroll, { passive: true });

    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(() => {
        requestSync();
      });
      resizeObserver.observe(container);
      if (container.firstElementChild instanceof HTMLElement) {
        resizeObserver.observe(container.firstElementChild);
      }
    }

    window.addEventListener("resize", requestSync);

    return () => {
      container.removeEventListener("scroll", handleScroll);
      window.removeEventListener("resize", requestSync);
      resizeObserver?.disconnect();

      if (frameId !== 0) {
        window.cancelAnimationFrame(frameId);
      }
      if (scrollTimeoutRef.current !== null) {
        window.clearTimeout(scrollTimeoutRef.current);
        scrollTimeoutRef.current = null;
      }
    };
  }, []);

  return (
    <div
      data-slot="table-container"
      data-scrollable={scrollState.scrollable}
      data-scroll-left={scrollState.canScrollLeft}
      data-scroll-right={scrollState.canScrollRight}
      data-scrolling={scrollState.isScrolling}
      className="table-scroll-hint relative w-full rounded-lg border border-border-subtle"
    >
      <div
        ref={containerRef}
        data-slot="table-scroll"
        className="overflow-x-auto rounded-[inherit]"
      >
        <table
          data-slot="table"
          className={cn("min-w-full border-collapse text-sm", className)}
          {...props}
        />
      </div>
    </div>
  );
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return <thead data-slot="table-header" className={cn("[&_tr]:border-b", className)} {...props} />;
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn(
        "[&_tr:last-child]:border-0 [&_tr:nth-child(2n)]:bg-[rgba(9,18,32,0.55)] [&_tr:hover]:bg-[rgba(18,42,68,0.42)]",
        className,
      )}
      {...props}
    />
  );
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "sticky top-0 z-[1] border-b border-[rgba(104,161,237,0.2)] bg-[rgba(6,14,24,0.94)] px-2 py-2 text-left align-middle whitespace-nowrap sm:py-2.5",
        "font-display text-xs tracking-wider uppercase text-[rgba(161,201,255,0.95)]",
        className,
      )}
      {...props}
    />
  );
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn("border-b border-[rgba(104,161,237,0.2)] transition-colors", className)}
      {...props}
    />
  );
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        "px-2 py-2 text-left align-middle whitespace-nowrap sm:py-2.5",
        className,
      )}
      {...props}
    />
  );
}

export { Table, TableHeader, TableBody, TableHead, TableRow, TableCell };
