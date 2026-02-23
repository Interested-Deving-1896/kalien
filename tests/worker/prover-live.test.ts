/**
 * Live integration tests against the real Vast.ai prover.
 *
 * These tests hit the actual prover at PROVER_BASE_URL and generate real proofs.
 * They verify the full worker prover client pipeline:
 *   getValidatedProverHealth → submitToProver → pollProverOnce → summarizeProof
 *
 * Skipped automatically when PROVER_BASE_URL is not set or prover is unreachable.
 */
import { describe, it, expect, beforeAll } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  getValidatedProverHealth,
  submitToProver,
  pollProverOnce,
  summarizeProof,
} from "../../worker/prover/client";
import type { WorkerEnv } from "../../worker/env";

const PROVER_BASE_URL = "https://risc0-kalien.stellar.buzz";
const TAPE_DIR = join(import.meta.dir, "../../test-fixtures");

function makeEnv(overrides?: Partial<WorkerEnv>): WorkerEnv {
  return {
    PROVER_BASE_URL,
    PROVER_API_KEY: "",
    ALLOW_INSECURE_PROVER_URL: "0",
    ...overrides,
  } as WorkerEnv;
}

let proverReachable = false;

beforeAll(async () => {
  try {
    const response = await fetch(`${PROVER_BASE_URL}/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    proverReachable = response.ok;
  } catch {
    proverReachable = false;
  }
  if (!proverReachable) {
    console.warn("Prover unreachable — skipping live prover tests");
  }
});

function skipIfUnreachable() {
  if (!proverReachable) {
    return true;
  }
  return false;
}

describe("live prover integration", () => {
  // ───── Health check ─────

  it("getValidatedProverHealth returns valid health", async () => {
    if (skipIfUnreachable()) return;

    const env = makeEnv();
    const health = await getValidatedProverHealth(env, { forceRefresh: true });

    expect(health.imageId).toMatch(/^[0-9a-f]{64}$/);
    expect(health.rulesDigest).toBe(0x41535433 >>> 0);
    expect(health.rulesDigestHex).toBe("0x41535433");
    expect(health.ruleset).toBe("AST3");
  });

  it("getValidatedProverHealth rejects wrong expected image_id", async () => {
    if (skipIfUnreachable()) return;

    const env = makeEnv({
      PROVER_EXPECTED_IMAGE_ID: "0000000000000000000000000000000000000000000000000000000000000000",
    });

    await expect(getValidatedProverHealth(env, { forceRefresh: true })).rejects.toThrow(
      /image_id mismatch/,
    );
  });

  // ───── Submit + poll (medium tape, groth16) ─────

  it("submit → poll → summarize produces valid Groth16 proof for medium tape", async () => {
    if (skipIfUnreachable()) return;

    const env = makeEnv();
    const tapeBytes = new Uint8Array(readFileSync(join(TAPE_DIR, "test-medium.tape")));

    // Submit
    const submitResult = await submitToProver(env, tapeBytes, { segmentLimitPo2: 21 });
    expect(submitResult.type).toBe("success");
    if (submitResult.type !== "success") return;

    expect(submitResult.jobId).toBeTruthy();
    expect(submitResult.statusUrl).toContain(submitResult.jobId);
    expect(submitResult.segmentLimitPo2).toBe(21);

    // Poll until done (max 5 minutes)
    const deadline = Date.now() + 300_000;
    let pollResult = await pollProverOnce(env, submitResult.jobId);

    while (pollResult.type === "running" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5_000));
      pollResult = await pollProverOnce(env, submitResult.jobId);
    }

    expect(pollResult.type).toBe("success");
    if (pollResult.type !== "success") return;

    // Verify response structure
    const response = pollResult.response;
    expect(response.status).toBe("succeeded");
    expect(response.tape_size_bytes).toBe(tapeBytes.byteLength);
    expect(response.options.receipt_kind).toBe("groth16");
    expect(response.options.proof_mode).toBe("secure");
    expect(response.options.accelerator).toBe("cuda");

    // Verify journal matches tape
    const journal = response.result!.proof.journal;
    expect(journal.seed).toBe(0xdeadbeef >>> 0);
    expect(journal.frame_count).toBe(3980);
    expect(journal.final_score).toBe(90);
    expect(journal.final_rng_state).toBe(0xeb0719ce >>> 0);
    expect(journal.rules_digest).toBe(0x41535433 >>> 0);

    // Verify Groth16 receipt
    expect(response.result!.proof.requested_receipt_kind).toBe("groth16");
    expect(response.result!.proof.produced_receipt_kind).toBe("groth16");

    // Verify stats
    const stats = response.result!.proof.stats;
    expect(stats.segments).toBeGreaterThan(0);
    expect(stats.total_cycles).toBeGreaterThan(0);

    // Verify summarizeProof works
    const summary = summarizeProof(response);
    expect(summary.journal.final_score).toBe(90);
    expect(summary.requestedReceiptKind).toBe("groth16");
    expect(summary.producedReceiptKind).toBe("groth16");
    expect(summary.stats.segments).toBeGreaterThan(0);
  }, 300_000);

  // ───── Submit + poll (real game tape, groth16) ─────

  it("submit → poll → summarize produces valid proof for real game tape (score=32860)", async () => {
    if (skipIfUnreachable()) return;

    const env = makeEnv();
    const tapeBytes = new Uint8Array(readFileSync(join(TAPE_DIR, "test-real-game.tape")));

    const submitResult = await submitToProver(env, tapeBytes, { segmentLimitPo2: 21 });
    expect(submitResult.type).toBe("success");
    if (submitResult.type !== "success") return;

    const deadline = Date.now() + 300_000;
    let pollResult = await pollProverOnce(env, submitResult.jobId);

    while (pollResult.type === "running" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5_000));
      pollResult = await pollProverOnce(env, submitResult.jobId);
    }

    expect(pollResult.type).toBe("success");
    if (pollResult.type !== "success") return;

    const journal = pollResult.response.result!.proof.journal;
    expect(journal.seed).toBe(0x43c9c6cd >>> 0);
    expect(journal.frame_count).toBe(13829);
    expect(journal.final_score).toBe(32860);
    expect(journal.final_rng_state).toBe(0xa9713c03 >>> 0);
    expect(journal.rules_digest).toBe(0x41535433 >>> 0);

    expect(pollResult.response.result!.proof.produced_receipt_kind).toBe("groth16");

    const summary = summarizeProof(pollResult.response);
    expect(summary.journal.final_score).toBe(32860);
  }, 300_000);

  // ───── Zero-score rejection ─────

  it("rejects zero-score tape", async () => {
    if (skipIfUnreachable()) return;

    const env = makeEnv();
    const tapeBytes = new Uint8Array(readFileSync(join(TAPE_DIR, "test-short.tape")));

    const submitResult = await submitToProver(env, tapeBytes, { segmentLimitPo2: 21 });
    // The prover rejects score=0 with a 4xx — worker client should report fatal
    expect(submitResult.type).toBe("fatal");
    if (submitResult.type === "fatal") {
      expect(submitResult.message).toMatch(/zero.*score|final_score.*zero|score.*greater/i);
    }
  });

  // ───── Poll nonexistent job ─────

  it("pollProverOnce returns retry for nonexistent job", async () => {
    if (skipIfUnreachable()) return;

    const env = makeEnv();
    const result = await pollProverOnce(env, "00000000-0000-0000-0000-000000000000");

    expect(result.type).toBe("retry");
    if (result.type === "retry") {
      expect(result.clearProverJob).toBe(true);
      expect(result.message).toMatch(/not found/i);
    }
  });
});
