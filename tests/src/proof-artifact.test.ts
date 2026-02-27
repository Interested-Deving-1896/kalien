import { describe, expect, it } from "bun:test";
import { extractGroth16SealFromArtifact } from "../../src/proof/artifact";
import { encodeClaimantForJournal, JOURNAL_LEN, packJournalRaw } from "../../shared/stellar/journal";

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

describe("extractGroth16SealFromArtifact", () => {
  it("builds a 260-byte stellar seal from Groth16 receipt payload", () => {
    const rawSeal = Array.from({ length: 256 }, (_, index) => index);
    const artifact = {
      prover_response: {
        result: {
          proof: {
            receipt: {
              inner: {
                Groth16: {
                  seal: rawSeal,
                  verifier_parameters: [0xa1b2c3d4, 0, 0, 0, 0, 0, 0, 0],
                },
              },
            },
          },
        },
      },
    };

    const seal = extractGroth16SealFromArtifact(artifact);
    expect(seal.length).toBe(260);
    expect(Array.from(seal.slice(0, 4))).toEqual([0xd4, 0xc3, 0xb2, 0xa1]);
    expect(Array.from(seal.slice(4, 12))).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(seal[259]).toBe(255);
  });

  it("throws on non-groth16 payloads", () => {
    const artifact = {
      prover_response: {
        result: {
          proof: {
            receipt: {
              inner: {
                Succinct: {},
              },
            },
          },
        },
      },
    };

    expect(() => extractGroth16SealFromArtifact(artifact)).toThrow(
      "proof artifact is missing receipt.inner.Groth16",
    );
  });
});

describe("packJournalRaw", () => {
  it("encodes journal fields as fixed-length little-endian payload", () => {
    const claimant = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
    const raw = packJournalRaw({
      seed_id: 12345,
      seed: 0xdeadbeef,
      frame_count: 3980,
      final_score: 90,
      claimant,
    });

    expect(raw.length).toBe(JOURNAL_LEN);
    expect(toHex(raw.slice(0, 16))).toBe(
      "39300000efbeadde8c0f00005a000000",
    );
    expect(raw.slice(16, 49)).toEqual(encodeClaimantForJournal(claimant));
  });
});
