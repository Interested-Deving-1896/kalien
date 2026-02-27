import { describe, expect, it, mock } from "bun:test";
import type { WorkerEnv } from "../../worker/env";

const VALID_CLAIMANT_CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAITA4";
const EXAMPLE_GENERATED_AT = "2026-02-14T00:00:00.000Z";
const EXAMPLE_INGESTION_STATE = {
  provider: "rpc" as const,
  sourceMode: "rpc" as const,
  cursor: "ledger:10",
  highestLedger: 10,
  lastSyncedAt: EXAMPLE_GENERATED_AT,
  lastBackfillAt: null,
  totalEvents: 12,
  lastError: null,
};
const EXAMPLE_ENTRY = {
  rank: 1,
  jobId: "evt-1",
  claimantAddress: VALID_CLAIMANT_CONTRACT,
  score: 1337,
  mintedDelta: 1337,
  seed: 42,
  frameCount: 1200,
  finalRngState: 99,
  tapeChecksum: 0xdead,
  rulesDigest: 0x4153_5433,
  completedAt: EXAMPLE_GENERATED_AT,
  claimStatus: "succeeded" as const,
  claimTxHash: "tx-1",
  profile: {
    claimantAddress: VALID_CLAIMANT_CONTRACT,
    username: "pilot",
    linkUrl: null,
    updatedAt: EXAMPLE_GENERATED_AT,
  },
};

mock.module("../../worker/leaderboard-store", () => ({
  countLeaderboardEvents: async () => EXAMPLE_INGESTION_STATE.totalEvents,
  createLeaderboardProfileAuthChallenge: async () => undefined,
  getLeaderboardIngestionState: async () => EXAMPLE_INGESTION_STATE,
  getLeaderboardPage: async () => ({
    window: "all",
    generatedAt: EXAMPLE_GENERATED_AT,
    windowRange: {
      startAt: null,
      endAt: EXAMPLE_GENERATED_AT,
    },
    totalPlayers: 1,
    limit: 25,
    offset: 0,
    nextOffset: null,
    entries: [EXAMPLE_ENTRY],
    me: EXAMPLE_ENTRY,
  }),
  getLeaderboardPlayer: async () => ({
    profile: EXAMPLE_ENTRY.profile,
    stats: {
      totalRuns: 1,
      bestScore: EXAMPLE_ENTRY.score,
      totalMinted: EXAMPLE_ENTRY.mintedDelta,
      lastPlayedAt: EXAMPLE_GENERATED_AT,
    },
    ranks: {
      tenMin: 1,
      day: 1,
      all: 1,
    },
    recentRuns: [
      {
        jobId: EXAMPLE_ENTRY.jobId,
        claimantAddress: EXAMPLE_ENTRY.claimantAddress,
        score: EXAMPLE_ENTRY.score,
        mintedDelta: EXAMPLE_ENTRY.mintedDelta,
        seed: EXAMPLE_ENTRY.seed,
        frameCount: EXAMPLE_ENTRY.frameCount,
        finalRngState: EXAMPLE_ENTRY.finalRngState,
        tapeChecksum: EXAMPLE_ENTRY.tapeChecksum,
        rulesDigest: EXAMPLE_ENTRY.rulesDigest,
        completedAt: EXAMPLE_ENTRY.completedAt,
        claimStatus: "succeeded" as const,
        claimTxHash: EXAMPLE_ENTRY.claimTxHash,
      },
    ],
    runsPagination: {
      limit: 25,
      offset: 0,
      total: 1,
      nextOffset: null,
    },
  }),
  getLeaderboardProfileAuthChallenge: async () => null,
  getLeaderboardProfileCredential: async () => null,
  markLeaderboardProfileAuthChallengeUsed: async () => false,
  purgeExpiredLeaderboardProfileAuthChallenges: async () => undefined,
  setLeaderboardIngestionState: async () => undefined,
  updateLeaderboardProfileCredentialCounter: async () => undefined,
  upsertLeaderboardEvents: async () => ({ inserted: 0, updated: 0 }),
  upsertLeaderboardProfile: async () => EXAMPLE_ENTRY.profile,
  upsertLeaderboardProfileCredential: async () => ({
    claimantAddress: VALID_CLAIMANT_CONTRACT,
    credentialId: "credential-1",
    publicKey: "public-key",
    counter: 0,
    transports: null,
    createdAt: EXAMPLE_GENERATED_AT,
    updatedAt: EXAMPLE_GENERATED_AT,
  }),
  upsertLeaderboardProfiles: async () => 0,
}));

mock.module("../../worker/leaderboard-sync", () => ({
  runScheduledLeaderboardSync: async () => ({
    enabled: false,
    warning: null,
  }),
  runLeaderboardSync: async () => ({
    mode: "forward",
    requested: {
      cursor: null,
      from_ledger: null,
      to_ledger: null,
      limit: null,
      source: "default",
    },
    fetched: {
      provider: "rpc",
      source_mode: "rpc",
      count: 0,
      cursor: null,
    },
    upserted: {
      inserted: 0,
      updated: 0,
      total_events: EXAMPLE_INGESTION_STATE.totalEvents,
    },
    state: EXAMPLE_INGESTION_STATE,
  }),
  recordLeaderboardSyncFailure: async () => undefined,
}));

mock.module("../../worker/durable/coordinator", () => ({
  coordinatorStub: (env: WorkerEnv) =>
    (env as WorkerEnv & { __coordinator: Record<string, unknown> }).__coordinator,
  asPublicJob: <T>(job: T): T => job,
  ProofCoordinatorDO: class ProofCoordinatorDO {},
}));

const { Hono } = await import("hono");
const { createApiRouter } = await import("../../worker/api/routes");
const { createLeaderboardRouter } = await import("../../worker/api/leaderboard-routes");

const noopExecutionContext = {
  waitUntil() {
    // no-op in tests
  },
  passThroughOnException() {
    // no-op in tests
  },
} as unknown as ExecutionContext;

function makeCoordinatorStub(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    getActiveJob: async () => null,
    getJob: async () => null,
    markFailed: async () => null,
    createJob: async () => ({ accepted: false, activeJob: null }),
    kickAlarm: async () => undefined,
    listJobsForClaimant: async () => ({ jobs: [], total: 0 }),
    ...overrides,
  };
}

function makeMockD1Database(): D1Database {
  return {
    prepare: (query: string) => ({
      bind: () => ({ run: async () => ({ success: true }), all: async () => ({ results: [] }) }),
      run: async () => ({ success: true }),
      all: async () => ({ results: [] }),
      first: async () => null,
      raw: async () => [],
    }),
    batch: async () => [],
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
  } as unknown as D1Database;
}

function makeEnv(
  overrides: (Partial<WorkerEnv> & { __coordinator?: Record<string, unknown> }) | undefined = {},
): WorkerEnv {
  const coordinator = overrides.__coordinator ?? makeCoordinatorStub();

  return {
    ASSETS: {
      fetch: async () => new Response("not found", { status: 404 }),
    } as Fetcher,
    PROOF_QUEUE: {
      send: async () => undefined,
    } as Queue<unknown>,
    CLAIM_QUEUE: {
      send: async () => undefined,
    } as Queue<unknown>,
    PROOF_COORDINATOR: {
      idFromName: () => "coordinator-id" as unknown as DurableObjectId,
      get: () => coordinator,
    } as unknown as DurableObjectNamespace,
    PROOF_ARTIFACTS: {
      get: async () => null,
      put: async () => undefined,
      delete: async () => undefined,
    } as unknown as R2Bucket,
    LEADERBOARD_DB: makeMockD1Database(),
    PROVER_BASE_URL: "",
    __coordinator: coordinator,
    ...overrides,
  } as WorkerEnv & { __coordinator: Record<string, unknown> };
}

async function requestApi(
  path: string,
  init: RequestInit | undefined,
  env: WorkerEnv,
): Promise<Response> {
  const app = new Hono<{ Bindings: WorkerEnv }>();
  app.route("/", createApiRouter());
  app.route("/leaderboard", createLeaderboardRouter());
  const request = new Request(`https://worker.test${path}`, init);
  return app.fetch(request, env, noopExecutionContext);
}

describe("API routes", () => {
  it("GET /health returns degraded prover status when health validation fails", async () => {
    const response = await requestApi("/health", undefined, makeEnv({ PROVER_BASE_URL: "" }));
    expect(response.status).toBe(200);

    const payload = (await response.json()) as {
      success: boolean;
      prover: { status: string };
    };
    expect(payload.success).toBe(true);
    expect(payload.prover.status).toBe("degraded");
  });

  it("GET /leaderboard validates window query", async () => {
    const response = await requestApi("/leaderboard?window=bad-window", undefined, makeEnv());
    expect(response.status).toBe(400);
  });

  it("GET /leaderboard returns leaderboard page for valid queries", async () => {
    const response = await requestApi("/leaderboard?window=all&limit=25&offset=0", undefined, makeEnv());
    expect(response.status).toBe(200);

    const payload = (await response.json()) as {
      success: boolean;
      entries: unknown[];
      pagination: { total: number };
    };
    expect(payload.success).toBe(true);
    expect(payload.entries.length).toBe(1);
    expect(payload.pagination.total).toBe(1);
  });

  it("GET /leaderboard/player/:claimantAddress validates claimant address", async () => {
    const response = await requestApi("/leaderboard/player/not-a-valid-claimant", undefined, makeEnv());
    expect(response.status).toBe(400);
  });

  it("GET /leaderboard/player/:claimantAddress returns player summary", async () => {
    const response = await requestApi(
      `/leaderboard/player/${VALID_CLAIMANT_CONTRACT}`,
      undefined,
      makeEnv(),
    );
    expect(response.status).toBe(200);

    const payload = (await response.json()) as {
      success: boolean;
      player: { claimant_address: string };
    };
    expect(payload.success).toBe(true);
    expect(payload.player.claimant_address).toBe(VALID_CLAIMANT_CONTRACT);
  });

  it("POST /leaderboard/player/:claimantAddress/profile/auth/options validates payload", async () => {
    const response = await requestApi(
      `/leaderboard/player/${VALID_CLAIMANT_CONTRACT}/profile/auth/options`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      },
      makeEnv(),
    );
    expect(response.status).toBe(400);
  });

  it("PUT /leaderboard/player/:claimantAddress/profile validates auth payload", async () => {
    const response = await requestApi(
      `/leaderboard/player/${VALID_CLAIMANT_CONTRACT}/profile`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ username: "player-one" }),
      },
      makeEnv(),
    );
    expect(response.status).toBe(400);
  });

  it("POST /proofs/jobs enforces MAX_TAPE_BYTES before reading body", async () => {
    const response = await requestApi(
      "/proofs/jobs",
      {
        method: "POST",
        headers: {
          "content-length": "10",
        },
        body: "0123456789",
      },
      makeEnv({ MAX_TAPE_BYTES: "5" }),
    );
    expect(response.status).toBe(413);
  });

  it("GET /proofs/jobs/:jobId returns 404 when job does not exist", async () => {
    const response = await requestApi("/proofs/jobs/job-missing", undefined, makeEnv());
    expect(response.status).toBe(404);
  });

  it("GET /proofs/jobs/:jobId returns job when present", async () => {
    const response = await requestApi(
      "/proofs/jobs/job-present",
      undefined,
      makeEnv({
        __coordinator: makeCoordinatorStub({
          getJob: async () => ({
            jobId: "job-present",
            status: "failed",
          }),
        }),
      }),
    );
    expect(response.status).toBe(200);
  });

  it("GET /proofs/jobs/:jobId/result returns 404 when result artifact is not found", async () => {
    const response = await requestApi("/proofs/jobs/job-missing/result", undefined, makeEnv());
    expect(response.status).toBe(404);
  });

  it("GET /proofs/jobs/:jobId/result returns artifact payload when present", async () => {
    const response = await requestApi(
      "/proofs/jobs/job-present/result",
      undefined,
      makeEnv({
        __coordinator: makeCoordinatorStub({
          getJob: async () => ({
            result: { artifactKey: "results/job-present.json" },
          }),
        }),
        PROOF_ARTIFACTS: {
          get: async () =>
            ({
              body: '{"success":true}',
            }) as unknown as R2ObjectBody,
          put: async () => undefined,
          delete: async () => undefined,
        } as unknown as R2Bucket,
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"success":true}');
  });

  it("DELETE /proofs/jobs/:jobId returns 404 when job does not exist", async () => {
    const response = await requestApi(
      "/proofs/jobs/job-missing",
      {
        method: "DELETE",
      },
      makeEnv(),
    );
    expect(response.status).toBe(404);
  });

  it("DELETE /proofs/jobs/:jobId marks job as failed when present", async () => {
    const response = await requestApi(
      "/proofs/jobs/job-present",
      {
        method: "DELETE",
      },
      makeEnv({
        __coordinator: makeCoordinatorStub({
          markFailed: async () => ({
            jobId: "job-present",
            status: "failed",
          }),
        }),
      }),
    );
    expect(response.status).toBe(200);
  });

  // ── Dev endpoint auth guard ────────────────────────────────────────────────

  const DEV_KEY = "test-dev-key-with-enough-entropy";
  const devAuthHeaders = { authorization: `Bearer ${DEV_KEY}` };

  it("POST /leaderboard/dev/sync returns 404 when DEV_API_KEY is not set", async () => {
    const response = await requestApi(
      "/leaderboard/dev/sync",
      { method: "POST" },
      makeEnv(),
    );
    expect(response.status).toBe(404);
  });

  it("POST /leaderboard/dev/sync returns 401 without valid auth", async () => {
    const response = await requestApi(
      "/leaderboard/dev/sync",
      { method: "POST" },
      makeEnv({ DEV_API_KEY: DEV_KEY }),
    );
    expect(response.status).toBe(401);
  });

  it("POST /leaderboard/dev/sync triggers sync and returns result", async () => {
    const response = await requestApi(
      "/leaderboard/dev/sync",
      { method: "POST", headers: devAuthHeaders },
      makeEnv({ DEV_API_KEY: DEV_KEY }),
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { success: boolean };
    expect(payload.success).toBe(true);
  });

  it("POST /leaderboard/dev/sync?from_ledger=invalid returns 400", async () => {
    const response = await requestApi(
      "/leaderboard/dev/sync?from_ledger=abc",
      { method: "POST", headers: devAuthHeaders },
      makeEnv({ DEV_API_KEY: DEV_KEY }),
    );
    expect(response.status).toBe(400);
  });

  it("POST /leaderboard/dev/reset clears data", async () => {
    const response = await requestApi(
      "/leaderboard/dev/reset",
      { method: "POST", headers: devAuthHeaders },
      makeEnv({ DEV_API_KEY: DEV_KEY }),
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { success: boolean; message: string };
    expect(payload.success).toBe(true);
    expect(payload.message).toContain("cleared");
  });

  it("POST /leaderboard/dev/seed with valid events returns insert counts", async () => {
    const response = await requestApi(
      "/leaderboard/dev/seed",
      {
        method: "POST",
        headers: { "content-type": "application/json", ...devAuthHeaders },
        body: JSON.stringify({
          events: [
            {
              claimantAddress: VALID_CLAIMANT_CONTRACT,
              seed: 42,
              finalScore: 1337,
              previousBest: 0,
              newBest: 1337,
              closedAt: EXAMPLE_GENERATED_AT,
            },
          ],
        }),
      },
      makeEnv({ DEV_API_KEY: DEV_KEY }),
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { success: boolean };
    expect(payload.success).toBe(true);
  });

  it("POST /leaderboard/dev/seed with empty events returns 400", async () => {
    const response = await requestApi(
      "/leaderboard/dev/seed",
      {
        method: "POST",
        headers: { "content-type": "application/json", ...devAuthHeaders },
        body: JSON.stringify({ events: [] }),
      },
      makeEnv({ DEV_API_KEY: DEV_KEY }),
    );
    expect(response.status).toBe(400);
  });

  it("POST /leaderboard/dev/seed with invalid JSON returns 400", async () => {
    const response = await requestApi(
      "/leaderboard/dev/seed",
      {
        method: "POST",
        headers: { "content-type": "application/json", ...devAuthHeaders },
        body: "not json",
      },
      makeEnv({ DEV_API_KEY: DEV_KEY }),
    );
    expect(response.status).toBe(400);
  });

  // ── GET /proofs/jobs ──────────────────────────────────────────────────────

  it("GET /proofs/jobs returns 400 when address param is missing", async () => {
    const response = await requestApi("/proofs/jobs", undefined, makeEnv());
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { success: boolean; error: string };
    expect(payload.success).toBe(false);
    expect(payload.error).toContain("address");
  });

  it("GET /proofs/jobs returns 400 for an invalid address", async () => {
    const response = await requestApi("/proofs/jobs?address=not-valid", undefined, makeEnv());
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { success: boolean; error: string };
    expect(payload.success).toBe(false);
    expect(payload.error).toContain("invalid address");
  });

  it("GET /proofs/jobs returns empty list for valid address with no jobs", async () => {
    const response = await requestApi(
      `/proofs/jobs?address=${VALID_CLAIMANT_CONTRACT}`,
      undefined,
      makeEnv(),
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      success: boolean;
      jobs: unknown[];
      total: number;
      offset: number;
      limit: number;
      next_offset: number | null;
    };
    expect(payload.success).toBe(true);
    expect(payload.jobs).toHaveLength(0);
    expect(payload.total).toBe(0);
    expect(payload.next_offset).toBeNull();
  });

  it("GET /proofs/jobs returns jobs and pagination metadata", async () => {
    const stubJob = {
      jobId: "job-abc",
      status: "succeeded",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:01:00.000Z",
      completedAt: "2026-01-01T00:01:00.000Z",
      tape: {
        sizeBytes: 512,
        key: "proof-jobs/job-abc/input.tape",
        metadata: { seed: 1, frameCount: 10, finalScore: 100, finalRngState: 0, checksum: 0 },
      },
      queue: { attempts: 1, lastAttemptAt: null, lastError: null, nextRetryAt: null },
      prover: {
        jobId: null,
        status: null,
        statusUrl: null,
        segmentLimitPo2: null,
        lastPolledAt: null,
        pollingErrors: 0,
      },
      proverAttempts: [],
      result: null,
      claim: {
        claimantAddress: VALID_CLAIMANT_CONTRACT,
        status: "queued",
        attempts: 0,
        lastAttemptAt: null,
        lastError: null,
        nextRetryAt: null,
        submittedAt: null,
        txHash: null,
      },
      error: null,
    };
    const response = await requestApi(
      `/proofs/jobs?address=${VALID_CLAIMANT_CONTRACT}&limit=10&offset=0`,
      undefined,
      makeEnv({
        __coordinator: makeCoordinatorStub({
          listJobsForClaimant: async () => ({ jobs: [stubJob], total: 1 }),
        }),
      }),
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      success: boolean;
      jobs: Array<{ jobId: string }>;
      total: number;
      offset: number;
      limit: number;
      next_offset: number | null;
    };
    expect(payload.success).toBe(true);
    expect(payload.jobs).toHaveLength(1);
    expect(payload.jobs[0].jobId).toBe("job-abc");
    expect(payload.total).toBe(1);
    expect(payload.offset).toBe(0);
    expect(payload.limit).toBe(10);
    expect(payload.next_offset).toBeNull();
  });

  it("GET /proofs/jobs computes next_offset when more pages remain", async () => {
    // 3 total jobs, limit=2, offset=0 → next_offset=2
    const stubJobs = Array.from({ length: 2 }, (_, i) => ({
      jobId: `job-${i}`,
      status: "succeeded",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:01:00.000Z",
      completedAt: null,
      tape: {
        sizeBytes: 100,
        key: `proof-jobs/job-${i}/input.tape`,
        metadata: { seed: i, frameCount: 10, finalScore: 100, finalRngState: 0, checksum: 0 },
      },
      queue: { attempts: 1, lastAttemptAt: null, lastError: null, nextRetryAt: null },
      prover: { jobId: null, status: null, statusUrl: null, segmentLimitPo2: null, lastPolledAt: null, pollingErrors: 0 },
      proverAttempts: [],
      result: null,
      claim: { claimantAddress: VALID_CLAIMANT_CONTRACT, status: "queued", attempts: 0, lastAttemptAt: null, lastError: null, nextRetryAt: null, submittedAt: null, txHash: null },
      error: null,
    }));

    const response = await requestApi(
      `/proofs/jobs?address=${VALID_CLAIMANT_CONTRACT}&limit=2&offset=0`,
      undefined,
      makeEnv({
        __coordinator: makeCoordinatorStub({
          listJobsForClaimant: async () => ({ jobs: stubJobs, total: 3 }),
        }),
      }),
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      next_offset: number | null;
    };
    expect(payload.next_offset).toBe(2);
  });

  // ── GET /proofs/jobs/:jobId/tape ──────────────────────────────────────────

  it("GET /proofs/jobs/:jobId/tape returns 404 when job does not exist", async () => {
    const response = await requestApi("/proofs/jobs/no-such-job/tape", undefined, makeEnv());
    expect(response.status).toBe(404);
  });

  it("GET /proofs/jobs/:jobId/tape returns 404 when tape artifact is missing", async () => {
    const response = await requestApi(
      "/proofs/jobs/job-exists/tape",
      undefined,
      makeEnv({
        __coordinator: makeCoordinatorStub({
          getJob: async () => ({
            jobId: "job-exists",
            tape: { key: "proof-jobs/job-exists/input.tape", sizeBytes: 100, metadata: {} },
          }),
        }),
        // PROOF_ARTIFACTS.get returns null (tape not in R2)
        PROOF_ARTIFACTS: {
          get: async () => null,
          put: async () => undefined,
          delete: async () => undefined,
        } as unknown as R2Bucket,
      }),
    );
    expect(response.status).toBe(404);
  });

  it("GET /proofs/jobs/:jobId/tape streams tape bytes when present", async () => {
    const tapeBody = new Uint8Array([1, 2, 3, 4]);
    const response = await requestApi(
      "/proofs/jobs/job-with-tape/tape",
      undefined,
      makeEnv({
        __coordinator: makeCoordinatorStub({
          getJob: async () => ({
            jobId: "job-with-tape",
            tape: { key: "proof-jobs/job-with-tape/input.tape", sizeBytes: 4, metadata: {} },
          }),
        }),
        PROOF_ARTIFACTS: {
          get: async () => ({
            body: new ReadableStream({
              start(controller) {
                controller.enqueue(tapeBody);
                controller.close();
              },
            }),
          }),
          put: async () => undefined,
          delete: async () => undefined,
        } as unknown as R2Bucket,
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-disposition")).toContain("job-with-tape.tape");
    const buf = await response.arrayBuffer();
    expect(new Uint8Array(buf)).toEqual(tapeBody);
  });
});
