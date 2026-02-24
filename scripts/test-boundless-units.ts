/**
 * Unit tests for Boundless integration helpers.
 *
 * Usage: bun run scripts/test-boundless-units.ts
 */

import { encodeStdin } from "../worker/boundless/stdin";
import { adaptFulfillmentToProverResponse } from "../worker/boundless/adapter";
import { DEFAULT_BOUNDLESS_MAX_FRAMES } from "../worker/constants";
import type { FulfillmentData } from "../worker/boundless/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (!condition) {
    failed++;
    console.error("  FAIL: " + message);
    throw new Error("Assertion failed: " + message);
  }
}

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log("  PASS: " + name);
  } catch (err: unknown) {
    console.error("  FAIL: " + name);
    if (err instanceof Error) {
      console.error("        " + err.message);
    }
  }
}

// ---------------------------------------------------------------------------
// encodeStdin tests
// ---------------------------------------------------------------------------

console.log("\n=== encodeStdin ===\n");

test("total length = 4 + 4 + paddedLen when tape is already aligned", () => {
  const tape = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const result = encodeStdin(tape);
  assert(result.length === 4 + 4 + 8, "expected 16, got " + result.length);
});

test("total length pads tape to 4-byte alignment", () => {
  const tape = new Uint8Array([10, 20, 30, 40, 50]);
  const result = encodeStdin(tape);
  assert(result.length === 4 + 4 + 8, "expected 16, got " + result.length);
});

test("first 4 bytes are max_frames as u32 LE (default)", () => {
  const tape = new Uint8Array([0xAA]);
  const result = encodeStdin(tape);
  const view = new DataView(result.buffer, result.byteOffset, result.byteLength);
  const frames = view.getUint32(0, true);
  assert(frames === DEFAULT_BOUNDLESS_MAX_FRAMES, "expected " + DEFAULT_BOUNDLESS_MAX_FRAMES + ", got " + frames);
});

test("first 4 bytes are max_frames as u32 LE (custom)", () => {
  const tape = new Uint8Array([0xBB]);
  const customFrames = 42;
  const result = encodeStdin(tape, customFrames);
  const view = new DataView(result.buffer, result.byteOffset, result.byteLength);
  const frames = view.getUint32(0, true);
  assert(frames === customFrames, "expected " + customFrames + ", got " + frames);
});

test("bytes 4-7 are tape_len as u32 LE", () => {
  const tape = new Uint8Array([1, 2, 3, 4, 5]);
  const result = encodeStdin(tape);
  const view = new DataView(result.buffer, result.byteOffset, result.byteLength);
  const tapeLen = view.getUint32(4, true);
  assert(tapeLen === 5, "expected 5, got " + tapeLen);
});

test("bytes 8..N contain the tape data followed by zero padding", () => {
  const tape = new Uint8Array([0x11, 0x22, 0x33]);
  const result = encodeStdin(tape);
  assert(result[8] === 0x11, "byte 8: expected 0x11, got 0x" + result[8].toString(16));
  assert(result[9] === 0x22, "byte 9: expected 0x22, got 0x" + result[9].toString(16));
  assert(result[10] === 0x33, "byte 10: expected 0x33, got 0x" + result[10].toString(16));
  assert(result[11] === 0x00, "padding byte 11: expected 0x00, got 0x" + result[11].toString(16));
});

test("empty tape produces 8 byte output (just headers)", () => {
  const tape = new Uint8Array([]);
  const result = encodeStdin(tape);
  assert(result.length === 8, "expected 8, got " + result.length);
  const view = new DataView(result.buffer, result.byteOffset, result.byteLength);
  assert(view.getUint32(4, true) === 0, "tape_len should be 0, got " + view.getUint32(4, true));
});

test("large tape preserves all bytes and alignment", () => {
  const tape = new Uint8Array(1025);
  for (let i = 0; i < tape.length; i++) tape[i] = i & 0xFF;
  const result = encodeStdin(tape);
  assert(result.length === 4 + 4 + 1028, "expected " + (4 + 4 + 1028) + ", got " + result.length);
  assert(result[8] === 0, "first tape byte wrong");
  assert(result[8 + 1024] === (1024 & 0xFF), "tape byte at offset 1024 wrong");
  assert(result[8 + 1025] === 0, "padding byte 1 not zero");
  assert(result[8 + 1026] === 0, "padding byte 2 not zero");
  assert(result[8 + 1027] === 0, "padding byte 3 not zero");
});

// ---------------------------------------------------------------------------
// adapter.ts tests
// ---------------------------------------------------------------------------

console.log("\n=== adaptFulfillmentToProverResponse ===\n");

function makeFakeSeal(selectorBytes: [number, number, number, number]): Uint8Array {
  const seal = new Uint8Array(260);
  seal[0] = selectorBytes[0];
  seal[1] = selectorBytes[1];
  seal[2] = selectorBytes[2];
  seal[3] = selectorBytes[3];
  for (let i = 4; i < 260; i++) {
    seal[i] = (i - 4) & 0xFF;
  }
  return seal;
}

function makeFakeJournal(fields: {
  seed: number;
  frame_count: number;
  final_score: number;
  final_rng_state: number;
  tape_checksum: number;
  rules_digest: number;
}): Uint8Array {
  const buf = new Uint8Array(24);
  const view = new DataView(buf.buffer);
  view.setUint32(0, fields.seed, true);
  view.setUint32(4, fields.frame_count, true);
  view.setUint32(8, fields.final_score, true);
  view.setUint32(12, fields.final_rng_state, true);
  view.setUint32(16, fields.tape_checksum, true);
  view.setUint32(20, fields.rules_digest, true);
  return buf;
}

const TEST_SELECTOR: [number, number, number, number] = [0xDE, 0xAD, 0xBE, 0xEF];
const TEST_JOURNAL_FIELDS = {
  seed: 0x12345678,
  frame_count: 1000,
  final_score: 42,
  final_rng_state: 0xAABBCCDD,
  tape_checksum: 0xFEEDFACE,
  rules_digest: 0x41535433,
};

test("response has correct job_id and status", () => {
  const fulfillment: FulfillmentData = {
    seal: makeFakeSeal(TEST_SELECTOR),
    journal: makeFakeJournal(TEST_JOURNAL_FIELDS),
  };
  const resp = adaptFulfillmentToProverResponse(fulfillment);
  assert(resp.job_id === "boundless", "job_id: expected boundless, got " + resp.job_id);
  assert(resp.status === "succeeded", "status: expected succeeded, got " + resp.status);
});

test("Groth16 seal is exactly 256 bytes (proof without selector)", () => {
  const fulfillment: FulfillmentData = {
    seal: makeFakeSeal(TEST_SELECTOR),
    journal: makeFakeJournal(TEST_JOURNAL_FIELDS),
  };
  const resp = adaptFulfillmentToProverResponse(fulfillment);
  const groth16Seal = (resp.result as any).proof.receipt.inner.Groth16.seal;
  assert(groth16Seal.length === 256, "seal length: expected 256, got " + groth16Seal.length);
});

test("Groth16 seal content matches proof bytes (selector stripped)", () => {
  const fulfillment: FulfillmentData = {
    seal: makeFakeSeal(TEST_SELECTOR),
    journal: makeFakeJournal(TEST_JOURNAL_FIELDS),
  };
  const resp = adaptFulfillmentToProverResponse(fulfillment);
  const groth16Seal = (resp.result as any).proof.receipt.inner.Groth16.seal;
  for (let i = 0; i < 256; i++) {
    assert(
      groth16Seal[i] === (i & 0xFF),
      "seal[" + i + "]: expected " + (i & 0xFF) + ", got " + groth16Seal[i]
    );
  }
});

test("verifier_parameters is 8-element u32 array with selector in first word", () => {
  const fulfillment: FulfillmentData = {
    seal: makeFakeSeal(TEST_SELECTOR),
    journal: makeFakeJournal(TEST_JOURNAL_FIELDS),
  };
  const resp = adaptFulfillmentToProverResponse(fulfillment);
  const vp = (resp.result as any).proof.receipt.inner.Groth16.verifier_parameters;
  assert(vp.length === 8, "verifier_parameters length: expected 8, got " + vp.length);

  const expectedFirstWord = 0xEFBEADDE;
  assert(
    (vp[0] >>> 0) === expectedFirstWord,
    "verifier_parameters[0]: expected 0x" + expectedFirstWord.toString(16) + ", got 0x" + (vp[0] >>> 0).toString(16)
  );

  for (let i = 1; i < 8; i++) {
    assert(vp[i] === 0, "verifier_parameters[" + i + "]: expected 0, got " + vp[i]);
  }
});

test("journal fields are parsed correctly from 24-byte input", () => {
  const fulfillment: FulfillmentData = {
    seal: makeFakeSeal(TEST_SELECTOR),
    journal: makeFakeJournal(TEST_JOURNAL_FIELDS),
  };
  const resp = adaptFulfillmentToProverResponse(fulfillment);
  const j = (resp.result as any).proof.journal;

  assert(j.seed === TEST_JOURNAL_FIELDS.seed, "seed mismatch");
  assert(j.frame_count === TEST_JOURNAL_FIELDS.frame_count, "frame_count mismatch");
  assert(j.final_score === TEST_JOURNAL_FIELDS.final_score, "final_score mismatch");
  assert((j.final_rng_state >>> 0) === (TEST_JOURNAL_FIELDS.final_rng_state >>> 0), "final_rng_state mismatch");
  assert((j.tape_checksum >>> 0) === (TEST_JOURNAL_FIELDS.tape_checksum >>> 0), "tape_checksum mismatch");
  assert((j.rules_digest >>> 0) === (TEST_JOURNAL_FIELDS.rules_digest >>> 0), "rules_digest mismatch");
});

test("receipt_kind fields are set to groth16", () => {
  const fulfillment: FulfillmentData = {
    seal: makeFakeSeal(TEST_SELECTOR),
    journal: makeFakeJournal(TEST_JOURNAL_FIELDS),
  };
  const resp = adaptFulfillmentToProverResponse(fulfillment);
  assert(
    (resp.result as any).proof.requested_receipt_kind === "groth16",
    "requested_receipt_kind: expected groth16"
  );
  assert(
    (resp.result as any).proof.produced_receipt_kind === "groth16",
    "produced_receipt_kind: expected groth16"
  );
});

test("options.accelerator is set to boundless", () => {
  const fulfillment: FulfillmentData = {
    seal: makeFakeSeal(TEST_SELECTOR),
    journal: makeFakeJournal(TEST_JOURNAL_FIELDS),
  };
  const resp = adaptFulfillmentToProverResponse(fulfillment);
  assert(
    resp.options.accelerator === "boundless",
    "options.accelerator: expected boundless, got " + resp.options.accelerator
  );
});

test("throws on journal shorter than 24 bytes", () => {
  const fulfillment: FulfillmentData = {
    seal: makeFakeSeal(TEST_SELECTOR),
    journal: new Uint8Array(20),
  };
  let threw = false;
  try {
    adaptFulfillmentToProverResponse(fulfillment);
  } catch {
    threw = true;
  }
  assert(threw, "expected an error for short journal");
});

test("throws on seal shorter than 260 bytes", () => {
  const fulfillment: FulfillmentData = {
    seal: new Uint8Array(100),
    journal: makeFakeJournal(TEST_JOURNAL_FIELDS),
  };
  let threw = false;
  try {
    adaptFulfillmentToProverResponse(fulfillment);
  } catch {
    threw = true;
  }
  assert(threw, "expected an error for short seal");
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log("\n=== Results: " + passed + " passed, " + failed + " failed ===\n");

if (failed > 0) {
  process.exit(1);
}
