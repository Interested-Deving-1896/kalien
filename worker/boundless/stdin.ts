import { DEFAULT_BOUNDLESS_MAX_FRAMES } from "../constants";

/**
 * Encode tape bytes into the RISC Zero stdin format the guest program expects.
 *
 * Layout (matching `ExecutorEnv::write_slice` calls in the Rust host):
 * ```
 * bytes 0-3:   max_frames (u32 LE)
 * bytes 4-7:   tape_len (u32 LE)
 * bytes 8..N:  padded_tape (4-byte aligned, zero-padded)
 * ```
 *
 * Reference:
 * - Host: kalien-verifier/host/src/lib.rs:221-224
 * - Guest: kalien-verifier/methods/guest/src/main.rs:12-23
 */
export function encodeStdin(tapeBytes: Uint8Array, maxFrames?: number): Uint8Array {
  const frames = maxFrames ?? DEFAULT_BOUNDLESS_MAX_FRAMES;
  const tapeLen = tapeBytes.length;
  const paddedLen = (tapeLen + 3) & ~3; // align to 4-byte boundary
  const buf = new Uint8Array(4 + 4 + paddedLen);
  const view = new DataView(buf.buffer);
  view.setUint32(0, frames, true); // LE
  view.setUint32(4, tapeLen, true); // LE
  buf.set(tapeBytes, 8); // remaining padding bytes stay 0
  return buf;
}
