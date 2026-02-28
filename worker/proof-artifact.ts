import { JOURNAL_LEN, packJournalRaw } from "../shared/stellar/journal";
import type {
  ProofArtifactV4,
  ProofResultSummary,
  ProverBackend,
  ProverGetJobResponse,
} from "./types";

export const STELLAR_GROTH16_SEAL_LEN = 260;
const SHA256_DIGEST_LEN = 32;

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as Record<string, unknown>;
}

function asByte(value: unknown, fieldName: string, index: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 255) {
    throw new Error(`${fieldName}[${index}] must be a byte`);
  }
  return value & 0xff;
}

function asU32(value: unknown, fieldName: string, index: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error(`${fieldName}[${index}] must be a u32`);
  }
  return value >>> 0;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function hexToBytes(hex: string, fieldName: string): Uint8Array {
  const normalized = hex.trim().toLowerCase();
  if (normalized.length === 0 || normalized.length % 2 !== 0 || /[^0-9a-f]/.test(normalized)) {
    throw new Error(`${fieldName} must be a valid even-length hex string`);
  }

  const bytes = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digestInput = Uint8Array.from(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", digestInput));
  return bytesToHex(digest);
}

export function extractStellarSealFromGroth16Receipt(receipt: unknown): Uint8Array {
  const receiptObj = asObject(receipt);
  const innerObj = receiptObj ? asObject(receiptObj.inner) : null;
  const groth16 = innerObj ? asObject(innerObj.Groth16) : null;
  if (!groth16) {
    throw new Error("proof receipt.inner.Groth16 is required");
  }

  const seal = groth16.seal;
  const verifierParameters = groth16.verifier_parameters;
  if (!Array.isArray(seal) || seal.length !== 256) {
    throw new Error("receipt.inner.Groth16.seal must be a 256-byte array");
  }
  if (!Array.isArray(verifierParameters) || verifierParameters.length !== 8) {
    throw new Error("receipt.inner.Groth16.verifier_parameters must be an 8-word array");
  }

  const rawSeal = Uint8Array.from(
    seal.map((value, index) => asByte(value, "receipt.inner.Groth16.seal", index)),
  );
  const params = verifierParameters.map((value, index) =>
    asU32(value, "receipt.inner.Groth16.verifier_parameters", index),
  );

  const paramsBytes = new Uint8Array(32);
  const paramsView = new DataView(paramsBytes.buffer);
  for (let index = 0; index < params.length; index += 1) {
    paramsView.setUint32(index * 4, params[index], true);
  }

  const selector = paramsBytes.slice(0, 4);
  const stellarSeal = new Uint8Array(STELLAR_GROTH16_SEAL_LEN);
  stellarSeal.set(selector, 0);
  stellarSeal.set(rawSeal, 4);
  return stellarSeal;
}

export async function buildProofArtifactV4(
  backend: ProverBackend,
  storedAt: string,
  seal: Uint8Array,
  journalRaw: Uint8Array,
): Promise<ProofArtifactV4> {
  if (seal.length !== STELLAR_GROTH16_SEAL_LEN) {
    throw new Error(`seal must be exactly ${STELLAR_GROTH16_SEAL_LEN} bytes (got ${seal.length})`);
  }
  if (journalRaw.length !== JOURNAL_LEN) {
    throw new Error(`journal must be exactly ${JOURNAL_LEN} bytes (got ${journalRaw.length})`);
  }
  const sealHex = bytesToHex(seal);
  const journalRawHex = bytesToHex(journalRaw);
  const journalDigestHex = await sha256Hex(journalRaw);
  return {
    version: "v4",
    stored_at: storedAt,
    backend,
    seal_hex: sealHex,
    journal_raw_hex: journalRawHex,
    journal_digest_hex: journalDigestHex,
    requested_receipt_kind: "groth16",
    produced_receipt_kind: "groth16",
  };
}

export async function buildProofArtifactV4FromProverResponse(
  backend: ProverBackend,
  response: ProverGetJobResponse,
  summary: ProofResultSummary,
  storedAt: string,
): Promise<ProofArtifactV4> {
  if (!response.result?.proof?.receipt) {
    throw new Error("prover response missing proof receipt");
  }
  const seal = extractStellarSealFromGroth16Receipt(response.result.proof.receipt);
  const journalRaw = packJournalRaw(summary.journal);
  return buildProofArtifactV4(backend, storedAt, seal, journalRaw);
}

export function parseProofArtifactV4(payload: unknown): ProofArtifactV4 {
  const artifact = asObject(payload);
  if (!artifact) {
    throw new Error("proof artifact payload must be an object");
  }

  const version = artifact.version;
  if (version !== "v4") {
    throw new Error(`unsupported proof artifact version: ${String(version)}`);
  }

  const storedAt = typeof artifact.stored_at === "string" ? artifact.stored_at : "";
  const backend = artifact.backend;
  const sealHex = typeof artifact.seal_hex === "string" ? artifact.seal_hex.toLowerCase() : "";
  const journalRawHex =
    typeof artifact.journal_raw_hex === "string" ? artifact.journal_raw_hex.toLowerCase() : "";
  const journalDigestHex =
    typeof artifact.journal_digest_hex === "string"
      ? artifact.journal_digest_hex.toLowerCase()
      : "";
  const requestedReceiptKind = artifact.requested_receipt_kind;
  const producedReceiptKind = artifact.produced_receipt_kind;

  if (!storedAt) {
    throw new Error("proof artifact is missing stored_at");
  }
  if (backend !== "boundless" && backend !== "vast") {
    throw new Error("proof artifact backend must be boundless or vast");
  }
  if (!isExactHexByteLength(sealHex, STELLAR_GROTH16_SEAL_LEN)) {
    throw new Error(`proof artifact seal_hex must be ${STELLAR_GROTH16_SEAL_LEN} bytes hex`);
  }
  if (!isExactHexByteLength(journalRawHex, JOURNAL_LEN)) {
    throw new Error(`proof artifact journal_raw_hex must be ${JOURNAL_LEN} bytes hex`);
  }
  if (!isExactHexByteLength(journalDigestHex, SHA256_DIGEST_LEN)) {
    throw new Error(`proof artifact journal_digest_hex must be ${SHA256_DIGEST_LEN} bytes hex`);
  }
  if (requestedReceiptKind !== "groth16" || producedReceiptKind !== "groth16") {
    throw new Error("proof artifact receipt kinds must both be groth16");
  }

  return {
    version: "v4",
    stored_at: storedAt,
    backend,
    seal_hex: sealHex,
    journal_raw_hex: journalRawHex,
    journal_digest_hex: journalDigestHex,
    requested_receipt_kind: "groth16",
    produced_receipt_kind: "groth16",
  };
}

function isExactHexByteLength(value: string, byteLength: number): boolean {
  return value.length === byteLength * 2 && /^[0-9a-f]+$/.test(value);
}
