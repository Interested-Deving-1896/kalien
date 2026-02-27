interface ProofArtifactV4Like {
  version?: unknown;
  seal_hex?: unknown;
}

function normalizeHex(raw: string, fieldName: string, expectedLength: number): string {
  const normalized = raw.trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(normalized) || normalized.length !== expectedLength) {
    throw new Error(`${fieldName} must be ${expectedLength / 2} bytes of lowercase hex`);
  }
  return normalized;
}

export function extractGroth16SealFromArtifact(artifact: unknown): Uint8Array {
  const parsed = artifact as ProofArtifactV4Like;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("proof artifact payload must be an object");
  }

  if (parsed.version !== "v4") {
    throw new Error(`unsupported proof artifact version: ${String(parsed.version)}`);
  }

  if (typeof parsed.seal_hex !== "string") {
    throw new Error("proof artifact is missing seal_hex");
  }

  const sealHex = normalizeHex(parsed.seal_hex, "seal_hex", 520);
  const seal = new Uint8Array(260);
  for (let i = 0; i < seal.length; i += 1) {
    seal[i] = Number.parseInt(sealHex.slice(i * 2, i * 2 + 2), 16);
  }
  return seal;
}
