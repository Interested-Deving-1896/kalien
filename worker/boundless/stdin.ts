import { DEFAULT_BOUNDLESS_MAX_FRAMES } from "../constants";
import { encodeClaimantForJournal } from "../../shared/stellar/journal";

/**
 * Encode tape bytes into the Boundless GuestEnv V1 (msgpack) format wrapping
 * the RISC Zero stdin the guest program expects.
 *
 * Outer envelope — Boundless `GuestEnv::encode` / `GuestEnv::decode`
 * (`crates/boundless-market/src/input.rs`):
 * ```
 * byte  0:        0x01  (V1 = msgpack-encoded GuestEnv)
 * bytes 1..M:     rmp_serde::to_vec_named(&GuestEnv { stdin })
 * ```
 *
 * The msgpack payload is a named map: `{ "stdin": [b0, b1, ...] }` where each
 * byte is encoded as a msgpack unsigned integer (fixint 0-127 → 1 byte,
 * uint8 128-255 → 2 bytes with 0xcc prefix).
 *
 * Inner stdin layout (matching `ExecutorEnv::write_slice` calls in the Rust host):
 * ```
 * bytes 0-3:   max_frames (u32 LE)
 * bytes 4-7:   seed_id (u32 LE)
 * bytes 8-40:  claimant bytes (kind(1) + id(32))
 * bytes 41-44: tape_len (u32 LE)
 * bytes 45..N: padded_tape (4-byte aligned, zero-padded)
 * ```
 *
 * Reference:
 * - Host: kalien-verifier/host/src/lib.rs:221-224
 * - Guest: kalien-verifier/methods/guest/src/main.rs:12-23
 * - Boundless input: https://github.com/boundless-xyz/boundless/blob/main/crates/boundless-market/src/input.rs
 */
export function encodeStdin(
  tapeBytes: Uint8Array,
  options: {
    maxFrames?: number;
    seedId: number;
    claimantAddress: string;
  },
): Uint8Array {
  // 1. Build the raw stdin bytes (matching the Rust host's write_slice calls)
  const frames = options.maxFrames ?? DEFAULT_BOUNDLESS_MAX_FRAMES;
  const claimantBytes = encodeClaimantForJournal(options.claimantAddress);
  const claimantLen = claimantBytes.length;
  const tapeLen = tapeBytes.length;
  const paddedLen = (tapeLen + 3) & ~3; // align to 4-byte boundary
  const tapeOffset = 4 + 4 + claimantLen + 4;
  const stdinLen = tapeOffset + paddedLen;
  const stdin = new Uint8Array(stdinLen);
  const view = new DataView(stdin.buffer);
  view.setUint32(0, frames, true); // LE
  view.setUint32(4, options.seedId >>> 0, true); // LE
  stdin.set(claimantBytes, 8);
  view.setUint32(8 + claimantLen, tapeLen, true); // LE
  stdin.set(tapeBytes, tapeOffset); // remaining padding bytes stay 0

  // 2. Wrap in GuestEnv V1 msgpack envelope
  return encodeGuestEnvV1(stdin);
}

/**
 * Encode raw stdin bytes into the Boundless GuestEnv V1 format.
 *
 * Produces byte-identical output to the Rust SDK's:
 *   `[0x01] ++ rmp_serde::to_vec_named(&GuestEnv { stdin })`
 *
 * rmp_serde serializes Vec<u8> as a msgpack array of unsigned integers
 * (NOT msgpack binary), because the GuestEnv struct does not use
 * `#[serde(with = "serde_bytes")]`.
 */
export function encodeGuestEnvV1(stdin: Uint8Array): Uint8Array {
  const n = stdin.length;

  // Count bytes >= 128 (they need 2-byte uint8 encoding: 0xcc + value)
  let highBytes = 0;
  for (let i = 0; i < n; i++) {
    if (stdin[i] >= 128) highBytes++;
  }

  // Array header size depends on element count
  let arrayHeaderSize: number;
  if (n <= 15)
    arrayHeaderSize = 1; // fixarray
  else if (n <= 0xffff)
    arrayHeaderSize = 3; // array16
  else arrayHeaderSize = 5; // array32

  // Total: version(1) + fixmap(1) + fixstr+key(6) + array_header + elements
  const elementSize = n - highBytes + highBytes * 2;
  const totalSize = 1 + 1 + 6 + arrayHeaderSize + elementSize;

  const buf = new Uint8Array(totalSize);
  let pos = 0;

  // Version byte — V1
  buf[pos++] = 0x01;

  // fixmap(1) — GuestEnv has 1 field
  buf[pos++] = 0x81;

  // fixstr(5) + "stdin"
  buf[pos++] = 0xa5;
  buf[pos++] = 0x73; // s
  buf[pos++] = 0x74; // t
  buf[pos++] = 0x64; // d
  buf[pos++] = 0x69; // i
  buf[pos++] = 0x6e; // n

  // Array header
  if (n <= 15) {
    buf[pos++] = 0x90 | n;
  } else if (n <= 0xffff) {
    buf[pos++] = 0xdc;
    buf[pos++] = (n >> 8) & 0xff;
    buf[pos++] = n & 0xff;
  } else {
    buf[pos++] = 0xdd;
    buf[pos++] = (n >> 24) & 0xff;
    buf[pos++] = (n >> 16) & 0xff;
    buf[pos++] = (n >> 8) & 0xff;
    buf[pos++] = n & 0xff;
  }

  // Encode each byte as a msgpack unsigned integer
  for (let i = 0; i < n; i++) {
    const v = stdin[i];
    if (v < 128) {
      buf[pos++] = v; // positive fixint: value IS the encoding
    } else {
      buf[pos++] = 0xcc; // uint8 marker
      buf[pos++] = v;
    }
  }

  return buf;
}
