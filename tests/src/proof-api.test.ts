import { afterEach, describe, expect, it } from "bun:test";
import { serializeTape } from "../../src/game/tape";
import { fetchProofTape, ProofApiError, submitProofJob } from "../../src/proof/api";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("fetchProofTape", () => {
  it("returns tape bytes and filename for octet-stream responses", async () => {
    const tapeBytes = serializeTape(0x1234abcd, new Uint8Array([1, 2, 3, 4]), 9001);

    globalThis.fetch = (async () =>
      new Response(tapeBytes, {
        status: 200,
        headers: {
          "content-type": "application/octet-stream",
          "content-disposition": 'attachment; filename="job-123.tape"',
        },
      })) as typeof fetch;

    const result = await fetchProofTape("job-123");
    expect(result.filename).toBe("job-123.tape");
    expect(result.bytes).toEqual(tapeBytes);
  });

  it("rejects html responses instead of treating them as tape bytes", async () => {
    globalThis.fetch = (async () =>
      new Response("<!doctype html><html><body>spa shell</body></html>", {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
        },
      })) as typeof fetch;

    try {
      await fetchProofTape("job-html");
      throw new Error("expected fetchProofTape to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(ProofApiError);
      expect((error as Error).message).toBe("expected tape bytes but received HTML");
    }
  });
});

describe("submitProofJob", () => {
  it("parses duplicate replay responses", async () => {
    const tapeBytes = serializeTape(0x1234abcd, new Uint8Array([1, 2, 3, 4]), 9001);

    globalThis.fetch = (async () =>
      Response.json({
        success: true,
        duplicate: true,
        replay_hash: "deadbeef",
        status_url: "/api/proofs/jobs/job-123",
        job: {
          jobId: "job-123",
          status: "queued",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          completedAt: null,
          replayHash: "deadbeef",
          replayLockState: "reserved",
          replayLockedBackend: null,
          tape: {
            sizeBytes: tapeBytes.byteLength,
            metadata: {
              seed: 0x1234abcd,
              seedId: 7,
              frameCount: 4,
              finalScore: 9001,
              checksum: 123,
            },
          },
          queue: {
            attempts: 0,
            lastAttemptAt: null,
            lastError: null,
            nextRetryAt: null,
          },
          prover: {
            jobId: null,
            status: null,
            statusUrl: null,
            lastPolledAt: null,
            pollingErrors: 0,
            ipfsCid: null,
          },
          proverAttempts: [],
          claimAttempts: [],
          result: null,
          claim: {
            claimantAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
            status: "queued",
            attempts: 0,
            lastAttemptAt: null,
            lastError: null,
            nextRetryAt: null,
            submittedAt: null,
            txHash: null,
          },
          error: null,
        },
      })) as typeof fetch;

    const result = await submitProofJob(
      tapeBytes,
      "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      7,
    );

    expect(result.duplicate).toBe(true);
    expect(result.replay_hash).toBe("deadbeef");
    expect(result.job.replayHash).toBe("deadbeef");
    expect(result.job.jobId).toBe("job-123");
  });
});
