import { DEFAULT_BOUNDLESS_MAX_FRAMES } from "../constants";
import type { ProofJournal, ProverGetJobResponse } from "../types";
import type { FulfillmentData } from "./types";
import { JOURNAL_LEN, unpackJournalRaw } from "../../shared/stellar/journal";

/**
 * Convert Boundless fulfillment data into the ProverGetJobResponse format
 * expected by the existing claim flow.
 *
 * The Boundless seal is 260 bytes: 4-byte selector + 256-byte Groth16 proof.
 * The journal is 64 bytes:
 *   - 7 x u32 LE (seed, seed_id, frame_count, final_score, final_rng_state, tape_checksum, rules_digest)
 *   - claimant bytes (1-byte kind + 32-byte id) + 3 reserved bytes
 */
export function adaptFulfillmentToProverResponse(
  fulfillment: FulfillmentData,
): ProverGetJobResponse {
  const journal = parseJournal(fulfillment.journal);
  const { seal, verifierParameters } = parseSeal(fulfillment.seal);

  return {
    job_id: "boundless",
    status: "succeeded",
    created_at_unix_s: Math.floor(Date.now() / 1000),
    finished_at_unix_s: Math.floor(Date.now() / 1000),
    tape_size_bytes: 0,
    options: {
      max_frames: DEFAULT_BOUNDLESS_MAX_FRAMES,
      receipt_kind: "groth16",
      segment_limit_po2: 0,
      proof_mode: "secure",
      verify_mode: "policy",
      accelerator: "boundless",
    },
    result: {
      proof: {
        journal,
        requested_receipt_kind: "groth16",
        produced_receipt_kind: "groth16",
        stats: {
          segments: 0,
          total_cycles: 0,
          user_cycles: 0,
          paging_cycles: 0,
          reserved_cycles: 0,
        },
        receipt: {
          inner: {
            Groth16: {
              seal: Array.from(seal),
              verifier_parameters: verifierParameters,
            },
          },
        },
      },
      elapsed_ms: 0,
    },
  };
}

/**
 * Parse the fixed-length journal into ProofJournal fields.
 */
function parseJournal(journalBytes: Uint8Array): ProofJournal {
  if (journalBytes.length !== JOURNAL_LEN) {
    throw new Error(`journal must be exactly ${JOURNAL_LEN} bytes (got ${journalBytes.length})`);
  }
  return unpackJournalRaw(journalBytes);
}

/**
 * Parse the Boundless seal (260 bytes) into the 256-byte raw seal
 * and 8-word verifier_parameters array.
 *
 * Boundless seal layout: [4-byte selector] [256-byte Groth16 proof]
 * The selector maps to verifier_parameters: first 4 bytes of the
 * 32-byte verifier_parameters, remaining 28 bytes are zero.
 */
function parseSeal(sealBytes: Uint8Array): {
  seal: number[];
  verifierParameters: number[];
} {
  if (sealBytes.length < 260) {
    throw new Error(`seal too short: ${sealBytes.length} bytes (expected >= 260)`);
  }

  const selector = sealBytes.slice(0, 4);
  const rawProof = sealBytes.slice(4, 260);

  // Reconstruct verifier_parameters: 8 x u32 LE
  // First word contains the selector bytes, rest are zero
  const paramsView = new DataView(new ArrayBuffer(32));
  paramsView.setUint8(0, selector[0]);
  paramsView.setUint8(1, selector[1]);
  paramsView.setUint8(2, selector[2]);
  paramsView.setUint8(3, selector[3]);

  const verifierParameters: number[] = [];
  for (let i = 0; i < 8; i++) {
    verifierParameters.push(paramsView.getUint32(i * 4, true));
  }

  return {
    seal: Array.from(rawProof),
    verifierParameters,
  };
}
