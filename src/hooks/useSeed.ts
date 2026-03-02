import { useSyncExternalStore } from "react";

const SEED_PERIOD_MS = 600_000; // 10 minutes
const NULL_SEED_RETRY_MS = 3_000;
const MAX_NULL_SEED_RETRY_MS = 12_000;
const SERVER_REFRESH_COOLDOWN_MS = 2_500;

function currentSeedId(nowMs = Date.now()): number {
  return Math.floor(nowMs / SEED_PERIOD_MS);
}

function getSecondsUntilNext(nowMs = Date.now()): number {
  const ms = SEED_PERIOD_MS - (nowMs % SEED_PERIOD_MS);
  return Math.ceil(ms / 1000);
}

interface SeedState {
  seed: number | null;
  seedId: number | null;
  secondsLeft: number;
}

interface SeedCurrentResponse {
  success?: boolean;
  seed_id?: number;
  seconds_left?: number;
  seed?: number | null;
}

interface SeedRefreshResponse extends SeedCurrentResponse {
  error?: string;
  retry_after_seconds?: number | null;
}

// Seed-id-aligned cache so the same seed is returned within one 10-minute interval.
let seedCache: { seedId: number; seed: number } | null = null;

let state: SeedState = {
  seed: null,
  seedId: null,
  secondsLeft: getSecondsUntilNext(),
};
const listeners = new Set<() => void>();
let countdownIntervalId: ReturnType<typeof setInterval> | null = null;
let nullRetryTimerId: ReturnType<typeof setTimeout> | null = null;
let fetchPending = false;
let refreshPending = false;
let lastServerRefreshAt = 0;
let observedSeedId = currentSeedId();
let missingSeedRetryMs = NULL_SEED_RETRY_MS;

function notify(): void {
  listeners.forEach((fn) => fn());
}

function clearNullRetry(): void {
  if (nullRetryTimerId !== null) {
    clearTimeout(nullRetryTimerId);
    nullRetryTimerId = null;
  }
}

function scheduleMissingSeedRetry(): void {
  if (listeners.size === 0) return;
  clearNullRetry();
  nullRetryTimerId = setTimeout(() => {
    void refreshSeed();
  }, missingSeedRetryMs);
  missingSeedRetryMs = Math.min(MAX_NULL_SEED_RETRY_MS, missingSeedRetryMs + 1_000);
}

async function triggerSeedRefresh(seedId: number): Promise<void> {
  if (refreshPending) return;
  const now = Date.now();
  if (now - lastServerRefreshAt < SERVER_REFRESH_COOLDOWN_MS) return;

  refreshPending = true;
  lastServerRefreshAt = now;
  try {
    const response = await fetch("/api/seed/refresh", {
      method: "POST",
      cache: "no-store",
    });
    const data = (await response.json().catch(() => null)) as SeedRefreshResponse | null;
    if (!response.ok || !data) {
      if (
        typeof data?.retry_after_seconds === "number" &&
        Number.isFinite(data.retry_after_seconds)
      ) {
        missingSeedRetryMs = Math.max(
          missingSeedRetryMs,
          Math.ceil(data.retry_after_seconds * 1000),
        );
      }
      scheduleMissingSeedRetry();
      return;
    }

    const refreshedSeedId = typeof data.seed_id === "number" ? data.seed_id >>> 0 : null;

    if (data.success === true && typeof data.seed === "number" && refreshedSeedId === seedId) {
      seedCache = {
        seedId,
        seed: data.seed >>> 0,
      };
      state = {
        seed: data.seed >>> 0,
        seedId,
        secondsLeft: getSecondsUntilNext(),
      };
      missingSeedRetryMs = NULL_SEED_RETRY_MS;
      notify();
      return;
    }

    if (
      typeof data.retry_after_seconds === "number" &&
      Number.isFinite(data.retry_after_seconds)
    ) {
      missingSeedRetryMs = Math.max(
        missingSeedRetryMs,
        Math.ceil(data.retry_after_seconds * 1000),
      );
    }
    scheduleMissingSeedRetry();
  } finally {
    refreshPending = false;
  }
}

async function refreshSeed(): Promise<void> {
  if (fetchPending) return;
  const seedId = currentSeedId();

  // Cache is fresh for this seed_id — no network call needed.
  if (seedCache?.seedId === seedId) {
    if (state.seed !== seedCache.seed) {
      state = {
        seed: seedCache.seed,
        seedId,
        secondsLeft: getSecondsUntilNext(),
      };
      notify();
    }
    return;
  }

  fetchPending = true;
  clearNullRetry();
  try {
    const response = await fetch("/api/seed/current", {
      method: "GET",
      cache: "no-store",
    });

    const data = (await response.json().catch(() => null)) as SeedCurrentResponse | null;
    if (
      response.ok &&
      data?.success === true &&
      typeof data.seed_id === "number" &&
      typeof data.seed === "number"
    ) {
      const chainSeedId = data.seed_id >>> 0;
      if (chainSeedId !== seedId) {
        state = {
          seed: null,
          seedId: null,
          secondsLeft: getSecondsUntilNext(),
        };
        notify();
        void triggerSeedRefresh(seedId);
        scheduleMissingSeedRetry();
        return;
      }
      const seed = data.seed >>> 0;
      seedCache = { seedId, seed };
      const secondsLeft =
        typeof data.seconds_left === "number" && Number.isFinite(data.seconds_left)
          ? Math.max(0, Math.ceil(data.seconds_left))
          : getSecondsUntilNext();
      state = { seed, seedId, secondsLeft };
      missingSeedRetryMs = NULL_SEED_RETRY_MS;
      notify();
    } else {
      const hasCurrentEpochSeed = state.seed !== null && state.seedId === seedId;
      if (hasCurrentEpochSeed) {
        state = { ...state, secondsLeft: getSecondsUntilNext() };
      } else {
        state = { seed: null, seedId: null, secondsLeft: getSecondsUntilNext() };
        void triggerSeedRefresh(seedId);
      }
      notify();
      scheduleMissingSeedRetry();
    }
  } catch {
    // Network error — invalidate stale seed if the epoch changed
    const currentEpochSeedId = currentSeedId();
    if (state.seedId !== null && state.seedId !== currentEpochSeedId) {
      state = { seed: null, seedId: null, secondsLeft: getSecondsUntilNext() };
    } else {
      state = { ...state, secondsLeft: getSecondsUntilNext() };
    }
    notify();
    scheduleMissingSeedRetry();
  } finally {
    fetchPending = false;
  }
}

// Tick countdown and detect epoch boundaries.
function tick(): void {
  const now = Date.now();
  const seedId = currentSeedId(now);
  const seedIdChanged = seedId !== observedSeedId;
  observedSeedId = seedId;

  if (seedIdChanged) {
    // New 10-minute seed_id started — invalidate cache and immediately call
    // the backend refresh endpoint so the next game can start quickly.
    seedCache = null;
    clearNullRetry();
    missingSeedRetryMs = NULL_SEED_RETRY_MS;
    state = { seed: null, seedId: null, secondsLeft: getSecondsUntilNext(now) };
    notify();
    void refreshSeed();
  } else {
    state = { ...state, secondsLeft: getSecondsUntilNext(now) };
    notify();
  }
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  if (listeners.size === 1) {
    observedSeedId = currentSeedId();
    countdownIntervalId = setInterval(tick, 1000);
    void refreshSeed();
  }
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0) {
      if (countdownIntervalId !== null) {
        clearInterval(countdownIntervalId);
        countdownIntervalId = null;
      }
      clearNullRetry();
    }
  };
}

function getSnapshot(): SeedState {
  return state;
}

export function useSeed(): SeedState {
  return useSyncExternalStore(subscribe, getSnapshot);
}
