/**
 * Authenticated chunk framing over Noise transport cipher states (docs/109 §3.2).
 *
 * Plaintext chunk layout (inside ChaCha20-Poly1305):
 *   kind(1) || flags(1) || totalLength(u32 BE) || streamId(u32 BE) || data (<= 65,509 B)
 *
 * Wire record layout:
 *   (u16 BE ciphertextLength || ciphertext)+
 *
 * Putting `kind`, `flags`, `totalLength` and `streamId` inside the authenticated plaintext stops an
 * untrusted relay from coalescing, truncating, splitting, or re-tagging frames. On receive, wire
 * lengths are checked against actual received bytes BEFORE allocating a reassembly buffer so a
 * forged multi-gigabyte `totalLength` allocates nothing.
 */

import { CHACHAPOLY_TAG_BYTES, type CipherState, NoiseError } from "./noise.ts";

export const RECORD_KIND_TEXT = 0x00;
export const RECORD_KIND_BINARY = 0x01;
export const RECORD_KIND_CONTROL = 0x02;

export type RecordKind =
  | typeof RECORD_KIND_TEXT
  | typeof RECORD_KIND_BINARY
  | typeof RECORD_KIND_CONTROL;

export const CHUNK_FLAG_FIRST = 0x01;
export const CHUNK_FLAG_FINAL = 0x02;
const ALLOWED_FLAGS_MASK = CHUNK_FLAG_FIRST | CHUNK_FLAG_FINAL;

export const CHUNK_HEADER_BYTES = 10;
/** Noise transport messages max at 65,535 bytes; minus 16 B tag and 10 B inner header = 65,509 B. */
export const MAX_CHUNK_DATA_BYTES = 65_535 - CHACHAPOLY_TAG_BYTES - CHUNK_HEADER_BYTES;
/** Default upper bound for one reassembled application record (16 MiB). */
export const DEFAULT_MAX_RECORD_BYTES = 16 * 1024 * 1024;

export interface DecodedRecord {
  readonly kind: RecordKind;
  readonly streamId: number;
  readonly payload: Uint8Array;
}

export class RecordFrameError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "RecordFrameError";
    this.code = code;
  }
}

function isValidKind(kind: number): kind is RecordKind {
  return kind === RECORD_KIND_TEXT || kind === RECORD_KIND_BINARY || kind === RECORD_KIND_CONTROL;
}

function validateStreamId(streamId: number): void {
  if (!Number.isInteger(streamId) || streamId < 0 || streamId > 0xffff_ffff) {
    throw new RecordFrameError("invalid_stream_id", `Invalid streamId: ${streamId}`);
  }
}

/**
 * Encrypts one application payload into a wire record of one or more authenticated Noise chunks.
 */
export function sealRecord(
  cipher: CipherState,
  record: DecodedRecord,
  maxRecordBytes: number = DEFAULT_MAX_RECORD_BYTES,
): Uint8Array {
  if (!cipher.hasKey()) {
    throw new RecordFrameError("unkeyed_cipher", "Cannot seal record on an unkeyed CipherState");
  }
  if (!isValidKind(record.kind)) {
    throw new RecordFrameError("invalid_kind", `Invalid record kind: ${record.kind}`);
  }
  validateStreamId(record.streamId);
  const totalLength = record.payload.byteLength;
  if (totalLength > maxRecordBytes) {
    throw new RecordFrameError(
      "record_too_large",
      `Record length ${totalLength} exceeds maximum ${maxRecordBytes}`,
    );
  }

  const chunkCount = Math.max(1, Math.ceil(totalLength / MAX_CHUNK_DATA_BYTES));
  const wireParts: Buffer[] = [];

  for (let i = 0; i < chunkCount; i++) {
    const start = i * MAX_CHUNK_DATA_BYTES;
    const end = Math.min(start + MAX_CHUNK_DATA_BYTES, totalLength);
    const slice = record.payload.subarray(start, end);
    let flags = 0;
    if (i === 0) flags |= CHUNK_FLAG_FIRST;
    if (i === chunkCount - 1) flags |= CHUNK_FLAG_FINAL;

    const plain = Buffer.allocUnsafe(CHUNK_HEADER_BYTES + slice.byteLength);
    plain[0] = record.kind;
    plain[1] = flags;
    plain.writeUInt32BE(totalLength, 2);
    plain.writeUInt32BE(record.streamId, 6);
    plain.set(slice, CHUNK_HEADER_BYTES);

    const ct = cipher.encryptWithAd(new Uint8Array(0), plain);
    const prefix = Buffer.allocUnsafe(2);
    prefix.writeUInt16BE(ct.byteLength, 0);
    wireParts.push(prefix, Buffer.from(ct.buffer, ct.byteOffset, ct.byteLength));
  }

  return new Uint8Array(Buffer.concat(wireParts));
}

/**
 * Decrypts and validates a wire record, rejecting malformed framing, truncated records, metadata
 * disagreement across chunks, or forged lengths without pre-allocating untrusted sizes.
 */
export function openRecord(
  cipher: CipherState,
  wire: Uint8Array,
  maxRecordBytes: number = DEFAULT_MAX_RECORD_BYTES,
): DecodedRecord {
  if (!cipher.hasKey()) {
    throw new RecordFrameError("unkeyed_cipher", "Cannot open record on an unkeyed CipherState");
  }
  if (wire.byteLength === 0) {
    throw new RecordFrameError("empty_wire_record", "Wire record is empty");
  }

  // Pass 1: parse wire chunk boundaries and compute exact expected plaintext byte sum BEFORE
  // decrypting or allocating the output buffer, so bogus headers never trigger large allocations.
  const ciphertextSlices: Uint8Array[] = [];
  let offset = 0;
  let upperBoundDataBytes = 0;
  const minCiphertext = CHUNK_HEADER_BYTES + CHACHAPOLY_TAG_BYTES;

  while (offset < wire.byteLength) {
    if (offset + 2 > wire.byteLength) {
      throw new RecordFrameError("truncated_wire_length", "Truncated u16 chunk length prefix");
    }
    const ctLen = ((wire[offset] ?? 0) << 8) | (wire[offset + 1] ?? 0);
    offset += 2;
    if (ctLen < minCiphertext) {
      throw new RecordFrameError("chunk_too_short", `Chunk ciphertext length ${ctLen} is too short`);
    }
    if (offset + ctLen > wire.byteLength) {
      throw new RecordFrameError("truncated_wire_chunk", "Wire record ended mid-chunk");
    }
    ciphertextSlices.push(wire.subarray(offset, offset + ctLen));
    upperBoundDataBytes += ctLen - minCiphertext;
    offset += ctLen;
  }

  if (ciphertextSlices.length === 0) {
    throw new RecordFrameError("empty_wire_record", "Wire record has zero chunks");
  }
  if (upperBoundDataBytes > maxRecordBytes) {
    throw new RecordFrameError(
      "record_too_large",
      `Wire record data bytes ${upperBoundDataBytes} exceed maximum ${maxRecordBytes}`,
    );
  }

  let expectedKind: RecordKind | null = null;
  let expectedTotalLength = 0;
  let expectedStreamId = 0;
  let output: Buffer | null = null;
  let writeOffset = 0;

  for (let i = 0; i < ciphertextSlices.length; i++) {
    const ct = ciphertextSlices[i]!;
    let plain: Uint8Array;
    try {
      plain = cipher.decryptWithAd(new Uint8Array(0), ct);
    } catch (err) {
      if (err instanceof NoiseError) {
        throw new RecordFrameError(err.code, err.message);
      }
      throw err;
    }

    const view = new DataView(plain.buffer, plain.byteOffset, plain.byteLength);
    const kind = plain[0] ?? 0xff;
    const flags = plain[1] ?? 0xff;
    const totalLength = view.getUint32(2, false);
    const streamId = view.getUint32(6, false);
    const data = plain.subarray(CHUNK_HEADER_BYTES);

    if (!isValidKind(kind)) {
      throw new RecordFrameError("invalid_kind", `Invalid record kind: ${kind}`);
    }
    if ((flags & ~ALLOWED_FLAGS_MASK) !== 0) {
      throw new RecordFrameError("reserved_flags", `Chunk carries reserved flags: 0x${flags.toString(16)}`);
    }

    const isFirst = i === 0;
    const isFinal = i === ciphertextSlices.length - 1;
    if (isFirst !== ((flags & CHUNK_FLAG_FIRST) !== 0)) {
      throw new RecordFrameError("invalid_first_flag", "FIRST flag disagrees with chunk position");
    }
    if (isFinal !== ((flags & CHUNK_FLAG_FINAL) !== 0)) {
      throw new RecordFrameError("invalid_final_flag", "FINAL flag disagrees with chunk position");
    }
    if (!isFinal && data.byteLength !== MAX_CHUNK_DATA_BYTES) {
      throw new RecordFrameError("non_full_chunk", "Non-final chunk must be full length");
    }

    if (isFirst) {
      // Check against actual bytes present in this wire record BEFORE allocating!
      if (totalLength !== upperBoundDataBytes || totalLength > maxRecordBytes) {
        throw new RecordFrameError(
          "length_mismatch",
          `Declared totalLength ${totalLength} disagrees with wire payload bytes ${upperBoundDataBytes}`,
        );
      }
      expectedKind = kind;
      expectedTotalLength = totalLength;
      expectedStreamId = streamId;
      output = Buffer.allocUnsafe(totalLength);
    } else if (kind !== expectedKind || totalLength !== expectedTotalLength || streamId !== expectedStreamId) {
      throw new RecordFrameError("metadata_mismatch", "Chunk metadata disagrees across chunks");
    }

    output!.set(data, writeOffset);
    writeOffset += data.byteLength;
  }

  if (output === null || expectedKind === null || writeOffset !== expectedTotalLength) {
    throw new RecordFrameError("length_mismatch", "Reassembled bytes did not match totalLength");
  }

  return {
    kind: expectedKind,
    streamId: expectedStreamId,
    payload: new Uint8Array(output),
  };
}
