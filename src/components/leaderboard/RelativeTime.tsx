import { useEffect, useState } from "react";
import { formatUtcDateTime, timeAgo } from "@/lib/time";
import { RELATIVE_TIME_REFRESH_MS } from "@/consts";

/**
 * Displays a human-readable relative timestamp (e.g. "3 min ago") that
 * auto-refreshes every 15 seconds.  The full UTC date-time is shown as a
 * native browser tooltip via the `title` attribute.
 */
export function RelativeTime({ value }: { value: string | null | undefined }) {
  const [, forceUpdate] = useState(0);

  useEffect(() => {
    if (!value) {
      return;
    }
    const interval = setInterval(() => forceUpdate((n) => n + 1), RELATIVE_TIME_REFRESH_MS);
    return () => clearInterval(interval);
  }, [value]);

  if (!value) {
    return <span>n/a</span>;
  }

  return <span title={formatUtcDateTime(value)}>{timeAgo(value)}</span>;
}
