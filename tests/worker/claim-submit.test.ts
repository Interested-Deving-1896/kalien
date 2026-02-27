import { describe, expect, it } from "bun:test";
import { JOURNAL_LEN } from "../../shared/stellar/journal";
import { STELLAR_GROTH16_SEAL_LEN } from "../../worker/proof-artifact";
import { submitClaim } from "../../worker/claim/submit";
import type { WorkerEnv } from "../../worker/env";

const BASE_REQUEST = {
  jobId: "job-1",
  journalRawHex: "00".repeat(JOURNAL_LEN),
  journalDigestHex: "11".repeat(32),
  sealHex: "22".repeat(STELLAR_GROTH16_SEAL_LEN),
};

describe("submitClaim relayer-only config handling", () => {
  it("fails when relayer-only env is not configured", async () => {
    const env = {
      RELAYER_URL: "",
      SCORE_CONTRACT_ID: "",
    } as WorkerEnv;

    const result = await submitClaim(env, BASE_REQUEST);
    expect(result.type).toBe("fatal");
    expect(result.message).toContain("claim submission is not configured");
  });
});
