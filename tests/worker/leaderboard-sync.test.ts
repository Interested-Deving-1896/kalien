import { beforeEach, describe, expect, it } from "bun:test";
import type { WorkerEnv } from "../../worker/env";
import type { GalexieFetchResult } from "../../worker/leaderboard-ingestion";
import {
  backfillProofTapeMappings,
  recordLeaderboardSyncFailure,
  runLeaderboardSync,
  runScheduledLeaderboardSync,
  type LeaderboardSyncDeps,
} from "../../worker/leaderboard-sync";
import type {
  LeaderboardEventRecord,
  LeaderboardIngestionState,
  ProofJobRecord,
} from "../../worker/types";

let ingestionState: LeaderboardIngestionState;
let fetchQueue: Array<GalexieFetchResult | Error>;
let fetchCalls: Array<Record<string, unknown>>;
let upsertCalls: LeaderboardEventRecord[][];
let setStateCalls: LeaderboardIngestionState[];
let countCalls = 0;
let purgeCalls = 0;
let backfillCalls = 0;
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

function makeEvent(index: number): LeaderboardEventRecord {
  return {
    eventId: `evt-${index}`,
    claimantAddress: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAITA4",
    seed: index,
    frameCount: 120,
    finalScore: 1_000 + index,
    previousBest: 900 + index,
    newBest: 1_000 + index,
    mintedDelta: 100,
    txHash: null,
    eventIndex: index,
    ledger: 10_000 + index,
    closedAt: "2026-03-02T00:00:00.000Z",
    source: "rpc",
    ingestedAt: "2026-03-02T00:00:00.000Z",
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

function makeProofJob(args: {
  jobId: string;
  claimantAddress: string;
  seed: number;
  finalScore: number;
  claimStatus: ProofJobRecord["claim"]["status"];
  claimTxHash?: string | null;
  createdAt?: string;
  submittedAt?: string | null;
}): ProofJobRecord {
  const createdAt = args.createdAt ?? "2026-03-02T00:00:00.000Z";
  return {
    jobId: args.jobId,
    status: args.claimStatus === "succeeded" ? "succeeded" : "failed",
    createdAt,
    updatedAt: createdAt,
    completedAt: createdAt,
    tape: {
      sizeBytes: 1,
      key: `proofs/${args.jobId}.json`,
      metadata: {
        seed: args.seed,
        seedId: 1,
        frameCount: 100,
        finalScore: args.finalScore,
        checksum: 1,
      },
    },
    queue: {
      attempts: 1,
      lastAttemptAt: createdAt,
      lastError: null,
      nextRetryAt: null,
    },
    prover: {
      jobId: "prover-1",
      status: "succeeded",
      statusUrl: null,
      segmentLimitPo2: null,
      lastPolledAt: createdAt,
      pollingErrors: 0,
    },
    proverAttempts: [],
    claimAttempts: [],
    result: null,
    claim: {
      claimantAddress: args.claimantAddress,
      status: args.claimStatus,
      attempts: 1,
      lastAttemptAt: createdAt,
      lastError: null,
      nextRetryAt: null,
      submittedAt: args.submittedAt ?? createdAt,
      txHash: args.claimTxHash ?? null,
    },
    error: null,
    errorCode: null,
    timeoutPhase: null,
  };
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
    backfillCalls = 0;

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
      countUnmappedLeaderboardTxHashes: async () => 0,
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
      backfillProofTapeMappings: async () => {
        backfillCalls += 1;
        return { unmapped: 0, matched: 0, written: 0, errors: 0 };
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

  it("chunks sync upserts to avoid oversized D1 variable batches", async () => {
    const events = Array.from({ length: 130 }, (_, index) => makeEvent(index + 1));
    fetchQueue.push(
      makeFetchResult({
        events,
        fetchedCount: events.length,
      }),
    );

    const result = await runLeaderboardSync(makeEnv(), { mode: "forward", limit: 500 }, deps);

    expect(upsertCalls.map((batch) => batch.length)).toEqual([64, 64, 2]);
    expect(result.inserted_count).toBe(130);
  });

  it("falls back to smaller write batches when a larger upsert batch fails", async () => {
    const events = [makeEvent(1), makeEvent(2), makeEvent(3), makeEvent(4)];
    fetchQueue.push(
      makeFetchResult({
        events,
        fetchedCount: events.length,
      }),
    );

    deps.upsertLeaderboardEvents = async (_env: WorkerEnv, batch: LeaderboardEventRecord[]) => {
      upsertCalls.push(batch);
      if (batch.length > 2) {
        throw new Error("D1_ERROR: internal error");
      }
      return { inserted: batch.length, updated: 0 };
    };

    const result = await runLeaderboardSync(makeEnv(), { mode: "forward", limit: 50 }, deps);

    expect(upsertCalls.map((batch) => batch.length)).toEqual([4, 2, 2]);
    expect(result.inserted_count).toBe(4);
  });

  it("keeps sync progress from earlier pages when a follow-up page fetch fails", async () => {
    const events = [makeEvent(1), makeEvent(2)];
    fetchQueue.push(
      makeFetchResult({
        events,
        fetchedCount: events.length,
        nextCursor: "ledger:5000",
      }),
      new Error("rpc getEvents failed across candidates"),
    );

    const result = await runLeaderboardSync(
      makeEnv({ LEADERBOARD_SYNC_MAX_PAGES: "5" }),
      { mode: "forward", limit: 2 },
      deps,
    );

    expect(fetchCalls).toHaveLength(2);
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0]).toEqual(events);
    expect(result.fetched_count).toBe(2);
    expect(result.inserted_count).toBe(2);
    expect(result.next_cursor).toBe("ledger:5000");
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
    expect(backfillCalls).toBe(1);
    expect(result.backfill_tape_mappings).toEqual({
      unmapped: 0,
      matched: 0,
      written: 0,
      errors: 0,
    });
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
    expect(backfillCalls).toBe(1);
  });
});

describe("proof tape backfill behavior", () => {
  it("prefers exact tx hash matches over non-exact candidates", async () => {
    const claimantAddress =
      "CCZV7OHNSIMTVJH2HSD62XENQJAUBNOLPO5ZMQE7MJ3TQP4XUYOKVUA3";
    const txHash = "A".repeat(64);
    const writes: Array<{ txHash: string; proofJobId: string }> = [];

    const result = await backfillProofTapeMappings(makeEnv(), {
      getUnmappedLeaderboardTxHashes: async (_env, options) =>
        options?.offset === 0
          ? [{ txHash, claimantAddress, seed: 42, finalScore: 12_345 }]
          : [],
      writeProofTapeMapping: async (_env, mappedTxHash, proofJobId) => {
        writes.push({ txHash: mappedTxHash, proofJobId });
      },
      listJobsForClaimant: async () => ({
        jobs: [
          makeProofJob({
            jobId: "job-succeeded-wrong-tx",
            claimantAddress,
            seed: 42,
            finalScore: 12_345,
            claimStatus: "succeeded",
            claimTxHash: "b".repeat(64),
          }),
          makeProofJob({
            jobId: "job-exact-tx",
            claimantAddress,
            seed: 42,
            finalScore: 12_345,
            claimStatus: "failed",
            claimTxHash: txHash.toLowerCase(),
          }),
        ],
        total: 2,
      }),
    });

    expect(result.written).toBe(1);
    expect(writes).toEqual([{ txHash, proofJobId: "job-exact-tx" }]);
  });

  it("paginates claimant jobs and can resolve matches beyond the first page", async () => {
    const claimantAddress =
      "CCZTYPWXMRFS2BB23L4CT73VZRVGE7S5B474VISMYBUU3K2TLNAN33TU";
    const txHash = "c".repeat(64);
    const writes: Array<{ txHash: string; proofJobId: string }> = [];
    const listOffsets: number[] = [];

    const firstPage = Array.from({ length: 200 }, (_, index) =>
      makeProofJob({
        jobId: `job-${index}`,
        claimantAddress,
        seed: 1_000 + index,
        finalScore: 9_000 + index,
        claimStatus: "succeeded",
        claimTxHash: null,
      }),
    );
    const secondPage = [
      makeProofJob({
        jobId: "job-page-2-match",
        claimantAddress,
        seed: 777,
        finalScore: 55_555,
        claimStatus: "failed",
        claimTxHash: null,
      }),
    ];

    const result = await backfillProofTapeMappings(makeEnv(), {
      getUnmappedLeaderboardTxHashes: async (_env, options) =>
        options?.offset === 0
          ? [{ txHash, claimantAddress, seed: 777, finalScore: 55_555 }]
          : [],
      writeProofTapeMapping: async (_env, mappedTxHash, proofJobId) => {
        writes.push({ txHash: mappedTxHash, proofJobId });
      },
      listJobsForClaimant: async (_env, _claimant, _limit, offset) => {
        listOffsets.push(offset);
        if (offset === 0) {
          return { jobs: firstPage, total: 201 };
        }
        if (offset === 200) {
          return { jobs: secondPage, total: 201 };
        }
        return { jobs: [], total: 201 };
      },
    });

    expect(listOffsets).toEqual([0, 200]);
    expect(result.written).toBe(1);
    expect(writes).toEqual([{ txHash, proofJobId: "job-page-2-match" }]);
  });

  it("does not map ambiguous non-succeeded matches", async () => {
    const claimantAddress =
      "CCBXQCM5NQ7XFZL6KQ6PFFWE2PTEK4ETIYRB6MUQ4PG6JXMRKXW4YF4O";
    const txHash = "d".repeat(64);
    const writes: Array<{ txHash: string; proofJobId: string }> = [];

    const result = await backfillProofTapeMappings(makeEnv(), {
      getUnmappedLeaderboardTxHashes: async (_env, options) =>
        options?.offset === 0
          ? [{ txHash, claimantAddress, seed: 99, finalScore: 40_000 }]
          : [],
      writeProofTapeMapping: async (_env, mappedTxHash, proofJobId) => {
        writes.push({ txHash: mappedTxHash, proofJobId });
      },
      listJobsForClaimant: async () => ({
        jobs: [
          makeProofJob({
            jobId: "job-a",
            claimantAddress,
            seed: 99,
            finalScore: 40_000,
            claimStatus: "failed",
          }),
          makeProofJob({
            jobId: "job-b",
            claimantAddress,
            seed: 99,
            finalScore: 40_000,
            claimStatus: "retrying",
          }),
        ],
        total: 2,
      }),
    });

    expect(result.written).toBe(0);
    expect(result.matched).toBe(0);
    expect(writes).toHaveLength(0);
  });

  it("passes claimant and paging options into unmapped lookup", async () => {
    const claimantAddress =
      "CBXFWZJ34RA2XJ2E5AQM5A6N7BRF7R2GVJGYFS64GR2R4K2PEMYRXXVY";
    const calls: Array<{
      limit?: number;
      offset?: number;
      claimantAddress?: string | null;
      oldestFirst?: boolean;
    }> = [];

    const result = await backfillProofTapeMappings(
      makeEnv(),
      {
        getUnmappedLeaderboardTxHashes: async (_env, options) => {
          calls.push(options ?? {});
          return [];
        },
        writeProofTapeMapping: async () => undefined,
        listJobsForClaimant: async () => ({ jobs: [], total: 0 }),
      },
      {
        claimantAddress,
        unmappedBatchSize: 1,
        maxUnmappedBatches: 2,
        oldestFirst: true,
      },
    );

    expect(result.unmapped).toBe(0);
    expect(calls).toEqual([
      { limit: 1, offset: 0, claimantAddress, oldestFirst: true },
    ]);
  });
});
