/**
 * In-memory sliding-window rate limiter for proof job submissions.
 *
 * Each key stores at most `limit` timestamps (~80 bytes per entry).
 * Stale entries are pruned when the map exceeds PRUNE_THRESHOLD to
 * keep memory bounded under high-traffic conditions.
 */

const PRUNE_THRESHOLD = 5_000;
const buckets = new Map<string, number[]>();

export const SUBMISSION_LIMIT = 10;
export const SUBMISSION_WINDOW_MS = 10 * 60 * 1_000; // 10 minutes

/**
 * Returns true if the key has capacity remaining in the current window.
 * Does NOT record a submission — call {@link recordSubmission} after
 * both IP and address checks pass.
 */
export function hasCapacity(key: string, limit: number, windowMs: number): boolean {
  const cutoff = Date.now() - windowMs;
  const timestamps = buckets.get(key);
  if (!timestamps) return true;

  const active = timestamps.filter((t) => t > cutoff);
  if (active.length !== timestamps.length) {
    if (active.length === 0) {
      buckets.delete(key);
    } else {
      buckets.set(key, active);
    }
  }

  return active.length < limit;
}

/**
 * Records a submission timestamp for the given key.
 * Call after both IP and address capacity checks pass.
 */
export function recordSubmission(key: string, windowMs: number): void {
  const now = Date.now();
  const cutoff = now - windowMs;
  const existing = buckets.get(key);

  if (!existing) {
    buckets.set(key, [now]);
  } else {
    const active = existing.filter((t) => t > cutoff);
    active.push(now);
    buckets.set(key, active);
  }

  if (buckets.size > PRUNE_THRESHOLD) {
    pruneStale(windowMs);
  }
}

/**
 * Returns the number of seconds until the next submission slot opens,
 * or 0 if there is already capacity.
 */
export function retryAfterSeconds(key: string, limit: number, windowMs: number): number {
  const cutoff = Date.now() - windowMs;
  const timestamps = buckets.get(key);
  if (!timestamps) return 0;

  const active = timestamps.filter((t) => t > cutoff);
  if (active.length < limit) return 0;

  const oldest = Math.min(...active);
  const opensAt = oldest + windowMs;
  return Math.max(1, Math.ceil((opensAt - Date.now()) / 1000));
}

function pruneStale(windowMs: number): void {
  const cutoff = Date.now() - windowMs;
  for (const [key, timestamps] of buckets) {
    const active = timestamps.filter((t) => t > cutoff);
    if (active.length === 0) {
      buckets.delete(key);
    } else {
      buckets.set(key, active);
    }
  }
}
