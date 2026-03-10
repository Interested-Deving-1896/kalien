import { describe, expect, it } from "bun:test";
import type { ProofJobPublic } from "../../src/proof/api";
import { isSupersededProofJob } from "../../src/proof/helpers";

function makeJob(overrides: Partial<ProofJobPublic> = {}): ProofJobPublic {
  return {
    jobId: "job-1",
    status: "succeeded",
    createdAt: "2026-03-10T00:00:00.000Z",
    updatedAt: "2026-03-10T00:00:00.000Z",
    completedAt: "2026-03-10T00:00:00.000Z",
    tape: {
      sizeBytes: 1,
      metadata: {
        seed: 1,
        seedId: 1,
        frameCount: 1,
        finalScore: 1,
        checksum: 1,
      },
    },
    queue: {
      attempts: 1,
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
    result: null,
    claim: {
      claimantAddress: "GABC",
      status: "succeeded",
      attempts: 1,
      lastAttemptAt: null,
      lastError: null,
      nextRetryAt: null,
      submittedAt: null,
      txHash: null,
    },
    error: null,
    errorCode: null,
    timeoutPhase: null,
    proverAttempts: [],
    claimAttempts: [],
    ...overrides,
  };
}

describe("isSupersededProofJob", () => {
  it("returns true for succeeded jobs with superseded claim marker", () => {
    const job = makeJob({
      claim: {
        claimantAddress: "GABC",
        status: "succeeded",
        attempts: 1,
        lastAttemptAt: null,
        lastError: null,
        nextRetryAt: null,
        submittedAt: null,
        txHash: "superseded-by-higher-score",
      },
    });

    expect(isSupersededProofJob(job)).toBe(true);
  });

  it("returns true for failed jobs with superseded error code", () => {
    const job = makeJob({
      status: "failed",
      claim: {
        claimantAddress: "GABC",
        status: "failed",
        attempts: 0,
        lastAttemptAt: null,
        lastError: "proof skipped",
        nextRetryAt: null,
        submittedAt: null,
        txHash: null,
      },
      error: "proof skipped: superseded by claimed score 10 for seed_id 1",
      errorCode: "superseded_by_higher_score",
    });

    expect(isSupersededProofJob(job)).toBe(true);
  });

  it("returns false for ordinary failed jobs", () => {
    const job = makeJob({
      status: "failed",
      claim: {
        claimantAddress: "GABC",
        status: "failed",
        attempts: 0,
        lastAttemptAt: null,
        lastError: "no prover locked the order",
        nextRetryAt: null,
        submittedAt: null,
        txHash: null,
      },
      error: "no prover locked the order",
      errorCode: "prover_timeout",
    });

    expect(isSupersededProofJob(job)).toBe(false);
  });
});
