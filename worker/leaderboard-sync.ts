import type { WorkerEnv } from "./env";
import { fetchLeaderboardEventsFromGalexie, type GalexieFetchResult } from "./leaderboard-ingestion";
import {
  countLeaderboardEvents,
  getLeaderboardIngestionState,
  setLeaderboardIngestionState,
  upsertLeaderboardEvents,
} from "./leaderboard-store";
import type { LeaderboardEventRecord, LeaderboardIngestionState } from "./types";
import { parseInteger, safeErrorMessage } from "./utils";
import type { LeaderboardResolvedSourceMode } from "./leaderboard-ingestion";

export interface LeaderboardSyncRequest {
  mode: "forward" | "backfill";
  cursor?: string | null;
  fromLedger?: number | null;
  toLedger?: number | null;
  limit?: number;
  source?: LeaderboardResolvedSourceMode | "default" | null;
}

export interface LeaderboardSyncResult {
  mode: "forward" | "backfill";
  requested: {
    cursor: string | null;
    from_ledger: number | null;
    to_ledger: number | null;
    limit: number | null;
    source: LeaderboardResolvedSourceMode | "default";
  };
  fetched_count: number;
  accepted_count: number;
  inserted_count: number;
  updated_count: number;
  next_cursor: string | null;
  provider: "galexie" | "rpc";
  source_mode: LeaderboardResolvedSourceMode;
  state: LeaderboardIngestionState;
}

function parseBoolean(raw: string | undefined, defaultValue: boolean): boolean {
  if (!raw) {
    return defaultValue;
  }

  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }

  return defaultValue;
}

function shouldRunCatchup(
  state: LeaderboardIngestionState,
  nowMs: number,
  intervalMinutes: number,
): boolean {
  if (intervalMinutes <= 0) {
    return false;
  }

  if (!state.lastBackfillAt) {
    return true;
  }

  const lastBackfillMs = new Date(state.lastBackfillAt).getTime();
  if (!Number.isFinite(lastBackfillMs)) {
    return true;
  }

  return nowMs - lastBackfillMs >= intervalMinutes * 60_000;
}

function parseLedgerCursor(cursor: string | null | undefined): number | null {
  if (!cursor || cursor.trim().length === 0) {
    return null;
  }

  const trimmed = cursor.trim();
  const normalized = trimmed.startsWith("ledger:")
    ? trimmed.slice("ledger:".length).trim()
    : trimmed;
  if (!/^\d+$/.test(normalized)) {
    return null;
  }
  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return parsed;
}

function extractLedgerFromOpaqueCursor(cursor: string | null | undefined): number | null {
  if (!cursor || cursor.trim().length === 0) {
    return null;
  }
  const trimmed = cursor.trim();
  if (trimmed.startsWith("ledger:")) {
    return null;
  }
  // RPC cursors may be "toid-subIndex" (e.g., "0004537142736896001-0000000000")
  // or plain toid. Extract the first numeric part and decode the ledger.
  const toidPart = trimmed.split("-")[0];
  if (!toidPart || !/^\d+$/.test(toidPart)) {
    return null;
  }
  try {
    const ledger = Number(BigInt(toidPart) >> 32n);
    return Number.isFinite(ledger) && ledger >= 0 ? ledger : null;
  } catch {
    return null;
  }
}

function parseForwardReplayWindowLedgers(env: WorkerEnv): number {
  return parseInteger(env.LEADERBOARD_FORWARD_REPLAY_WINDOW_LEDGERS, 8_000, 1);
}

export async function runLeaderboardSync(
  env: WorkerEnv,
  request: LeaderboardSyncRequest,
): Promise<LeaderboardSyncResult> {
  const existingState = await getLeaderboardIngestionState(env);
  const maxPages = parseInteger(env.LEADERBOARD_SYNC_MAX_PAGES, 5, 1);

  const replayWindowLedgers = parseForwardReplayWindowLedgers(env);
  const persistedCursor =
    request.mode === "forward" ? (request.cursor ?? existingState.cursor) : null;
  const persistedCursorLedger = parseLedgerCursor(persistedCursor);

  let effectiveCursor = request.mode === "forward" ? persistedCursor : request.cursor;
  let effectiveFromLedger = request.fromLedger ?? null;
  let effectiveToLedger = request.toLedger ?? null;

  // Detect and discard stale opaque RPC cursors.
  // RPC cursors encode ledger via toid: BigInt(cursorPart) >> 32n.
  // If the cursor's implied ledger <= highestLedger, it's behind known territory.
  if (
    request.mode === "forward" &&
    effectiveCursor &&
    persistedCursorLedger === null &&
    existingState.highestLedger !== null
  ) {
    const cursorLedger = extractLedgerFromOpaqueCursor(effectiveCursor);
    if (cursorLedger !== null && cursorLedger <= existingState.highestLedger) {
      effectiveCursor = null;
      effectiveFromLedger = existingState.highestLedger + 1;
    }
  }

  // When no opaque cursor is active, compute startLedger from anchor
  const hasActiveOpaqueCursor = Boolean(
    effectiveCursor && parseLedgerCursor(effectiveCursor) === null,
  );
  if (request.mode === "forward" && effectiveFromLedger === null && !hasActiveOpaqueCursor) {
    const anchorLedger = existingState.highestLedger ?? persistedCursorLedger;
    if (anchorLedger !== null) {
      effectiveFromLedger = Math.max(2, anchorLedger - replayWindowLedgers + 1);
      effectiveCursor = null;
      if (effectiveToLedger !== null && effectiveToLedger < effectiveFromLedger) {
        effectiveToLedger = effectiveFromLedger;
      }
    }
  }

  // Multi-page fetch loop.
  // Continues on full pages (drain remaining events) AND on empty/partial pages
  // when the scan hasn't reached the chain tip yet (bridge ledger gaps).
  // The RPC has a hard 10K ledger scan limit per request, so bridging a large gap
  // (e.g. 100K+ ledgers) requires multiple pages.
  const effectiveLimit = Math.min(Math.max(request.limit ?? 200, 1), 1000);
  const allEvents: LeaderboardEventRecord[] = [];
  let totalFetchedCount = 0;

  // eslint-disable-next-line no-await-in-loop
  let lastFetched: GalexieFetchResult = await fetchLeaderboardEventsFromGalexie(env, {
    cursor: effectiveCursor,
    fromLedger: effectiveFromLedger,
    toLedger: effectiveToLedger,
    limit: request.limit,
    source: request.source ?? null,
  });
  allEvents.push(...lastFetched.events);
  totalFetchedCount += lastFetched.fetchedCount;
  let pageCount = 1;

  while (pageCount < maxPages && lastFetched.nextCursor) {
    const isFullPage = lastFetched.fetchedCount >= effectiveLimit;
    if (!isFullPage) {
      // Empty or partial page — only continue if we're bridging a gap to the chain tip.
      // The RPC response cursor for an empty page encodes (endLedger - 1) via toid.
      // If that's still far from latestLedger, keep scanning forward.
      if (lastFetched.latestLedger === null) break;
      const scanEndLedger = extractLedgerFromOpaqueCursor(lastFetched.nextCursor);
      if (scanEndLedger === null || scanEndLedger >= lastFetched.latestLedger) break;
    }

    // eslint-disable-next-line no-await-in-loop
    lastFetched = await fetchLeaderboardEventsFromGalexie(env, {
      cursor: lastFetched.nextCursor,
      limit: request.limit,
      source: request.source ?? null,
    });
    allEvents.push(...lastFetched.events);
    totalFetchedCount += lastFetched.fetchedCount;
    pageCount += 1;
  }

  const upsert = await upsertLeaderboardEvents(env, allEvents);
  const hasBaselineState =
    existingState.totalEvents > 0 ||
    existingState.cursor !== null ||
    existingState.lastSyncedAt !== null;
  const totalEvents = hasBaselineState
    ? Math.max(existingState.totalEvents, 0) + upsert.inserted
    : await countLeaderboardEvents(env);
  const ledgers = allEvents
    .map((event) => event.ledger)
    .filter((value): value is number => typeof value === "number");
  const highestLedgerFromBatch = ledgers.length > 0 ? Math.max(...ledgers) : null;

  // Advance highestLedger from event ledgers only — NOT from latestLedger.
  // Advancing to latestLedger would skip unscanned territory due to the RPC's
  // 10K ledger scan limit, causing the stale cursor detection to jump past
  // events that exist in the gap.
  const newHighestLedger =
    highestLedgerFromBatch !== null
      ? Math.max(existingState.highestLedger ?? 0, highestLedgerFromBatch)
      : existingState.highestLedger;

  const nowIso = new Date().toISOString();

  const nextState: LeaderboardIngestionState = {
    ...existingState,
    provider: lastFetched.provider,
    sourceMode: lastFetched.sourceMode,
    cursor:
      request.mode === "forward"
        ? (lastFetched.nextCursor ?? null)
        : existingState.cursor,
    highestLedger: newHighestLedger,
    lastSyncedAt: nowIso,
    lastBackfillAt: request.mode === "backfill" ? nowIso : existingState.lastBackfillAt,
    totalEvents,
    lastError: null,
  };

  await setLeaderboardIngestionState(env, nextState);

  return {
    mode: request.mode,
    requested: {
      cursor: effectiveCursor ?? null,
      from_ledger: effectiveFromLedger,
      to_ledger: effectiveToLedger,
      limit: request.limit ?? null,
      source: request.source ?? "default",
    },
    fetched_count: totalFetchedCount,
    accepted_count: allEvents.length,
    inserted_count: upsert.inserted,
    updated_count: upsert.updated,
    next_cursor: lastFetched.nextCursor,
    provider: lastFetched.provider,
    source_mode: lastFetched.sourceMode,
    state: nextState,
  };
}

export async function runScheduledLeaderboardSync(
  env: WorkerEnv,
  scheduledTimeMs = Date.now(),
): Promise<{
  enabled: boolean;
  forward: LeaderboardSyncResult | null;
  catchup: LeaderboardSyncResult | null;
  warning: string | null;
}> {
  const enabled = parseBoolean(env.LEADERBOARD_SYNC_CRON_ENABLED, true);
  if (!enabled) {
    return {
      enabled: false,
      forward: null,
      catchup: null,
      warning: null,
    };
  }

  const limit = parseInteger(env.LEADERBOARD_SYNC_CRON_LIMIT, 200, 1);
  const catchupIntervalMinutes = parseInteger(env.LEADERBOARD_CATCHUP_INTERVAL_MINUTES, 30, 0);
  const catchupWindowLedgers = parseInteger(env.LEADERBOARD_CATCHUP_WINDOW_LEDGERS, 0, 0);

  const forward = await runLeaderboardSync(env, {
    mode: "forward",
    limit,
  });

  let catchup: LeaderboardSyncResult | null = null;
  let warning: string | null = null;

  if (
    catchupWindowLedgers > 0 &&
    shouldRunCatchup(forward.state, scheduledTimeMs, catchupIntervalMinutes)
  ) {
    const highestLedger = forward.state.highestLedger;
    if (highestLedger === null) {
      warning = "skipped catchup backfill because highest ledger is unknown";
    } else {
      const fromLedger = Math.max(2, highestLedger - catchupWindowLedgers);
      catchup = await runLeaderboardSync(env, {
        mode: "backfill",
        fromLedger,
        toLedger: highestLedger,
        limit,
        source: "datalake",
      });
    }
  }

  return {
    enabled: true,
    forward,
    catchup,
    warning,
  };
}

export async function recordLeaderboardSyncFailure(env: WorkerEnv, error: unknown): Promise<void> {
  const existingState = await getLeaderboardIngestionState(env);
  await setLeaderboardIngestionState(env, {
    ...existingState,
    lastError: safeErrorMessage(error),
    lastSyncedAt: new Date().toISOString(),
  });
}
