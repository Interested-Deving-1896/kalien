import { describe, expect, it, mock } from "bun:test";
import type { WorkerEnv } from "../../worker/env";

// Mock coordinator and prover before importing the consumer
mock.module("../../worker/durable/coordinator", () => ({
  coordinatorStub: (env: WorkerEnv) =>
    (env as WorkerEnv & { __coordinator: Record<string, unknown> }).__coordinator,
  asPublicJob: <T>(job: T): T => job,
  ProofCoordinatorDO: class ProofCoordinatorDO {},
}));

mock.module("../../worker/prover/client", () => ({
  submitToProver: async (
    env: WorkerEnv,
    _tape: Uint8Array,
    _opts: unknown,
  ) => (env as WorkerEnv & { __submitResult: unknown }).__submitResult,
}));

mock.module("../../worker/claim/submit", () => ({
  submitClaim: async (
    env: WorkerEnv,
    _request: unknown,
  ) => {
    const result = (env as WorkerEnv & { __claimResult: unknown }).__claimResult;
    // Fallback for when this mock leaks to other test files
    return result ?? { type: "fatal", message: "claim submission is not configured; set SCORE_CONTRACT_ID, RELAYER_URL, and RELAYER_API_KEY for relayer-only submission" };
  },
}));

const { handleQueueBatch, handleDlqBatch, handleClaimQueueBatch, handleClaimDlqBatch } =
  await import("../../worker/queue/consumer");

function makeMessage<T>(body: T, attempts = 1): Message<T> {
  let acked = false;
  let retried = false;
  return {
    body,
    id: "msg-1",
    timestamp: new Date(),
    attempts,
    ack() {
      acked = true;
    },
    retry(options?: { delaySeconds?: number }) {
      retried = true;
    },
    get _acked() {
      return acked;
    },
    get _retried() {
      return retried;
    },
  } as Message<T> & { _acked: boolean; _retried: boolean };
}

function makeBatch<T>(messages: Message<T>[]): MessageBatch<T> {
  return {
    queue: "test-queue",
    messages,
    ackAll() {},
    retryAll() {},
  } as MessageBatch<T>;
}

function makeCoordinator(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const calls: Array<{ method: string; args: unknown[] }> = [];

  const defaults: Record<string, (...args: unknown[]) => Promise<unknown>> = {
    beginQueueAttempt: async () => null,
    getJob: async () => null,
    markFailed: async () => null,
    markRetry: async () => null,
    markProverAccepted: async () => null,
    markSucceeded: async () => null,
    beginClaimAttempt: async () => null,
    markClaimFailed: async () => null,
    markClaimRetry: async () => null,
    markClaimSucceeded: async () => null,
  };

  const merged = { ...defaults, ...overrides };
  const tracked: Record<string, unknown> = { _calls: calls };
  for (const [method, fn] of Object.entries(merged)) {
    if (typeof fn === "function") {
      tracked[method] = async (...args: unknown[]) => {
        calls.push({ method, args });
        return (fn as (...a: unknown[]) => unknown)(...args);
      };
    } else {
      tracked[method] = fn;
    }
  }
  return tracked;
}

function makeEnv(overrides: Record<string, unknown> = {}): WorkerEnv {
  return {
    PROVER_BASE_URL: "https://prover.test",
    PROOF_ARTIFACTS: {
      get: async () => null,
      put: async () => undefined,
      delete: async () => undefined,
    },
    PROOF_QUEUE: { send: async () => undefined },
    CLAIM_QUEUE: { send: async () => undefined },
    ...overrides,
  } as unknown as WorkerEnv;
}

describe("handleQueueBatch", () => {
  it("acks message with invalid payload (missing jobId)", async () => {
    const msg = makeMessage({} as { jobId: string });
    await handleQueueBatch(makeBatch([msg]), makeEnv({ __coordinator: makeCoordinator() }));
    expect((msg as unknown as { _acked: boolean })._acked).toBe(true);
  });

  it("acks when job is already terminal", async () => {
    const coordinator = makeCoordinator({
      beginQueueAttempt: async () => ({ jobId: "job-1", status: "succeeded" }),
    });
    const msg = makeMessage({ jobId: "job-1" });
    await handleQueueBatch(makeBatch([msg]), makeEnv({ __coordinator: coordinator }));
    expect((msg as unknown as { _acked: boolean })._acked).toBe(true);
  });

  it("marks job succeeded on successful prover flow", async () => {
    const coordinator = makeCoordinator({
      beginQueueAttempt: async () => ({
        jobId: "job-1",
        status: "dispatching",
        tape: {
          key: "tapes/job-1",
          metadata: { finalScore: 100 },
        },
        prover: { jobId: null },
        createdAt: new Date().toISOString(),
      }),
      markProverAccepted: async () => null,
    });
    const msg = makeMessage({ jobId: "job-1" });
    const env = makeEnv({
      __coordinator: coordinator,
      __submitResult: {
        type: "success",
        jobId: "prover-job-1",
        statusUrl: "/api/jobs/prover-job-1",
        segmentLimitPo2: 21,
      },
      PROOF_ARTIFACTS: {
        get: async () => ({
          arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
        }),
      },
    });
    await handleQueueBatch(makeBatch([msg]), env);
    expect((msg as unknown as { _acked: boolean })._acked).toBe(true);
    const calls = (coordinator as Record<string, unknown>)._calls as Array<{
      method: string;
    }>;
    expect(calls.some((c) => c.method === "markProverAccepted")).toBe(true);
  });

  it("retries when prover returns retry and attempts not exhausted", async () => {
    const coordinator = makeCoordinator({
      beginQueueAttempt: async () => ({
        jobId: "job-1",
        status: "dispatching",
        tape: {
          key: "tapes/job-1",
          metadata: { finalScore: 100 },
        },
        prover: { jobId: null },
        createdAt: new Date().toISOString(),
      }),
    });
    const msg = makeMessage({ jobId: "job-1" }, 1);
    const env = makeEnv({
      __coordinator: coordinator,
      __submitResult: { type: "retry", message: "rate limited" },
      PROOF_ARTIFACTS: {
        get: async () => ({
          arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
        }),
      },
    });
    await handleQueueBatch(makeBatch([msg]), env);
    expect((msg as unknown as { _retried: boolean })._retried).toBe(true);
  });

  it("marks failed when prover returns fatal", async () => {
    const coordinator = makeCoordinator({
      beginQueueAttempt: async () => ({
        jobId: "job-1",
        status: "dispatching",
        tape: {
          key: "tapes/job-1",
          metadata: { finalScore: 100 },
        },
        prover: { jobId: null },
        createdAt: new Date().toISOString(),
      }),
    });
    const msg = makeMessage({ jobId: "job-1" });
    const env = makeEnv({
      __coordinator: coordinator,
      __submitResult: { type: "fatal", message: "invalid tape" },
      PROOF_ARTIFACTS: {
        get: async () => ({
          arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
        }),
      },
    });
    await handleQueueBatch(makeBatch([msg]), env);
    expect((msg as unknown as { _acked: boolean })._acked).toBe(true);
    const calls = (coordinator as Record<string, unknown>)._calls as Array<{
      method: string;
    }>;
    expect(calls.some((c) => c.method === "markFailed")).toBe(true);
  });

  it("marks permanently failed when max retries exceeded", async () => {
    const coordinator = makeCoordinator({
      beginQueueAttempt: async () => ({
        jobId: "job-1",
        status: "dispatching",
        tape: {
          key: "tapes/job-1",
          metadata: { finalScore: 100 },
        },
        prover: { jobId: null },
        createdAt: new Date().toISOString(),
      }),
    });
    const msg = makeMessage({ jobId: "job-1" }, 10); // MAX_QUEUE_RETRIES = 10
    const env = makeEnv({
      __coordinator: coordinator,
      __submitResult: { type: "retry", message: "prover busy" },
      PROOF_ARTIFACTS: {
        get: async () => ({
          arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
        }),
      },
    });
    await handleQueueBatch(makeBatch([msg]), env);
    expect((msg as unknown as { _acked: boolean })._acked).toBe(true);
    const calls = (coordinator as Record<string, unknown>)._calls as Array<{
      method: string;
    }>;
    expect(calls.some((c) => c.method === "markFailed")).toBe(true);
  });
});

describe("handleDlqBatch", () => {
  it("marks non-terminal jobs as failed", async () => {
    const coordinator = makeCoordinator({
      getJob: async () => ({ jobId: "job-1", status: "retrying" }),
    });
    const msg = makeMessage({ jobId: "job-1" });
    await handleDlqBatch(makeBatch([msg]), makeEnv({ __coordinator: coordinator }));
    expect((msg as unknown as { _acked: boolean })._acked).toBe(true);
    const calls = (coordinator as Record<string, unknown>)._calls as Array<{
      method: string;
    }>;
    expect(calls.some((c) => c.method === "markFailed")).toBe(true);
  });

  it("skips already-terminal jobs", async () => {
    const coordinator = makeCoordinator({
      getJob: async () => ({ jobId: "job-1", status: "succeeded" }),
    });
    const msg = makeMessage({ jobId: "job-1" });
    await handleDlqBatch(makeBatch([msg]), makeEnv({ __coordinator: coordinator }));
    expect((msg as unknown as { _acked: boolean })._acked).toBe(true);
    const calls = (coordinator as Record<string, unknown>)._calls as Array<{
      method: string;
    }>;
    expect(calls.some((c) => c.method === "markFailed")).toBe(false);
  });

  it("acks invalid messages", async () => {
    const msg = makeMessage({} as { jobId: string });
    await handleDlqBatch(makeBatch([msg]), makeEnv({ __coordinator: makeCoordinator() }));
    expect((msg as unknown as { _acked: boolean })._acked).toBe(true);
  });
});

describe("handleClaimQueueBatch", () => {
  it("acks when job not succeeded", async () => {
    const coordinator = makeCoordinator({
      beginClaimAttempt: async () => ({ jobId: "job-1", status: "failed" }),
    });
    const msg = makeMessage({ jobId: "job-1" });
    await handleClaimQueueBatch(makeBatch([msg]), makeEnv({ __coordinator: coordinator }));
    expect((msg as unknown as { _acked: boolean })._acked).toBe(true);
  });

  it("acks when claim already succeeded", async () => {
    const coordinator = makeCoordinator({
      beginClaimAttempt: async () => ({
        jobId: "job-1",
        status: "succeeded",
        claim: { status: "succeeded" },
        result: { summary: {}, artifactKey: "key" },
      }),
    });
    const msg = makeMessage({ jobId: "job-1" });
    await handleClaimQueueBatch(makeBatch([msg]), makeEnv({ __coordinator: coordinator }));
    expect((msg as unknown as { _acked: boolean })._acked).toBe(true);
  });

  it("marks claim succeeded on successful claim", async () => {
    const coordinator = makeCoordinator({
      beginClaimAttempt: async () => ({
        jobId: "job-1",
        status: "succeeded",
        claim: { status: "submitting", claimantAddress: "GABC" },
        result: {
          summary: {
            journal: {
              seed: 1,
              frame_count: 10,
              final_score: 100,
              final_rng_state: 1,
              tape_checksum: 1,
              rules_digest: 1,
            },
          },
          artifactKey: "results/job-1.json",
        },
      }),
    });
    const msg = makeMessage({ jobId: "job-1" });
    const env = makeEnv({
      __coordinator: coordinator,
      __claimResult: { type: "success", txHash: "tx-123" },
      PROOF_ARTIFACTS: {
        get: async () => ({
          json: async () => ({ prover_response: {} }),
        }),
      },
    });
    await handleClaimQueueBatch(makeBatch([msg]), env);
    expect((msg as unknown as { _acked: boolean })._acked).toBe(true);
    const calls = (coordinator as Record<string, unknown>)._calls as Array<{
      method: string;
    }>;
    expect(calls.some((c) => c.method === "markClaimSucceeded")).toBe(true);
  });

  it("retries claim on retry result", async () => {
    const coordinator = makeCoordinator({
      beginClaimAttempt: async () => ({
        jobId: "job-1",
        status: "succeeded",
        claim: { status: "submitting", claimantAddress: "GABC" },
        result: {
          summary: {
            journal: {
              seed: 1,
              frame_count: 10,
              final_score: 100,
              final_rng_state: 1,
              tape_checksum: 1,
              rules_digest: 1,
            },
          },
          artifactKey: "results/job-1.json",
        },
      }),
    });
    const msg = makeMessage({ jobId: "job-1" }, 1);
    const env = makeEnv({
      __coordinator: coordinator,
      __claimResult: { type: "retry", message: "temporarily unavailable" },
      PROOF_ARTIFACTS: {
        get: async () => ({
          json: async () => ({ prover_response: {} }),
        }),
      },
    });
    await handleClaimQueueBatch(makeBatch([msg]), env);
    expect((msg as unknown as { _retried: boolean })._retried).toBe(true);
    const calls = (coordinator as Record<string, unknown>)._calls as Array<{
      method: string;
    }>;
    expect(calls.some((c) => c.method === "markClaimRetry")).toBe(true);
  });

  it("marks claim failed on fatal result", async () => {
    const coordinator = makeCoordinator({
      beginClaimAttempt: async () => ({
        jobId: "job-1",
        status: "succeeded",
        claim: { status: "submitting", claimantAddress: "GABC" },
        result: {
          summary: {
            journal: {
              seed: 1,
              frame_count: 10,
              final_score: 100,
              final_rng_state: 1,
              tape_checksum: 1,
              rules_digest: 1,
            },
          },
          artifactKey: "results/job-1.json",
        },
      }),
    });
    const msg = makeMessage({ jobId: "job-1" });
    const env = makeEnv({
      __coordinator: coordinator,
      __claimResult: { type: "fatal", message: "contract error" },
      PROOF_ARTIFACTS: {
        get: async () => ({
          json: async () => ({ prover_response: {} }),
        }),
      },
    });
    await handleClaimQueueBatch(makeBatch([msg]), env);
    expect((msg as unknown as { _acked: boolean })._acked).toBe(true);
    const calls = (coordinator as Record<string, unknown>)._calls as Array<{
      method: string;
    }>;
    expect(calls.some((c) => c.method === "markClaimFailed")).toBe(true);
  });
});

describe("handleClaimDlqBatch", () => {
  it("marks claim as failed with dead-letter message", async () => {
    const coordinator = makeCoordinator({
      getJob: async () => ({
        jobId: "job-1",
        claim: { lastError: "previous error" },
      }),
    });
    const msg = makeMessage({ jobId: "job-1" });
    await handleClaimDlqBatch(makeBatch([msg]), makeEnv({ __coordinator: coordinator }));
    expect((msg as unknown as { _acked: boolean })._acked).toBe(true);
    const calls = (coordinator as Record<string, unknown>)._calls as Array<{
      method: string;
      args: unknown[];
    }>;
    const failCall = calls.find((c) => c.method === "markClaimFailed");
    expect(failCall).toBeDefined();
    expect(String(failCall!.args[1])).toContain("dead-letter");
  });
});
