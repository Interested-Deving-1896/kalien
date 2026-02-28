// Default for mutation / error / unknown API responses.
export const API_CACHE_CONTROL = "no-store";

// ---- Proof-pipeline dynamic routes (header-only CDN caching) ---------------

export const HEALTH_CACHE_CONTROL = "public, max-age=5, s-maxage=10";

// Polling endpoint — very short TTL while in-progress.
export const JOB_STATUS_CACHE_CONTROL = "public, max-age=2, s-maxage=3";
// Terminal jobs never change — longer TTL.
export const JOB_STATUS_TERMINAL_CACHE_CONTROL =
  "public, max-age=30, s-maxage=60, stale-while-revalidate=30";

export const JOB_LIST_CACHE_CONTROL = "public, max-age=5, s-maxage=10, stale-while-revalidate=5";

// ---- Immutable artifact routes (Hono Cache API middleware) -----------------

// Tape binary — never changes once written to R2.
export const TAPE_CACHE_CONTROL = "public, max-age=86400, s-maxage=604800, immutable";

// Proof result JSON — never changes once written.
export const RESULT_CACHE_CONTROL = "public, max-age=3600, s-maxage=86400, immutable";

// ---- Leaderboard -----------------------------------------------------------

export const LEADERBOARD_CACHE_CONTROL =
  "public, max-age=5, s-maxage=15, stale-while-revalidate=30";
export const LEADERBOARD_PRIVATE_CACHE_CONTROL = "private, max-age=5, stale-while-revalidate=15";

// ---------------------------------------------------------------------------
// Fallback: sets "no-store" on responses that did not set their own header
// (e.g. POST, error responses, unknown routes).
// ---------------------------------------------------------------------------
export function applyApiCacheControl(response: Response): void {
  if (!response.headers.has("cache-control")) {
    response.headers.set("cache-control", API_CACHE_CONTROL);
  }
}
