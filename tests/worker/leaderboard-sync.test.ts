import { beforeEach, describe, expect, it } from "bun:test";
import type { WorkerEnv } from "../../worker/env";
import type { GalexieFetchResult } from "../../worker/leaderboard-ingestion";
import {
  recordLeaderboardSyncFailure,
  runLeaderboardSync,
  runScheduledLeaderboardSync,
  type LeaderboardSyncDeps,
} from "../../worker/leaderboard-sync";
import type {
  LeaderboardEventRecord,
  LeaderboardIngestionState,
} from "../../worker/types";

let ingestionState: LeaderboardIngestionState;
let fetchQueue: Array<GalexieFetchResult | Error>;
let fetchCalls: Array<Record<string, unknown>>;
let upsertCalls: LeaderboardEventRecord[][];
let setStateCalls: LeaderboardIngestionState[];
let countCalls = 0;
let purgeCalls = 0;
let deps: LeaderboardSyncDeps;

function makeState(
  overrides: Partial<LeaderboardIngestionState> = {},
): LeaderboardIngestionState {
  return {
    provider: "rpc",
    sourceMode: "rpc",
    cursor: null,
    highestLedger: 1_000,
    lastSyncedAt: "2026-03-02T00:00:00.000Z",
    lastBackfillAt: null,
    totalEvents: 5,
    lastError: null,
    ...overrides,
  };
}

function makeFetchResult(
  overrides: Partial<GalexieFetchResult> = {},
): GalexieFetchResult {
  return {
    events: [],
    nextCursor: null,
    fetchedCount: 0,
    provider: "rpc",
    sourceMode: "rpc",
    latestLedger: 1_000_000,
    oldestLedger: 1,
    ...overrides,
  };
}

function makeEnv(overrides: Partial<WorkerEnv> = {}): WorkerEnv {
  return {
    ASSETS: {} as Fetcher,
    PROOF_QUEUE: {} as Queue<unknown>,
    VAST_QUEUE: {} as Queue<unknown>,
    CLAIM_QUEUE: {} as Queue<unknown>,
    PROOF_COORDINATOR: {} as DurableObjectNamespace<never>,
    PROOF_ARTIFACTS: {} as R2Bucket,
    LEADERBOARD_DB: {} as D1Database,
    PROVER_BASE_URL: "http://127.0.0.1:8088",
    ...overrides,
  } as WorkerEnv;
}

describe("leaderboard sync behavior", () => {
  beforeEach(() => {
    ingestionState = makeState();
    fetchQueue = [];
    fetchCalls = [];
    upsertCalls = [];
    setStateCalls = [];
    countCalls = 0;
    purgeCalls = 0;

    deps = {
      fetchLeaderboardEventsFromGalexie: async (
        _env: WorkerEnv,
        options: Record<string, unknown>,
      ) => {
        fetchCalls.push(options);
        const next = fetchQueue.shift();
        if (!next) {
          throw new Error("missing mocked fetch response");
        }
        if (next instanceof Error) {
          throw next;
        }
        return next;
      },
      countLeaderboardEvents: async () => {
        countCalls += 1;
        return 123;
      },
      getLeaderboardIngestionState: async () => ingestionState,
      purgeExpiredLeaderboardProfileAuthChallenges: async () => {
        purgeCalls += 1;
      },
      setLeaderboardIngestionState: async (
        _env: WorkerEnv,
        next: LeaderboardIngestionState,
      ) => {
        ingestionState = { ...next };
        setStateCalls.push({ ...next });
      },
      upsertLeaderboardEvents: async (
        _env: WorkerEnv,
        events: LeaderboardEventRecord[],
      ) => {
        upsertCalls.push(events);
        return { inserted: events.length, updated: 0 };
      },
    };
  });

  it("preserves explicit toLedger across paginated backfill pages", async () => {
    fetchQueue.push(
      makeFetchResult({ fetchedCount: 2, nextCursor: "ledger:103" }),
      makeFetchResult({ fetchedCount: 1, nextCursor: null }),
    );

    await runLeaderboardSync(
      makeEnv({ LEADERBOARD_SYNC_MAX_PAGES: "5" }),
      {
        mode: "backfill",
        fromLedger: 100,
        toLedger: 110,
        limit: 2,
      },
      deps,
    );

    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[0]?.toLedger).toBe(110);
    expect(fetchCalls[1]?.cursor).toBe("ledger:103");
    expect(fetchCalls[1]?.toLedger).toBe(110);
  });

  it("discards stale opaque cursor and resumes from highestLedger + 1", async () => {
    ingestionState = makeState({
      highestLedger: 500,
      cursor: `${(500n << 32n).toString()}-0000000000`,
    });
    fetchQueue.push(makeFetchResult());

    const result = await runLeaderboardSync(
      makeEnv(),
      {
        mode: "forward",
        limit: 50,
      },
      deps,
    );

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.cursor).toBeNull();
    expect(fetchCalls[0]?.fromLedger).toBe(501);
    expect(result.requested.from_ledger).toBe(501);
  });

  it("does not mark lastSyncedAt as fresh when recording sync failure", async () => {
    ingestionState = makeState({
      lastSyncedAt: "2026-03-02T10:00:00.000Z",
      lastError: null,
    });

    await recordLeaderboardSyncFailure(
      makeEnv(),
      new Error("forced failure"),
      deps,
    );

    const saved = setStateCalls.at(-1);
    expect(saved).toBeTruthy();
    expect(saved?.lastSyncedAt).toBe("2026-03-02T10:00:00.000Z");
    expect(saved?.lastError).toContain("forced failure");
  });

  it("runs scheduled catchup via datalake window when enabled", async () => {
    ingestionState = makeState({
      highestLedger: 1000,
      lastBackfillAt: null,
    });
    fetchQueue.push(makeFetchResult(), makeFetchResult());

    const result = await runScheduledLeaderboardSync(
      makeEnv({
        LEADERBOARD_SYNC_CRON_ENABLED: "1",
        LEADERBOARD_SYNC_CRON_LIMIT: "50",
        LEADERBOARD_CATCHUP_INTERVAL_MINUTES: "30",
        LEADERBOARD_CATCHUP_WINDOW_LEDGERS: "100",
      }),
      Date.parse("2026-03-02T12:00:00.000Z"),
      deps,
    );

    expect(result.forward).toBeTruthy();
    expect(result.catchup).toBeTruthy();
    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[1]?.source).toBe("datalake");
    expect(fetchCalls[1]?.fromLedger).toBe(900);
    expect(fetchCalls[1]?.toLedger).toBe(1000);
    expect(purgeCalls).toBe(1);
  });

  it("reports warning when catchup is enabled but highest ledger is unknown", async () => {
    ingestionState = makeState({
      highestLedger: null,
      cursor: null,
      totalEvents: 0,
      lastSyncedAt: null,
    });
    fetchQueue.push(makeFetchResult({ latestLedger: null }));

    const result = await runScheduledLeaderboardSync(
      makeEnv({
        LEADERBOARD_SYNC_CRON_ENABLED: "1",
        LEADERBOARD_SYNC_CRON_LIMIT: "50",
        LEADERBOARD_CATCHUP_INTERVAL_MINUTES: "30",
        LEADERBOARD_CATCHUP_WINDOW_LEDGERS: "100",
      }),
      Date.parse("2026-03-02T12:00:00.000Z"),
      deps,
    );

    expect(result.catchup).toBeNull();
    expect(result.warning).toBe(
      "skipped catchup backfill because highest ledger is unknown",
    );
    expect(fetchCalls).toHaveLength(1);
  });
});
