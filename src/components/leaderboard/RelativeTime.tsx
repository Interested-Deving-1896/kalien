import { useTick } from "@/hooks/useTick";
import { formatUtcDateTime, timeAgo } from "@/lib/time";

/**
 * Displays a human-readable relative timestamp (e.g. "3 min ago") that
 * auto-refreshes every 15 seconds.  The full UTC date-time is shown as a
 * native browser tooltip via the `title` attribute.
 */
export function RelativeTime({ value }: { value: string | null | undefined }) {
  useTick();

  if (!value) {
    return <span>n/a</span>;
  }

  return <span title={formatUtcDateTime(value)}>{timeAgo(value)}</span>;
}
