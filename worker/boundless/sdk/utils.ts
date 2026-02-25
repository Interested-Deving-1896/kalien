/**
 * Boundless SDK — utility helpers.
 *
 * Standalone pure functions for request ID generation, hex conversion,
 * and explorer URL formatting.
 */

// ── Request ID helpers ────────────────────────────────────────────────────

/**
 * Build a Boundless request ID from an EVM address and a nonce.
 *
 * Formula (matching Rust SDK): `(uint160(address) << 32) | uint32(nonce)`
 *
 * The nonce is masked to 32 bits via `>>> 0` (unsigned right shift), which
 * is intentional — it truncates millisecond timestamps to fit uint32.
 * This mirrors how the Rust SDK constructs the request ID:
 *   `(U256::from(address) << 32) | U256::from(nonce as u32)`
 *
 * @param address - The EVM address of the requester (0x-prefixed)
 * @param nonce   - A 32-bit nonce (e.g. `Date.now() >>> 0`)
 */
export function buildRequestId(address: `0x${string}`, nonce: number): bigint {
  return (BigInt(address) << 32n) | BigInt(nonce >>> 0);
}

/**
 * Decode a Boundless request ID back into its constituent address and nonce.
 *
 * @param requestId - The combined request ID bigint
 * @returns { address: 0x-prefixed 20-byte address (hex), nonce: uint32 }
 */
export function decodeRequestId(requestId: bigint): { address: string; nonce: number } {
  const nonce = Number(requestId & 0xffffffffn);
  const addressInt = requestId >> 32n;
  // Mask to 160 bits (20 bytes) and format as 0x-prefixed 40-char hex
  const addressHex = (addressInt & ((1n << 160n) - 1n)).toString(16).padStart(40, "0");
  return { address: `0x${addressHex}`, nonce };
}

// ── Hex / bytes conversion helpers ───────────────────────────────────────

/**
 * Convert a hex string (with or without 0x prefix) to Uint8Array.
 */
export function hexToUint8Array(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) {
    throw new Error(`invalid hex string length: ${clean.length}`);
  }
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Convert a Uint8Array to a lowercase hex string (without 0x prefix).
 */
export function uint8ArrayToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Convert a Uint8Array to a 0x-prefixed lowercase hex string.
 */
export function uint8ArrayToHex0x(bytes: Uint8Array): `0x${string}` {
  return `0x${uint8ArrayToHex(bytes)}` as `0x${string}`;
}

// ── Explorer URL helpers ──────────────────────────────────────────────────

/**
 * The Boundless proof request explorer base URL.
 *
 * Boundless uses https://explorer.beboundless.xyz as their explorer.
 * Request detail pages are at /requests/{requestId} where requestId is
 * the decimal representation of the uint256 request ID.
 *
 * Reference: https://explorer.beboundless.xyz/requests/{decimal-id}
 */
export const BOUNDLESS_EXPLORER_BASE_URL = "https://explorer.beboundless.xyz";

/**
 * Get the Boundless explorer URL for a given request ID.
 *
 * Uses the decimal representation of the uint256 request ID, as that
 * is what the Boundless explorer expects.
 *
 * @param requestId - The bigint request ID
 */
export function boundlessExplorerUrl(requestId: bigint): string {
  return `${BOUNDLESS_EXPLORER_BASE_URL}/requests/${requestId.toString(10)}`;
}

/**
 * Parse a `statusUrl` stored as `"boundless:{hexRequestId}"` and return
 * the bigint request ID. Returns null if the URL is not in Boundless format.
 *
 * @param statusUrl - e.g. "boundless:0x1a2b3c..."
 */
export function parseBoundlessStatusUrl(statusUrl: string): bigint | null {
  if (!statusUrl.startsWith("boundless:")) {
    return null;
  }
  try {
    return BigInt(statusUrl.slice("boundless:".length));
  } catch {
    return null;
  }
}

/**
 * Format a request ID as 0x-prefixed hex string.
 */
export function requestIdToHex(requestId: bigint): `0x${string}` {
  return `0x${requestId.toString(16)}` as `0x${string}`;
}

// ── ABI manual decoding helpers ───────────────────────────────────────────

/**
 * Manually decode the `fulfillmentData` field from a ProofDelivered event.
 *
 * This avoids viem's `decodeAbiParameters` which has a known bug where
 * uint256 fields with values > Number.MAX_SAFE_INTEGER get silently
 * truncated to Number, corrupting the decoded value. The manual approach
 * reads raw hex without any numeric conversion of large integers.
 *
 * When `fulfillmentDataType === 1` (ImageIdAndJournal), the fulfillmentData
 * is ABI-encoded as `(bytes32 imageId, bytes journal)`.
 *
 * @param fulfillmentDataHex - 0x-prefixed hex of the ABI-encoded fulfillmentData
 * @returns journal bytes
 */
export function decodeFulfillmentDataManual(fulfillmentDataHex: string): Uint8Array {
  const clean = fulfillmentDataHex.startsWith("0x")
    ? fulfillmentDataHex.slice(2)
    : fulfillmentDataHex;

  // Helper: read a uint256 as a JS number (safe only for offsets/lengths < 2^32)
  const readUintAt = (charOffset: number): number => {
    const word = clean.slice(charOffset, charOffset + 64);
    // Use parseInt with hex — safe for offset/length values which are small
    return Number.parseInt(word, 16);
  };

  // fulfillmentData layout for type=1 (ImageIdAndJournal):
  // word 0: offset to the tuple (should be 0x20 = 32 bytes)
  // Tuple:
  //   word 0: imageId (bytes32) — we skip this
  //   word 1: offset to journal bytes (relative to tuple start)
  //   word 2: journal length
  //   word 3+: journal data

  // The outer encoding is either a raw struct or tuple-wrapped with a leading offset word.
  // Check if first word is 0x20 (tuple-wrapped) or a bytes32 (direct struct)
  const firstWordVal = readUintAt(0);

  let tupleStart: number; // char offset where the tuple begins
  if (firstWordVal === 32) {
    // tuple-wrapped: word 0 is offset=32, so tuple starts at char offset 64
    tupleStart = 64;
  } else {
    // direct: starts at char offset 0
    tupleStart = 0;
  }

  // imageId is at tupleStart (32 bytes / 64 chars) — skip it
  // journal offset is at tupleStart + 64
  const journalByteOffset = readUintAt(tupleStart + 64);
  // journal length is at tupleStart + journalByteOffset * 2 (in chars)
  const journalLenCharOffset = tupleStart + journalByteOffset * 2;
  const journalLen = readUintAt(journalLenCharOffset);
  const journalHex = clean.slice(journalLenCharOffset + 64, journalLenCharOffset + 64 + journalLen * 2);

  return hexToUint8Array(journalHex);
}

/**
 * Manually decode the `seal` field from a ProofDelivered event log.
 *
 * The seal is ABI-encoded as a `bytes` field. We just need to decode the
 * length-prefixed bytes from the raw hex.
 *
 * @param sealHex - 0x-prefixed hex of the ABI-encoded seal bytes
 * @returns raw seal bytes
 */
export function decodeSealBytesManual(sealHex: string): Uint8Array {
  const clean = sealHex.startsWith("0x") ? sealHex.slice(2) : sealHex;
  // First word is the length of the bytes array
  const len = Number.parseInt(clean.slice(0, 64), 16);
  return hexToUint8Array(clean.slice(64, 64 + len * 2));
}
