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
export function decodeRequestId(requestId: bigint): {
  address: string;
  nonce: number;
} {
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
  if (!/^[0-9a-fA-F]*$/.test(clean)) {
    throw new Error("invalid hex string: contains non-hex characters");
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
 * Order detail pages are at /orders/{requestId} where requestId is
 * the decimal representation of the uint256 request ID.
 *
 * Reference: https://explorer.beboundless.xyz/orders/{decimal-id}
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
  return `${BOUNDLESS_EXPLORER_BASE_URL}/orders/${requestId.toString(10)}`;
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
