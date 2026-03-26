import {
  DEFAULT_MAX_TAPE_BYTES,
  EXPECTED_RULES_TAG,
  REPLAY_HASH_DOMAIN,
  TAPE_HEADER_SIZE,
  TAPE_VERSION,
} from "./constants";
import { parseAndValidateTape } from "./tape";
import type { TapeMetadata } from "./types";

export interface ReplayIdentity {
  replayHash: string;
  seed: number;
  frameCount: number;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function computeReplayIdentity(
  tapeBytes: Uint8Array,
  maxTapeBytes = DEFAULT_MAX_TAPE_BYTES,
  validatedMetadata?: TapeMetadata,
): Promise<ReplayIdentity> {
  const metadata = validatedMetadata ?? parseAndValidateTape(tapeBytes, maxTapeBytes);
  const bodyBytes = (metadata.frameCount + 1) >> 1;
  const packedInputs = tapeBytes.slice(TAPE_HEADER_SIZE, TAPE_HEADER_SIZE + bodyBytes);
  const domainBytes = new TextEncoder().encode(REPLAY_HASH_DOMAIN);
  const preimage = new Uint8Array(domainBytes.length + 2 + 4 + 4 + packedInputs.length);
  const view = new DataView(preimage.buffer);

  preimage.set(domainBytes, 0);
  preimage[domainBytes.length] = TAPE_VERSION;
  preimage[domainBytes.length + 1] = EXPECTED_RULES_TAG;
  view.setUint32(domainBytes.length + 2, metadata.seed >>> 0, true);
  view.setUint32(domainBytes.length + 6, metadata.frameCount >>> 0, true);
  preimage.set(packedInputs, domainBytes.length + 10);

  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", preimage));
  return {
    replayHash: bytesToHex(digest),
    seed: metadata.seed >>> 0,
    frameCount: metadata.frameCount >>> 0,
  };
}
