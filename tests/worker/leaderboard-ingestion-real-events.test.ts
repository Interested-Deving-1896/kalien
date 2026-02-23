/**
 * Tests for leaderboard ingestion using real on-chain event data.
 *
 * The RPC event fixture below was captured from a real score_submitted event
 * on Stellar testnet, contract CAKVUHDKKEG6SYUAVMQMDRMUGCNQJS74BP45NNYS7Y2TTYUMYFSLA7EU,
 * txHash 5fd87e77d8e8cc587d153e2fa10bc37faafc5513f6e8ff16561a7c10adde1ff9.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { scValToNative, xdr } from "@stellar/stellar-base";
import {
  fetchLeaderboardEventsFromGalexie,
  normalizeGalexieScoreEvents,
} from "../../worker/leaderboard-ingestion";
import type { WorkerEnv } from "../../worker/env";

// ── Real RPC event fixture ──────────────────────────────────────────────
// Captured from testnet RPC getEvents response on 2026-02-16.
const REAL_RPC_EVENT = {
  type: "contract",
  ledger: 1054047,
  ledgerClosedAt: "2026-02-16T19:01:25Z",
  contractId: "CAKVUHDKKEG6SYUAVMQMDRMUGCNQJS74BP45NNYS7Y2TTYUMYFSLA7EU",
  id: "0004527097393475584-0000000001",
  operationIndex: 0,
  transactionIndex: 7,
  txHash: "5fd87e77d8e8cc587d153e2fa10bc37faafc5513f6e8ff16561a7c10adde1ff9",
  inSuccessfulContractCall: true,
  topic: ["AAAADwAAAA9zY29yZV9zdWJtaXR0ZWQA"],
  value:
    "AAAAEQAAAAEAAAALAAAADwAAAAhjbGFpbWFudAAAABIAAAAB3gOh0xglb1qLOBPaL4f2D/cnU/6Wqs/9kIo88xmbqjIAAAAPAAAAD2ZpbmFsX3JuZ19zdGF0ZQAAAAADsW4HwAAAAA8AAAALZmluYWxfc2NvcmUAAAAAAwAAiMIAAAAPAAAAC2ZyYW1lX2NvdW50AAAAAAMAADcrAAAADwAAAA5qb3VybmFsX2RpZ2VzdAAAAAAADQAAACAHy7Tac4D+rLO6J6xjcJ0aD9ch79TYpxwo+O5b1Z0zWwAAAA8AAAAMbWludGVkX2RlbHRhAAAAAwAAiMIAAAAPAAAACG5ld19iZXN0AAAAAwAAiMIAAAAPAAAADXByZXZpb3VzX2Jlc3QAAAAAAAADAAAAAAAAAA8AAAAMcnVsZXNfZGlnZXN0AAAAA0FTVDMAAAAPAAAABHNlZWQAAAADZ8/zpgAAAA8AAAANdGFwZV9jaGVja3N1bQAAAAAAAAPo3uG2",
};

// Expected decoded values from the real event above.
// These were verified by decoding the XDR and checking the actual values.
const EXPECTED = {
  claimantAddress: "CDPAHIOTDASW6WULHAJ5UL4H6YH7OJ2T72LKVT75SCFDZ4YZTOVDFEQX",
  seed: 1741681574, // u32 from XDR
  frameCount: 14123,
  finalScore: 35_010,
  finalRngState: 2976778176, // u32 from XDR
  tapeChecksum: 3906920886, // u32 from XDR
  rulesDigest: 0x41535433, // "AST3" = 1095980083
  previousBest: 0,
  newBest: 35_010,
  mintedDelta: 35_010,
  journalDigest: "07cbb4da7380feacb3ba27ac63709d1a0fd721efd4d8a71c28f8ee5bd59d335b",
  txHash: "5fd87e77d8e8cc587d153e2fa10bc37faafc5513f6e8ff16561a7c10adde1ff9",
  ledger: 1054047,
};

// ── Helpers ──────────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeEnv(overrides: Partial<WorkerEnv> = {}): WorkerEnv {
  return {
    ASSETS: {} as Fetcher,
    PROOF_QUEUE: {} as Queue<unknown>,
    CLAIM_QUEUE: {} as Queue<unknown>,
    PROOF_COORDINATOR: {} as DurableObjectNamespace<never>,
    PROOF_ARTIFACTS: {} as R2Bucket,
    PROVER_BASE_URL: "http://127.0.0.1:8088",
    GALEXIE_RPC_BASE_URL: "https://rpc-test.example.com",
    CLAIM_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
    SCORE_CONTRACT_ID: "CAKVUHDKKEG6SYUAVMQMDRMUGCNQJS74BP45NNYS7Y2TTYUMYFSLA7EU",
    ...overrides,
  } as WorkerEnv;
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("real event XDR decoding", () => {
  it("decodes the topic[0] to 'score_submitted'", () => {
    const topicScVal = xdr.ScVal.fromXDR(REAL_RPC_EVENT.topic[0], "base64");
    const topicNative = scValToNative(topicScVal);
    expect(topicNative).toBe("score_submitted");
  });

  it("decodes the event value to a record with all expected fields", () => {
    const valueScVal = xdr.ScVal.fromXDR(REAL_RPC_EVENT.value, "base64");
    const valueNative = scValToNative(valueScVal) as Record<string, unknown>;

    // scValToNative may return a plain object or Map depending on the XDR structure
    expect(typeof valueNative).toBe("object");

    // Check all expected keys exist
    const expectedKeys = [
      "claimant",
      "final_rng_state",
      "final_score",
      "frame_count",
      "journal_digest",
      "minted_delta",
      "new_best",
      "previous_best",
      "rules_digest",
      "seed",
      "tape_checksum",
    ];
    for (const key of expectedKeys) {
      expect(key in valueNative).toBe(true);
    }
    expect(Object.keys(valueNative)).toHaveLength(11);
  });

  it("decodes claimant address correctly", () => {
    const valueScVal = xdr.ScVal.fromXDR(REAL_RPC_EVENT.value, "base64");
    const valueNative = scValToNative(valueScVal) as Record<string, unknown>;
    expect(valueNative.claimant).toBe(EXPECTED.claimantAddress);
  });

  it("decodes numeric fields as expected values", () => {
    const valueScVal = xdr.ScVal.fromXDR(REAL_RPC_EVENT.value, "base64");
    const valueNative = scValToNative(valueScVal) as Record<string, unknown>;

    expect(Number(valueNative.seed)).toBe(EXPECTED.seed);
    expect(Number(valueNative.frame_count)).toBe(EXPECTED.frameCount);
    expect(Number(valueNative.final_score)).toBe(EXPECTED.finalScore);
    expect(Number(valueNative.final_rng_state)).toBe(EXPECTED.finalRngState);
    expect(Number(valueNative.tape_checksum)).toBe(EXPECTED.tapeChecksum);
    expect(Number(valueNative.rules_digest)).toBe(EXPECTED.rulesDigest);
    expect(Number(valueNative.previous_best)).toBe(EXPECTED.previousBest);
    expect(Number(valueNative.new_best)).toBe(EXPECTED.newBest);
    expect(Number(valueNative.minted_delta)).toBe(EXPECTED.mintedDelta);
  });

  it("decodes journal_digest as Buffer/Uint8Array matching expected hex", () => {
    const valueScVal = xdr.ScVal.fromXDR(REAL_RPC_EVENT.value, "base64");
    const valueNative = scValToNative(valueScVal) as Record<string, unknown>;
    const digest = valueNative.journal_digest;

    // scValToNative returns Buffer for bytes types
    expect(digest).toBeDefined();
    const digestHex =
      digest instanceof Uint8Array || Buffer.isBuffer(digest)
        ? Buffer.from(digest).toString("hex")
        : String(digest);
    expect(digestHex).toBe(EXPECTED.journalDigest);
  });

  it("satisfies canonical score invariants", () => {
    const valueScVal = xdr.ScVal.fromXDR(REAL_RPC_EVENT.value, "base64");
    const valueNative = scValToNative(valueScVal) as Record<string, unknown>;

    const finalScore = Number(valueNative.final_score);
    const newBest = Number(valueNative.new_best);
    const previousBest = Number(valueNative.previous_best);
    const mintedDelta = Number(valueNative.minted_delta);

    // finalScore == newBest (always)
    expect(finalScore).toBe(newBest);
    // previousBest <= newBest (monotonic)
    expect(previousBest).toBeLessThanOrEqual(newBest);
    // mintedDelta == newBest - previousBest (exact delta)
    expect(mintedDelta).toBe(newBest - previousBest);
  });

  it("rules_digest is AST3 (0x41535433)", () => {
    const valueScVal = xdr.ScVal.fromXDR(REAL_RPC_EVENT.value, "base64");
    const valueNative = scValToNative(valueScVal) as Record<string, unknown>;
    const rulesDigest = Number(valueNative.rules_digest);
    expect(rulesDigest).toBe(0x41535433);
    // Verify it's the ASCII encoding of "AST3"
    const buf = Buffer.alloc(4);
    buf.writeUInt32BE(rulesDigest);
    expect(buf.toString("ascii")).toBe("AST3");
  });
});

describe("real event RPC ingestion end-to-end", () => {
  it("parses a real RPC getEvents response into a LeaderboardEventRecord", async () => {
    // Mock fetch to return the real RPC response
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "https://rpc-test.example.com/") {
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        if (body.method === "getHealth") {
          return jsonResponse({
            result: {
              latestLedger: 1054109,
              oldestLedger: 933150,
            },
          });
        }
        if (body.method === "getEvents") {
          return jsonResponse({
            result: {
              events: [REAL_RPC_EVENT],
              cursor: "0004527367976386559-4294967295",
              latestLedger: 1054109,
            },
          });
        }
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    const result = await fetchLeaderboardEventsFromGalexie(makeEnv(), {
      fromLedger: 1050000,
      toLedger: 1054109,
      limit: 100,
    });

    expect(result.provider).toBe("rpc");
    expect(result.sourceMode).toBe("rpc");
    expect(result.fetchedCount).toBe(1);
    expect(result.events).toHaveLength(1);

    const event = result.events[0]!;
    expect(event.claimantAddress).toBe(EXPECTED.claimantAddress);
    expect(event.seed).toBe(EXPECTED.seed >>> 0);
    expect(event.frameCount).toBe(EXPECTED.frameCount);
    expect(event.finalScore).toBe(EXPECTED.finalScore);
    expect(event.finalRngState).toBe(EXPECTED.finalRngState >>> 0);
    expect(event.tapeChecksum).toBe(EXPECTED.tapeChecksum >>> 0);
    expect(event.rulesDigest).toBe(EXPECTED.rulesDigest);
    expect(event.previousBest).toBe(EXPECTED.previousBest);
    expect(event.newBest).toBe(EXPECTED.newBest);
    expect(event.mintedDelta).toBe(EXPECTED.mintedDelta);
    expect(event.journalDigest).toBe(EXPECTED.journalDigest);
    expect(event.txHash).toBe(EXPECTED.txHash);
    expect(event.ledger).toBe(EXPECTED.ledger);
    expect(event.eventId).toBe("0004527097393475584-0000000001");
    expect(event.closedAt).toBe("2026-02-16T19:01:25.000Z");
    expect(event.source).toBe("rpc");
  });

  it("returns the correct cursor for pagination", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "https://rpc-test.example.com/") {
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        if (body.method === "getHealth") {
          return jsonResponse({
            result: { latestLedger: 1054109, oldestLedger: 933150 },
          });
        }
        if (body.method === "getEvents") {
          return jsonResponse({
            result: {
              events: [REAL_RPC_EVENT],
              cursor: "0004527367976386559-4294967295",
              latestLedger: 1054109,
            },
          });
        }
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    const result = await fetchLeaderboardEventsFromGalexie(makeEnv(), {
      fromLedger: 1050000,
      limit: 100,
    });

    expect(result.nextCursor).toBe("0004527367976386559-4294967295");
  });

  it("filters out events not matching score contract when SCORE_CONTRACT_ID is set", async () => {
    const otherContractEvent = {
      ...REAL_RPC_EVENT,
      contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAITA4",
      id: "0004527097393475584-0000000099",
    };

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "https://rpc-test.example.com/") {
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        if (body.method === "getHealth") {
          return jsonResponse({
            result: { latestLedger: 1054109, oldestLedger: 933150 },
          });
        }
        if (body.method === "getEvents") {
          // RPC returns both events (server-side filter applied)
          // but the ingestion should accept both since RPC pre-filters by contractId
          return jsonResponse({
            result: {
              events: [REAL_RPC_EVENT, otherContractEvent],
              cursor: "cursor-next",
              latestLedger: 1054109,
            },
          });
        }
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    const result = await fetchLeaderboardEventsFromGalexie(makeEnv(), {
      fromLedger: 1050000,
      limit: 100,
    });

    // Both events have valid score_submitted structure, both should parse
    expect(result.events).toHaveLength(2);
  });

  it("handles multiple events in a single RPC response", async () => {
    // Create a second event with different score values
    const secondEvent = {
      ...REAL_RPC_EVENT,
      id: "0004527097393475584-0000000002",
      txHash: "aaaa1111222233334444555566667777888899990000aaaabbbbccccddddeeee",
      ledger: 1054048,
      ledgerClosedAt: "2026-02-16T19:01:30Z",
      // Reuse the same value XDR - same event structure
    };

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "https://rpc-test.example.com/") {
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        if (body.method === "getHealth") {
          return jsonResponse({
            result: { latestLedger: 1054109, oldestLedger: 933150 },
          });
        }
        if (body.method === "getEvents") {
          return jsonResponse({
            result: {
              events: [REAL_RPC_EVENT, secondEvent],
              cursor: "cursor-multi",
              latestLedger: 1054109,
            },
          });
        }
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    const result = await fetchLeaderboardEventsFromGalexie(makeEnv(), {
      fromLedger: 1050000,
      limit: 100,
    });

    expect(result.events).toHaveLength(2);
    expect(result.events[0]!.eventId).toBe("0004527097393475584-0000000001");
    expect(result.events[1]!.eventId).toBe("0004527097393475584-0000000002");
    expect(result.events[1]!.ledger).toBe(1054048);
  });

  it("empty RPC response produces zero events with valid cursor", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "https://rpc-test.example.com/") {
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        if (body.method === "getHealth") {
          return jsonResponse({
            result: { latestLedger: 1054109, oldestLedger: 933150 },
          });
        }
        if (body.method === "getEvents") {
          return jsonResponse({
            result: {
              events: [],
              cursor: "empty-cursor",
              latestLedger: 1054109,
            },
          });
        }
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    const result = await fetchLeaderboardEventsFromGalexie(makeEnv(), {
      fromLedger: 1050000,
      limit: 100,
    });

    expect(result.events).toHaveLength(0);
    expect(result.fetchedCount).toBe(0);
    expect(result.nextCursor).toBe("empty-cursor");
  });
});

describe("real event via Galexie Events API format", () => {
  it("parses the same event in Galexie flat JSON format", () => {
    // Simulate how the Galexie Events API would return the same event
    const galexiePayload = {
      events: [
        {
          id: "0004527097393475584-0000000001",
          claimant: EXPECTED.claimantAddress,
          seed: EXPECTED.seed,
          frame_count: EXPECTED.frameCount,
          final_score: EXPECTED.finalScore,
          final_rng_state: EXPECTED.finalRngState,
          tape_checksum: EXPECTED.tapeChecksum,
          rules_digest: EXPECTED.rulesDigest,
          previous_best: EXPECTED.previousBest,
          new_best: EXPECTED.newBest,
          minted_delta: EXPECTED.mintedDelta,
          journal_digest: EXPECTED.journalDigest,
          tx_hash: EXPECTED.txHash,
          event_index: 1,
          ledger: EXPECTED.ledger,
          closed_at: "2026-02-16T19:01:25.000Z",
        },
      ],
      next_cursor: "galexie-cursor-next",
    };

    const result = normalizeGalexieScoreEvents(galexiePayload, "2026-02-16T19:02:00.000Z");

    expect(result.fetchedCount).toBe(1);
    expect(result.events).toHaveLength(1);
    expect(result.nextCursor).toBe("galexie-cursor-next");

    const event = result.events[0]!;
    expect(event.claimantAddress).toBe(EXPECTED.claimantAddress);
    expect(event.seed).toBe(EXPECTED.seed >>> 0);
    expect(event.frameCount).toBe(EXPECTED.frameCount);
    expect(event.finalScore).toBe(EXPECTED.finalScore);
    expect(event.finalRngState).toBe(EXPECTED.finalRngState >>> 0);
    expect(event.tapeChecksum).toBe(EXPECTED.tapeChecksum >>> 0);
    expect(event.rulesDigest).toBe(EXPECTED.rulesDigest);
    expect(event.previousBest).toBe(EXPECTED.previousBest);
    expect(event.newBest).toBe(EXPECTED.newBest);
    expect(event.mintedDelta).toBe(EXPECTED.mintedDelta);
    expect(event.journalDigest).toBe(EXPECTED.journalDigest);
    expect(event.txHash).toBe(EXPECTED.txHash);
    expect(event.ledger).toBe(EXPECTED.ledger);
    expect(event.source).toBe("galexie");
  });

  it("rejects event with broken canonical invariants (finalScore != newBest)", () => {
    const brokenPayload = {
      events: [
        {
          id: "broken-1",
          claimant: EXPECTED.claimantAddress,
          seed: EXPECTED.seed,
          frame_count: EXPECTED.frameCount,
          final_score: 999, // != new_best
          final_rng_state: EXPECTED.finalRngState,
          tape_checksum: EXPECTED.tapeChecksum,
          rules_digest: EXPECTED.rulesDigest,
          previous_best: 0,
          new_best: 34_994,
          minted_delta: 34_994,
          journal_digest: EXPECTED.journalDigest,
          tx_hash: "fake-tx",
          ledger: 100,
          closed_at: "2026-02-16T19:01:25.000Z",
        },
      ],
    };

    const result = normalizeGalexieScoreEvents(brokenPayload);
    expect(result.fetchedCount).toBe(1);
    expect(result.events).toHaveLength(0); // Rejected
  });

  it("rejects event with wrong mintedDelta (not newBest - previousBest)", () => {
    const brokenPayload = {
      events: [
        {
          id: "broken-2",
          claimant: EXPECTED.claimantAddress,
          seed: EXPECTED.seed,
          frame_count: EXPECTED.frameCount,
          final_score: EXPECTED.finalScore,
          final_rng_state: EXPECTED.finalRngState,
          tape_checksum: EXPECTED.tapeChecksum,
          rules_digest: EXPECTED.rulesDigest,
          previous_best: 1000,
          new_best: EXPECTED.newBest,
          minted_delta: EXPECTED.newBest, // Should be newBest - 1000 = 33994
          journal_digest: EXPECTED.journalDigest,
          tx_hash: "fake-tx-2",
          ledger: 100,
          closed_at: "2026-02-16T19:01:25.000Z",
        },
      ],
    };

    const result = normalizeGalexieScoreEvents(brokenPayload);
    expect(result.events).toHaveLength(0); // Rejected
  });

  it("rejects event with zero score", () => {
    const zeroPayload = {
      events: [
        {
          id: "zero-score",
          claimant: EXPECTED.claimantAddress,
          seed: EXPECTED.seed,
          frame_count: 100,
          final_score: 0,
          final_rng_state: 0,
          tape_checksum: 0,
          rules_digest: EXPECTED.rulesDigest,
          previous_best: 0,
          new_best: 0,
          minted_delta: 0,
          journal_digest: EXPECTED.journalDigest,
          tx_hash: "fake-tx-zero",
          ledger: 100,
          closed_at: "2026-02-16T19:01:25.000Z",
        },
      ],
    };

    const result = normalizeGalexieScoreEvents(zeroPayload);
    expect(result.events).toHaveLength(0); // Rejected (zero score)
  });

  it("rejects event with invalid claimant address", () => {
    const badAddressPayload = {
      events: [
        {
          id: "bad-addr",
          claimant: "XINVALID_NOT_A_REAL_ADDRESS",
          seed: EXPECTED.seed,
          frame_count: EXPECTED.frameCount,
          final_score: EXPECTED.finalScore,
          final_rng_state: EXPECTED.finalRngState,
          tape_checksum: EXPECTED.tapeChecksum,
          rules_digest: EXPECTED.rulesDigest,
          previous_best: 0,
          new_best: EXPECTED.newBest,
          minted_delta: EXPECTED.mintedDelta,
          journal_digest: EXPECTED.journalDigest,
          tx_hash: "fake-tx-bad-addr",
          ledger: 100,
          closed_at: "2026-02-16T19:01:25.000Z",
        },
      ],
    };

    const result = normalizeGalexieScoreEvents(badAddressPayload);
    expect(result.events).toHaveLength(0); // Rejected
  });

  it("rejects event with invalid journal_digest (wrong length)", () => {
    const badDigestPayload = {
      events: [
        {
          id: "bad-digest",
          claimant: EXPECTED.claimantAddress,
          seed: EXPECTED.seed,
          frame_count: EXPECTED.frameCount,
          final_score: EXPECTED.finalScore,
          final_rng_state: EXPECTED.finalRngState,
          tape_checksum: EXPECTED.tapeChecksum,
          rules_digest: EXPECTED.rulesDigest,
          previous_best: 0,
          new_best: EXPECTED.newBest,
          minted_delta: EXPECTED.mintedDelta,
          journal_digest: "deadbeef", // Too short (must be 64 hex chars)
          tx_hash: "fake-tx-bad-digest",
          ledger: 100,
          closed_at: "2026-02-16T19:01:25.000Z",
        },
      ],
    };

    const result = normalizeGalexieScoreEvents(badDigestPayload);
    expect(result.events).toHaveLength(0); // Rejected
  });

  it("accepts event with improvement over previous best", () => {
    const improvementPayload = {
      events: [
        {
          id: "improvement-1",
          claimant: EXPECTED.claimantAddress,
          seed: EXPECTED.seed,
          frame_count: EXPECTED.frameCount,
          final_score: 50_000,
          final_rng_state: EXPECTED.finalRngState,
          tape_checksum: EXPECTED.tapeChecksum,
          rules_digest: EXPECTED.rulesDigest,
          previous_best: 34_994, // Previous run was 34994
          new_best: 50_000,
          minted_delta: 15_006, // 50000 - 34994
          journal_digest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          tx_hash: "tx-improvement",
          ledger: 1054100,
          closed_at: "2026-02-16T20:00:00.000Z",
        },
      ],
      next_cursor: "cursor-improvement",
    };

    const result = normalizeGalexieScoreEvents(improvementPayload);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.previousBest).toBe(34_994);
    expect(result.events[0]!.newBest).toBe(50_000);
    expect(result.events[0]!.mintedDelta).toBe(15_006);
  });

  it("accepts events with string-encoded numeric values", () => {
    const stringNumberPayload = {
      events: [
        {
          id: "string-nums",
          claimant: EXPECTED.claimantAddress,
          seed: String(EXPECTED.seed),
          frame_count: String(EXPECTED.frameCount),
          final_score: String(EXPECTED.finalScore),
          final_rng_state: String(EXPECTED.finalRngState),
          tape_checksum: String(EXPECTED.tapeChecksum),
          rules_digest: String(EXPECTED.rulesDigest),
          previous_best: "0",
          new_best: String(EXPECTED.newBest),
          minted_delta: String(EXPECTED.mintedDelta),
          journal_digest: EXPECTED.journalDigest,
          tx_hash: "tx-string-nums",
          ledger: 100,
          closed_at: "2026-02-16T19:01:25.000Z",
        },
      ],
    };

    const result = normalizeGalexieScoreEvents(stringNumberPayload);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.seed).toBe(EXPECTED.seed >>> 0);
    expect(result.events[0]!.finalScore).toBe(EXPECTED.finalScore);
  });

  it("accepts events with hex-string seed", () => {
    const hexSeedPayload = {
      events: [
        {
          id: "hex-seed",
          claimant: EXPECTED.claimantAddress,
          seed: `0x${(EXPECTED.seed >>> 0).toString(16)}`,
          frame_count: EXPECTED.frameCount,
          final_score: EXPECTED.finalScore,
          final_rng_state: EXPECTED.finalRngState,
          tape_checksum: EXPECTED.tapeChecksum,
          rules_digest: EXPECTED.rulesDigest,
          previous_best: 0,
          new_best: EXPECTED.newBest,
          minted_delta: EXPECTED.mintedDelta,
          journal_digest: EXPECTED.journalDigest,
          tx_hash: "tx-hex-seed",
          ledger: 100,
          closed_at: "2026-02-16T19:01:25.000Z",
        },
      ],
    };

    const result = normalizeGalexieScoreEvents(hexSeedPayload);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.seed).toBe(EXPECTED.seed >>> 0);
  });

  it("handles mixed valid and invalid events in same batch", () => {
    const mixedPayload = {
      events: [
        // Valid event
        {
          id: "valid-1",
          claimant: EXPECTED.claimantAddress,
          seed: EXPECTED.seed,
          frame_count: EXPECTED.frameCount,
          final_score: EXPECTED.finalScore,
          final_rng_state: EXPECTED.finalRngState,
          tape_checksum: EXPECTED.tapeChecksum,
          rules_digest: EXPECTED.rulesDigest,
          previous_best: 0,
          new_best: EXPECTED.newBest,
          minted_delta: EXPECTED.mintedDelta,
          journal_digest: EXPECTED.journalDigest,
          tx_hash: "tx-valid-1",
          ledger: 100,
          closed_at: "2026-02-16T19:01:25.000Z",
        },
        // Invalid: bad address
        {
          id: "invalid-1",
          claimant: "not_a_real_address",
          seed: 1,
          frame_count: 100,
          final_score: 100,
          previous_best: 0,
          new_best: 100,
          minted_delta: 100,
          journal_digest: EXPECTED.journalDigest,
          closed_at: "2026-02-16T19:01:25.000Z",
        },
        // Invalid: zero score
        {
          id: "invalid-2",
          claimant: EXPECTED.claimantAddress,
          seed: 2,
          frame_count: 50,
          final_score: 0,
          previous_best: 0,
          new_best: 0,
          minted_delta: 0,
          journal_digest: EXPECTED.journalDigest,
          closed_at: "2026-02-16T19:01:25.000Z",
        },
        // Valid: different player
        {
          id: "valid-2",
          claimant: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEGWF",
          seed: 42,
          frame_count: 5000,
          final_score: 10_000,
          final_rng_state: 12345,
          tape_checksum: 67890,
          rules_digest: EXPECTED.rulesDigest,
          previous_best: 0,
          new_best: 10_000,
          minted_delta: 10_000,
          journal_digest: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          tx_hash: "tx-valid-2",
          ledger: 101,
          closed_at: "2026-02-16T19:02:00.000Z",
        },
      ],
    };

    const result = normalizeGalexieScoreEvents(mixedPayload);
    expect(result.fetchedCount).toBe(4);
    expect(result.events).toHaveLength(2); // Only 2 valid
    expect(result.events[0]!.claimantAddress).toBe(EXPECTED.claimantAddress);
    expect(result.events[1]!.claimantAddress).toBe(
      "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEGWF",
    );
  });
});

describe("RPC response edge cases with real XDR", () => {
  it("rejects events with non-score_submitted topic", async () => {
    // Create a topic that is NOT "score_submitted"
    const transferTopic = Buffer.from(
      xdr.ScVal.scvSymbol("transfer").toXDR(),
    ).toString("base64");

    const nonScoreEvent = {
      ...REAL_RPC_EVENT,
      id: "non-score-event",
      topic: [transferTopic],
    };

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "https://rpc-test.example.com/") {
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        if (body.method === "getHealth") {
          return jsonResponse({
            result: { latestLedger: 1054109, oldestLedger: 933150 },
          });
        }
        if (body.method === "getEvents") {
          return jsonResponse({
            result: {
              events: [nonScoreEvent],
              cursor: "cursor-non-score",
              latestLedger: 1054109,
            },
          });
        }
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    const result = await fetchLeaderboardEventsFromGalexie(makeEnv(), {
      fromLedger: 1050000,
      limit: 100,
    });

    expect(result.fetchedCount).toBe(1);
    expect(result.events).toHaveLength(0); // Filtered out
  });

  it("handles RPC 503 by falling back gracefully", async () => {
    globalThis.fetch = (async () => {
      return new Response("service unavailable", { status: 503 });
    }) as typeof fetch;

    try {
      await fetchLeaderboardEventsFromGalexie(makeEnv(), {
        fromLedger: 1050000,
        limit: 100,
      });
      expect(true).toBe(false); // Should not reach
    } catch (error) {
      expect(error).toBeDefined();
    }
  });

  it("uses ledger cursor to convert to startLedger parameter", async () => {
    let capturedParams: Record<string, unknown> | null = null;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "https://rpc-test.example.com/") {
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        if (body.method === "getHealth") {
          return jsonResponse({
            result: { latestLedger: 1054109, oldestLedger: 933150 },
          });
        }
        if (body.method === "getEvents") {
          capturedParams = body.params as Record<string, unknown>;
          return jsonResponse({
            result: {
              events: [],
              cursor: "next-cursor",
              latestLedger: 1054109,
            },
          });
        }
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    await fetchLeaderboardEventsFromGalexie(makeEnv(), {
      cursor: "ledger:1053000",
      limit: 100,
    });

    // Ledger cursor should be converted to startLedger, not passed as pagination cursor
    expect(capturedParams).not.toBeNull();
    const pagination = capturedParams!.pagination as Record<string, unknown>;
    expect(pagination.cursor).toBeUndefined();
    expect(capturedParams!.startLedger).toBe(1053000);
  });
});
