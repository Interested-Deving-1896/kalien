/**
 * Unit tests for Boundless integration helpers.
 *
 * Usage: bun run scripts/test-boundless-units.ts
 */

import { encodeStdin, encodeGuestEnvV1 } from "../worker/boundless/stdin";
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
// Helper: decode the V1 msgpack envelope to extract the raw stdin bytes
// (inverse of encodeGuestEnvV1 — used only for test verification)
// ---------------------------------------------------------------------------

function decodeGuestEnvV1(encoded: Uint8Array): Uint8Array {
  let pos = 0;
  assert(encoded[pos++] === 0x01, "V1 version byte expected");
  assert(encoded[pos++] === 0x81, "fixmap(1) expected");
  assert(encoded[pos++] === 0xa5, "fixstr(5) expected");
  assert(encoded[pos++] === 0x73, "'s' expected"); // s
  assert(encoded[pos++] === 0x74, "'t' expected"); // t
  assert(encoded[pos++] === 0x64, "'d' expected"); // d
  assert(encoded[pos++] === 0x69, "'i' expected"); // i
  assert(encoded[pos++] === 0x6e, "'n' expected"); // n

  // Read array header
  let arrLen: number;
  const arrTag = encoded[pos++];
  if ((arrTag & 0xf0) === 0x90) {
    arrLen = arrTag & 0x0f; // fixarray
  } else if (arrTag === 0xdc) {
    arrLen = (encoded[pos++] << 8) | encoded[pos++]; // array16
  } else if (arrTag === 0xdd) {
    arrLen = (encoded[pos++] << 24) | (encoded[pos++] << 16) | (encoded[pos++] << 8) | encoded[pos++]; // array32
  } else {
    throw new Error("unexpected array tag: 0x" + arrTag.toString(16));
  }

  // Decode individual bytes
  const result = new Uint8Array(arrLen);
  for (let i = 0; i < arrLen; i++) {
    const b = encoded[pos++];
    if (b < 0x80) {
      result[i] = b; // positive fixint
    } else if (b === 0xcc) {
      result[i] = encoded[pos++]; // uint8
    } else {
      throw new Error("unexpected msgpack tag at element " + i + ": 0x" + b.toString(16));
    }
  }
  assert(pos === encoded.length, "unexpected trailing bytes: consumed " + pos + " of " + encoded.length);
  return result;
}

// ---------------------------------------------------------------------------
// encodeGuestEnvV1 tests (low-level msgpack encoding)
// ---------------------------------------------------------------------------

console.log("\n=== encodeGuestEnvV1 ===\n");

test("V1 envelope matches known production format for small input", () => {
  // Reproduce the production example:
  // stdin bytes: [0,0,64,31,0,0,0,0,77,165,88,66,15,97,191,136]
  const stdin = new Uint8Array([0, 0, 64, 31, 0, 0, 0, 0, 77, 165, 88, 66, 15, 97, 191, 136]);
  const result = encodeGuestEnvV1(stdin);
  const expected = "0181a5737464696edc00100000401f000000004dcca558420f61ccbfcc88";
  const resultHex = Array.from(result).map(b => b.toString(16).padStart(2, "0")).join("");
  assert(resultHex === expected, "mismatch:\n  got:      " + resultHex + "\n  expected: " + expected);
});

test("V1 envelope round-trips correctly for all-low bytes", () => {
  const stdin = new Uint8Array([0, 1, 2, 127]);
  const encoded = encodeGuestEnvV1(stdin);
  const decoded = decodeGuestEnvV1(encoded);
  assert(decoded.length === 4, "length mismatch");
  for (let i = 0; i < 4; i++) assert(decoded[i] === stdin[i], "byte " + i + " mismatch");
});

test("V1 envelope round-trips correctly for all-high bytes", () => {
  const stdin = new Uint8Array([128, 200, 255]);
  const encoded = encodeGuestEnvV1(stdin);
  const decoded = decodeGuestEnvV1(encoded);
  assert(decoded.length === 3, "length mismatch");
  for (let i = 0; i < 3; i++) assert(decoded[i] === stdin[i], "byte " + i + " mismatch");
});

test("V1 high bytes use 2-byte uint8 encoding (0xcc prefix)", () => {
  const stdin = new Uint8Array([200]); // >= 128
  const encoded = encodeGuestEnvV1(stdin);
  // header(8) + fixarray(1) for 1 element + 0xcc + 200 = 11 bytes
  assert(encoded.length === 8 + 1 + 2, "expected 11, got " + encoded.length);
});

test("V1 fixarray for stdin <= 15 bytes", () => {
  const stdin = new Uint8Array(15);
  const encoded = encodeGuestEnvV1(stdin);
  assert(encoded[8] === (0x90 | 15), "expected fixarray(15), got 0x" + encoded[8].toString(16));
});

test("V1 array16 for stdin 16-65535 bytes", () => {
  const stdin = new Uint8Array(16);
  const encoded = encodeGuestEnvV1(stdin);
  assert(encoded[8] === 0xdc, "expected array16 tag 0xdc, got 0x" + encoded[8].toString(16));
  const len = (encoded[9] << 8) | encoded[10];
  assert(len === 16, "expected array16 length 16, got " + len);
});

test("V1 empty stdin produces fixarray(0)", () => {
  const stdin = new Uint8Array(0);
  const encoded = encodeGuestEnvV1(stdin);
  assert(encoded[8] === 0x90, "expected fixarray(0) = 0x90, got 0x" + encoded[8].toString(16));
  assert(encoded.length === 9, "expected 9 bytes, got " + encoded.length);
});

// ---------------------------------------------------------------------------
// encodeStdin tests (full pipeline: tape → stdin → V1 msgpack)
// ---------------------------------------------------------------------------

console.log("\n=== encodeStdin ===\n");

test("encodeStdin output starts with V1 version byte (0x01)", () => {
  const tape = new Uint8Array([1, 2, 3, 4]);
  const result = encodeStdin(tape);
  assert(result[0] === 0x01, "byte 0: expected 0x01 (V1), got 0x" + result[0].toString(16));
});

test("encodeStdin output decodes to correct max_frames (default)", () => {
  const tape = new Uint8Array([0xAA]);
  const result = encodeStdin(tape);
  const stdin = decodeGuestEnvV1(result);
  const view = new DataView(stdin.buffer, stdin.byteOffset, stdin.byteLength);
  const frames = view.getUint32(0, true);
  assert(frames === DEFAULT_BOUNDLESS_MAX_FRAMES, "expected " + DEFAULT_BOUNDLESS_MAX_FRAMES + ", got " + frames);
});

test("encodeStdin output decodes to correct max_frames (custom)", () => {
  const tape = new Uint8Array([0xBB]);
  const result = encodeStdin(tape, 42);
  const stdin = decodeGuestEnvV1(result);
  const view = new DataView(stdin.buffer, stdin.byteOffset, stdin.byteLength);
  const frames = view.getUint32(0, true);
  assert(frames === 42, "expected 42, got " + frames);
});

test("encodeStdin output decodes to correct tape_len", () => {
  const tape = new Uint8Array([1, 2, 3, 4, 5]);
  const result = encodeStdin(tape);
  const stdin = decodeGuestEnvV1(result);
  const view = new DataView(stdin.buffer, stdin.byteOffset, stdin.byteLength);
  const tapeLen = view.getUint32(4, true);
  assert(tapeLen === 5, "expected 5, got " + tapeLen);
});

test("encodeStdin output preserves tape data with padding", () => {
  const tape = new Uint8Array([0x11, 0x22, 0x33]);
  const result = encodeStdin(tape);
  const stdin = decodeGuestEnvV1(result);
  assert(stdin[8] === 0x11, "byte 8: expected 0x11, got 0x" + stdin[8].toString(16));
  assert(stdin[9] === 0x22, "byte 9: expected 0x22, got 0x" + stdin[9].toString(16));
  assert(stdin[10] === 0x33, "byte 10: expected 0x33, got 0x" + stdin[10].toString(16));
  assert(stdin[11] === 0x00, "padding byte 11: expected 0x00, got 0x" + stdin[11].toString(16));
});

test("encodeStdin with empty tape decodes to 8-byte stdin (just headers)", () => {
  const result = encodeStdin(new Uint8Array([]));
  const stdin = decodeGuestEnvV1(result);
  assert(stdin.length === 8, "expected 8, got " + stdin.length);
  const view = new DataView(stdin.buffer, stdin.byteOffset, stdin.byteLength);
  assert(view.getUint32(4, true) === 0, "tape_len should be 0");
});

test("encodeStdin with large tape preserves all bytes", () => {
  const tape = new Uint8Array(1025);
  for (let i = 0; i < tape.length; i++) tape[i] = i & 0xFF;
  const result = encodeStdin(tape);
  const stdin = decodeGuestEnvV1(result);
  assert(stdin.length === 4 + 4 + 1028, "expected " + (4 + 4 + 1028) + ", got " + stdin.length);
  assert(stdin[8] === 0, "first tape byte wrong");
  assert(stdin[8 + 1024] === (1024 & 0xFF), "tape byte at offset 1024 wrong");
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
