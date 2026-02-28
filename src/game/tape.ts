/**
 * Replay Tape: binary format, recorder, serializer, and CRC-32.
 *
 * Tape layout (little-endian):
 *
 * HEADER (16 bytes):
 *   [0..3]   u32    magic           = 0x5A4B5450 ("ZKTP")
 *   [4]      u8     version         = 4
 *   [5]      u8     rules_tag       = 4
 *   [6..7]   u8[2]  reserved        = 0
 *   [8..11]  u32    seed
 *   [12..15] u32    frameCount      (number of frames; body bytes = ceil(frameCount/2))
 *
 * BODY (ceil(frameCount/2) bytes):
 *   byte[i] = frame[2i] | (frame[2i+1] << 4)
 *   Low nibble  (bits 0–3): frame 2i
 *   High nibble (bits 4–7): frame 2i+1  (0x0 if frameCount is odd and this is the last byte)
 *   Bit mapping per nibble:
 *     bit 0 (0x1): left
 *     bit 1 (0x2): right
 *     bit 2 (0x4): thrust
 *     bit 3 (0x8): fire
 *
 * FOOTER (8 bytes):
 *   [bodyEnd+0 .. bodyEnd+3]   u32  finalScore
 *   [bodyEnd+4 .. bodyEnd+7]   u32  checksum (CRC-32 of header + packed body)
 */

import { RULES_TAG } from "./constants";

export const TAPE_MAGIC = 0x5a4b5450;
export const TAPE_VERSION = 4;
export const TAPE_HEADER_SIZE = 16;
export const TAPE_FOOTER_SIZE = 8;

export interface TapeHeader {
  magic: number;
  version: number;
  rulesTag: number;
  seed: number;
  frameCount: number;
}

export interface TapeFooter {
  finalScore: number;
  checksum: number;
}

export interface Tape {
  header: TapeHeader;
  inputs: Uint8Array;
  footer: TapeFooter;
}

export interface FrameInput {
  left: boolean;
  right: boolean;
  thrust: boolean;
  fire: boolean;
}

export function encodeInputByte(input: FrameInput): number {
  return (
    (input.left ? 0x01 : 0) |
    (input.right ? 0x02 : 0) |
    (input.thrust ? 0x04 : 0) |
    (input.fire ? 0x08 : 0)
  );
}

export function decodeInputByte(byte: number): FrameInput {
  return {
    left: (byte & 0x01) !== 0,
    right: (byte & 0x02) !== 0,
    thrust: (byte & 0x04) !== 0,
    fire: (byte & 0x08) !== 0,
  };
}

const INITIAL_CAPACITY = 18000; // ~5 minutes at 60fps

export class TapeRecorder {
  private buffer: Uint8Array;
  private cursor = 0;

  constructor() {
    this.buffer = new Uint8Array(INITIAL_CAPACITY);
  }

  record(input: FrameInput): void {
    if (this.cursor >= this.buffer.length) {
      const next = new Uint8Array(this.buffer.length * 2);
      next.set(this.buffer);
      this.buffer = next;
    }
    this.buffer[this.cursor++] = encodeInputByte(input);
  }

  getInputs(): Uint8Array {
    return this.buffer.subarray(0, this.cursor);
  }

  getFrameCount(): number {
    return this.cursor;
  }
}

export function serializeTape(
  seed: number,
  inputs: Uint8Array,
  finalScore: number,
): Uint8Array {
  const frameCount = inputs.length;
  const bodyBytes = (frameCount + 1) >> 1;
  const totalSize = TAPE_HEADER_SIZE + bodyBytes + TAPE_FOOTER_SIZE;
  const data = new Uint8Array(totalSize);
  const view = new DataView(data.buffer);

  // Header
  view.setUint32(0, TAPE_MAGIC, true);
  view.setUint8(4, TAPE_VERSION);
  view.setUint8(5, RULES_TAG);
  // reserved bytes 6-7 already 0
  view.setUint32(8, seed >>> 0, true);
  view.setUint32(12, frameCount, true);

  // Nibble-pack body: low nibble = frame 2i, high nibble = frame 2i+1.
  for (let i = 0; i < bodyBytes; i++) {
    const lo = inputs[2 * i] & 0x0f;
    const hi = 2 * i + 1 < frameCount ? (inputs[2 * i + 1] & 0x0f) << 4 : 0;
    data[TAPE_HEADER_SIZE + i] = lo | hi;
  }

  // Footer
  const footerOffset = TAPE_HEADER_SIZE + bodyBytes;
  view.setUint32(footerOffset, finalScore >>> 0, true);

  // CRC-32 over header + packed body
  const checksum = crc32(data.subarray(0, footerOffset));
  view.setUint32(footerOffset + 4, checksum >>> 0, true);

  return data;
}

export function deserializeTape(data: Uint8Array, maxFrames?: number): Tape {
  if (data.length < TAPE_HEADER_SIZE + TAPE_FOOTER_SIZE) {
    throw new Error("Tape too short");
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  const magic = view.getUint32(0, true);
  if (magic !== TAPE_MAGIC) {
    throw new Error(`Invalid tape magic: 0x${magic.toString(16)}`);
  }

  const version = view.getUint8(4);
  if (version !== TAPE_VERSION) {
    throw new Error(`Unsupported tape version: ${version}`);
  }

  const rulesTag = view.getUint8(5);
  if (rulesTag !== RULES_TAG) {
    throw new Error(
      `Unknown rules tag: ${rulesTag} (expected ${RULES_TAG}). Regenerate the tape with the current AST4 client.`,
    );
  }
  if (view.getUint8(6) !== 0 || view.getUint8(7) !== 0) {
    throw new Error("Header reserved bytes [6..7] are non-zero");
  }

  const seed = view.getUint32(8, true);
  const frameCount = view.getUint32(12, true);
  if (frameCount === 0 || (maxFrames !== undefined && frameCount > maxFrames)) {
    throw new Error(
      `Frame count out of range: ${frameCount}${maxFrames !== undefined ? ` (max ${maxFrames})` : ""}`,
    );
  }

  const bodyBytes = (frameCount + 1) >> 1;
  const expectedLength = TAPE_HEADER_SIZE + bodyBytes + TAPE_FOOTER_SIZE;
  if (data.length !== expectedLength) {
    throw new Error(`Tape length mismatch: expected ${expectedLength} bytes, got ${data.length}`);
  }

  const footerOffset = TAPE_HEADER_SIZE + bodyBytes;

  // Verify CRC-32 over header + packed body.
  const storedChecksum = view.getUint32(footerOffset + 4, true);
  const computed = crc32(data.subarray(0, footerOffset));
  if (computed !== storedChecksum) {
    throw new Error(
      `CRC mismatch: stored=0x${storedChecksum.toString(16)}, computed=0x${(computed >>> 0).toString(16)}`,
    );
  }

  // Unpack nibbles into one byte per frame.
  const inputs = new Uint8Array(frameCount);
  for (let i = 0; i < bodyBytes; i++) {
    const byte = data[TAPE_HEADER_SIZE + i];
    inputs[2 * i] = byte & 0x0f;
    if (2 * i + 1 < frameCount) {
      inputs[2 * i + 1] = (byte >> 4) & 0x0f;
    }
  }

  const finalScore = view.getUint32(footerOffset, true);

  return {
    header: { magic, version, rulesTag, seed, frameCount },
    inputs,
    footer: { finalScore, checksum: storedChecksum },
  };
}

// CRC-32 (ISO 3309 / ITU-T V.42 polynomial)
const CRC_TABLE = buildCrcTable();

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
}

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
