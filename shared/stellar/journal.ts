import { Address } from "@stellar/stellar-sdk/minimal";
import { parseClaimantStrKeyFromUserInput } from "./strkey";

export const JOURNAL_CLAIMANT_KIND_ACCOUNT = 0;
export const JOURNAL_CLAIMANT_KIND_CONTRACT = 1;

export const JOURNAL_CLAIMANT_ENCODED_LEN = 33;
export const JOURNAL_LEN = 49;

const JOURNAL_SEED_ID_OFFSET = 0;
const JOURNAL_SEED_OFFSET = 4;
const JOURNAL_FRAME_COUNT_OFFSET = 8;
const JOURNAL_FINAL_SCORE_OFFSET = 12;
const JOURNAL_CLAIMANT_OFFSET = 16;

export interface JournalFields {
  seed_id: number;
  seed: number;
  frame_count: number;
  final_score: number;
  claimant: string;
}

export function encodeClaimantForJournal(claimant: string): Uint8Array {
  const parsed = parseClaimantStrKeyFromUserInput(claimant);
  const body = Address.fromString(parsed.normalized).toBuffer();
  if (body.length !== 32) {
    throw new Error(`claimant body must be 32 bytes (got ${body.length})`);
  }

  const encoded = new Uint8Array(JOURNAL_CLAIMANT_ENCODED_LEN);
  encoded[0] =
    parsed.type === "account" ? JOURNAL_CLAIMANT_KIND_ACCOUNT : JOURNAL_CLAIMANT_KIND_CONTRACT;
  encoded.set(body, 1);
  return encoded;
}

export function decodeClaimantFromJournal(claimantBytes: Uint8Array): string {
  if (claimantBytes.length !== JOURNAL_CLAIMANT_ENCODED_LEN) {
    throw new Error(
      `journal claimant must be ${JOURNAL_CLAIMANT_ENCODED_LEN} bytes (got ${claimantBytes.length})`,
    );
  }

  const kind = claimantBytes[0];
  const body = claimantBytes.slice(1);
  const payload = body as unknown as Buffer;
  if (kind === JOURNAL_CLAIMANT_KIND_ACCOUNT) {
    return Address.account(payload).toString();
  }
  if (kind === JOURNAL_CLAIMANT_KIND_CONTRACT) {
    return Address.contract(payload).toString();
  }
  throw new Error(`journal claimant kind must be 0 or 1 (got ${kind})`);
}

export function packJournalRaw(journal: JournalFields): Uint8Array {
  const bytes = new Uint8Array(JOURNAL_LEN);
  const view = new DataView(bytes.buffer);
  view.setUint32(JOURNAL_SEED_ID_OFFSET, journal.seed_id >>> 0, true);
  view.setUint32(JOURNAL_SEED_OFFSET, journal.seed >>> 0, true);
  view.setUint32(JOURNAL_FRAME_COUNT_OFFSET, journal.frame_count >>> 0, true);
  view.setUint32(JOURNAL_FINAL_SCORE_OFFSET, journal.final_score >>> 0, true);
  bytes.set(encodeClaimantForJournal(journal.claimant), JOURNAL_CLAIMANT_OFFSET);
  return bytes;
}

export function unpackJournalRaw(bytes: Uint8Array): JournalFields {
  if (bytes.length !== JOURNAL_LEN) {
    throw new Error(`journal must be exactly ${JOURNAL_LEN} bytes (got ${bytes.length})`);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    seed_id: view.getUint32(JOURNAL_SEED_ID_OFFSET, true),
    seed: view.getUint32(JOURNAL_SEED_OFFSET, true),
    frame_count: view.getUint32(JOURNAL_FRAME_COUNT_OFFSET, true),
    final_score: view.getUint32(JOURNAL_FINAL_SCORE_OFFSET, true),
    claimant: decodeClaimantFromJournal(
      bytes.slice(JOURNAL_CLAIMANT_OFFSET, JOURNAL_CLAIMANT_OFFSET + JOURNAL_CLAIMANT_ENCODED_LEN),
    ),
  };
}
