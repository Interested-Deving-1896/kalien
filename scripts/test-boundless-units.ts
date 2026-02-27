/**
 * Unit tests for Boundless integration helpers.
 *
 * Usage: bun run scripts/test-boundless-units.ts
 */

import { encodeGuestEnvV1, encodeStdin } from "../worker/boundless/stdin";
import { adaptFulfillmentToProverResponse } from "../worker/boundless/adapter";
import { DEFAULT_BOUNDLESS_MAX_FRAMES } from "../worker/constants";
import type { FulfillmentData } from "../worker/boundless/types";
import {
  decodeClaimantFromJournal,
  JOURNAL_CLAIMANT_ENCODED_LEN,
  packJournalRaw,
} from "../shared/stellar/journal";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (!condition) {
    failed += 1;
    throw new Error(message);
  }
}

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  PASS: ${name}`);
  } catch (error) {
    console.error(`  FAIL: ${name}`);
    if (error instanceof Error) {
      console.error(`        ${error.message}`);
    }
  }
}

function decodeGuestEnvV1(encoded: Uint8Array): Uint8Array {
  let pos = 0;
  assert(encoded[pos++] === 0x01, "missing GuestEnv v1 marker");
  assert(encoded[pos++] === 0x81, "missing msgpack map(1)");
  assert(encoded[pos++] === 0xa5, "missing msgpack key header");
  assert(encoded[pos++] === 0x73, "missing 's'");
  assert(encoded[pos++] === 0x74, "missing 't'");
  assert(encoded[pos++] === 0x64, "missing 'd'");
  assert(encoded[pos++] === 0x69, "missing 'i'");
  assert(encoded[pos++] === 0x6e, "missing 'n'");

  const arrTag = encoded[pos++];
  let arrLen = 0;
  if ((arrTag & 0xf0) === 0x90) {
    arrLen = arrTag & 0x0f;
  } else if (arrTag === 0xdc) {
    arrLen = (encoded[pos++] << 8) | encoded[pos++];
  } else if (arrTag === 0xdd) {
    arrLen =
      (encoded[pos++] << 24) |
      (encoded[pos++] << 16) |
      (encoded[pos++] << 8) |
      encoded[pos++];
  } else {
    throw new Error(`unexpected msgpack array tag 0x${arrTag.toString(16)}`);
  }

  const result = new Uint8Array(arrLen);
  for (let i = 0; i < arrLen; i += 1) {
    const tag = encoded[pos++];
    if (tag < 0x80) {
      result[i] = tag;
    } else if (tag === 0xcc) {
      result[i] = encoded[pos++];
    } else {
      throw new Error(`unexpected msgpack element tag 0x${tag.toString(16)} at ${i}`);
    }
  }

  assert(pos === encoded.length, "unexpected trailing bytes after stdin array");
  return result;
}

function decodeStdinEnvelope(encoded: Uint8Array): {
  maxFrames: number;
  seedId: number;
  claimant: string;
  tapeLen: number;
  tape: Uint8Array;
} {
  const stdin = decodeGuestEnvV1(encoded);
  const view = new DataView(stdin.buffer, stdin.byteOffset, stdin.byteLength);

  const maxFrames = view.getUint32(0, true);
  const seedId = view.getUint32(4, true);
  const claimantBytes = stdin.slice(8, 8 + JOURNAL_CLAIMANT_ENCODED_LEN);
  const claimant = decodeClaimantFromJournal(claimantBytes);
  const tapeLenOffset = 8 + JOURNAL_CLAIMANT_ENCODED_LEN;
  const tapeLen = view.getUint32(tapeLenOffset, true);
  const tapeOffset = tapeLenOffset + 4;
  const tape = stdin.slice(tapeOffset, tapeOffset + tapeLen);

  return {
    maxFrames,
    seedId,
    claimant,
    tapeLen,
    tape,
  };
}

console.log("\n=== encodeGuestEnvV1 ===\n");

test("round-trips mixed low/high stdin bytes", () => {
  const input = new Uint8Array([0, 1, 2, 127, 128, 200, 255]);
  const encoded = encodeGuestEnvV1(input);
  const decoded = decodeGuestEnvV1(encoded);
  assert(decoded.length === input.length, "decoded length mismatch");
  for (let i = 0; i < input.length; i += 1) {
    assert(decoded[i] === input[i], `decoded byte mismatch at ${i}`);
  }
});

test("uses array16 for stdin >= 16 bytes", () => {
  const input = new Uint8Array(16);
  const encoded = encodeGuestEnvV1(input);
  assert(encoded[8] === 0xdc, "expected array16 tag (0xdc)");
});

console.log("\n=== encodeStdin ===\n");

const CLAIMANT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

test("encodes default max_frames and caller seed_id/claimant/tape", () => {
  const tape = new Uint8Array([0x11, 0x22, 0x33, 0x44, 0x55]);
  const encoded = encodeStdin(tape, {
    seedId: 4242,
    claimantAddress: CLAIMANT,
  });

  const decoded = decodeStdinEnvelope(encoded);
  assert(decoded.maxFrames === DEFAULT_BOUNDLESS_MAX_FRAMES, "default max_frames mismatch");
  assert(decoded.seedId === 4242, "seed_id mismatch");
  assert(decoded.claimant === CLAIMANT, "claimant mismatch");
  assert(decoded.tapeLen === tape.length, "tape_len mismatch");
  assert(decoded.tape.length === tape.length, "decoded tape length mismatch");
  for (let i = 0; i < tape.length; i += 1) {
    assert(decoded.tape[i] === tape[i], `decoded tape byte mismatch at ${i}`);
  }
});

test("encodes custom max_frames", () => {
  const tape = new Uint8Array([0xaa]);
  const encoded = encodeStdin(tape, {
    maxFrames: 777,
    seedId: 7,
    claimantAddress: CLAIMANT,
  });
  const decoded = decodeStdinEnvelope(encoded);
  assert(decoded.maxFrames === 777, "custom max_frames mismatch");
});

test("throws when claimant is not a valid Stellar address", () => {
  let threw = false;
  try {
    encodeStdin(new Uint8Array([1, 2, 3]), {
      seedId: 1,
      claimantAddress: "GSHORT",
    });
  } catch {
    threw = true;
  }
  assert(threw, "expected invalid claimant length to throw");
});

console.log("\n=== adaptFulfillmentToProverResponse ===\n");

function makeFakeSeal(selector: [number, number, number, number]): Uint8Array {
  const seal = new Uint8Array(260);
  seal.set(selector, 0);
  for (let i = 4; i < 260; i += 1) {
    seal[i] = (i - 4) & 0xff;
  }
  return seal;
}

function makeFakeJournal(fields: {
  seed_id: number;
  seed: number;
  frame_count: number;
  final_score: number;
  claimant: string;
}): Uint8Array {
  return packJournalRaw({
    seed_id: fields.seed_id >>> 0,
    seed: fields.seed >>> 0,
    frame_count: fields.frame_count >>> 0,
    final_score: fields.final_score >>> 0,
    claimant: fields.claimant,
  });
}

const TEST_SELECTOR: [number, number, number, number] = [0xde, 0xad, 0xbe, 0xef];
const TEST_JOURNAL = {
  seed_id: 778899,
  seed: 0x12345678,
  frame_count: 1000,
  final_score: 42,
  claimant: CLAIMANT,
};

test("parses 49-byte journal and strips selector from seal", () => {
  const fulfillment: FulfillmentData = {
    seal: makeFakeSeal(TEST_SELECTOR),
    journal: makeFakeJournal(TEST_JOURNAL),
    proverAddress: null,
    fulfillmentTxHash: null,
  };

  const response = adaptFulfillmentToProverResponse(fulfillment);
  const journal = response.result!.proof.journal;
  const groth16 = (response.result as any).proof.receipt.inner.Groth16;

  assert(journal.seed_id === TEST_JOURNAL.seed_id, "journal.seed_id mismatch");
  assert(journal.seed === TEST_JOURNAL.seed, "journal.seed mismatch");
  assert(journal.frame_count === TEST_JOURNAL.frame_count, "journal.frame_count mismatch");
  assert(journal.final_score === TEST_JOURNAL.final_score, "journal.final_score mismatch");
  assert(journal.claimant === TEST_JOURNAL.claimant, "journal.claimant mismatch");

  assert(groth16.seal.length === 256, "groth16.seal length mismatch");
  const firstWord = groth16.verifier_parameters[0] >>> 0;
  assert(firstWord === 0xefbeadde, "selector word mismatch");
});

test("throws on journal shorter than 49 bytes", () => {
  const fulfillment: FulfillmentData = {
    seal: makeFakeSeal(TEST_SELECTOR),
    journal: new Uint8Array(32),
    proverAddress: null,
    fulfillmentTxHash: null,
  };

  let threw = false;
  try {
    adaptFulfillmentToProverResponse(fulfillment);
  } catch {
    threw = true;
  }
  assert(threw, "expected short journal to throw");
});

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
if (failed > 0) {
  process.exit(1);
}
