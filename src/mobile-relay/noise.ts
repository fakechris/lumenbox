/**
 * Noise Protocol Framework (Revision 34) implementation for personal-mode mobile relay (docs/109 §3.2).
 *
 * Implements two patterns over Node's built-in crypto primitives (zero external dependencies):
 * - `Noise_NK_25519_ChaChaPoly_SHA256`: used once during physical QR pairing to register a phone's
 *   static X25519 public key over an encrypted channel keyed to the Mac's static public key.
 * - `Noise_IK_25519_ChaChaPoly_SHA256`: used on every subsequent reconnection (prologue
 *   `lumenbox-relay/1`), encrypting the phone's static public key inside message 1 so the relay
 *   learns nothing while the Mac authenticates and admits or revokes each phone individually.
 *
 * No legacy or unauthenticated fallback exists.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export const NOISE_NK_PROTOCOL_NAME = "Noise_NK_25519_ChaChaPoly_SHA256";
export const NOISE_IK_PROTOCOL_NAME = "Noise_IK_25519_ChaChaPoly_SHA256";
export const LUMENBOX_RELAY_PROLOGUE = Buffer.from("lumenbox-relay/1", "utf8");

export const X25519_KEY_BYTES = 32;
export const CHACHAPOLY_TAG_BYTES = 16;
const CHACHAPOLY_KEY_BYTES = 32;
const CHACHAPOLY_NONCE_BYTES = 12;
const MAX_NONCE = (1n << 64n) - 2n;

/** PKCS#8 DER prefix for a raw 32-byte X25519 private key (RFC 8410). */
const X25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
/** SubjectPublicKeyInfo DER prefix for a raw 32-byte X25519 public key (RFC 8410). */
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

/** Field prime p = 2^255 - 19 in little-endian byte order. */
const FIELD_PRIME_LE = Buffer.from(
  "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "hex",
);

/**
 * The canonical encodings of low-order Curve25519 points (< p) that produce an all-zero shared
 * secret under X25519 scalar multiplication. Checked explicitly at relay ingress and handshake.
 */
const LOW_ORDER_POINTS_LE: readonly Buffer[] = [
  Buffer.from("0000000000000000000000000000000000000000000000000000000000000000", "hex"),
  Buffer.from("0100000000000000000000000000000000000000000000000000000000000000", "hex"),
  Buffer.from("e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800", "hex"),
  Buffer.from("5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157", "hex"),
  Buffer.from("ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f", "hex"),
];

export interface X25519Keypair {
  readonly publicKey: Uint8Array;
  readonly privateKey: Uint8Array;
}

export class NoiseError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "NoiseError";
    this.code = code;
  }
}

/** Little-endian comparison `a < b` for two 32-byte unsigned integers, without data-dependent branches. */
function lessThanLe32(a: Uint8Array, b: Uint8Array): boolean {
  let borrow = 0;
  for (let i = 0; i < 32; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0) - borrow;
    borrow = diff < 0 ? 1 : 0;
  }
  return borrow === 1;
}

/**
 * Returns true iff `pub` is a canonical 32-byte X25519 public key (`0 <= u < 2^255 - 19`) and not
 * one of the low-order Curve25519 torsion points.
 */
export function isCanonicalX25519PublicKey(pub: Uint8Array): boolean {
  if (!(pub instanceof Uint8Array) || pub.byteLength !== X25519_KEY_BYTES) return false;
  if (!lessThanLe32(pub, FIELD_PRIME_LE)) return false;
  const buf = Buffer.from(pub.buffer, pub.byteOffset, pub.byteLength);
  for (const point of LOW_ORDER_POINTS_LE) {
    if (timingSafeEqual(buf, point)) return false;
  }
  return true;
}

function clampScalar(raw: Uint8Array): Buffer {
  if (raw.byteLength !== X25519_KEY_BYTES) {
    throw new NoiseError("invalid_private_key", "X25519 private key must be 32 bytes");
  }
  const clamped = Buffer.from(raw);
  clamped[0] = (clamped[0] ?? 0) & 248;
  clamped[31] = ((clamped[31] ?? 0) & 127) | 64;
  return clamped;
}

/** Derives an X25519 keypair deterministically from a 32-byte private key seed/scalar. */
export function x25519KeypairFromPrivate(privateKey: Uint8Array): X25519Keypair {
  const clamped = clampScalar(privateKey);
  const privObj = createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, clamped]),
    format: "der",
    type: "pkcs8",
  });
  const pubDer = createPublicKey(privObj).export({ format: "der", type: "spki" });
  const pubRaw = new Uint8Array(pubDer.subarray(X25519_SPKI_PREFIX.byteLength));
  return {
    privateKey: new Uint8Array(privateKey),
    publicKey: pubRaw,
  };
}

/** Generates a fresh random X25519 keypair. */
export function generateX25519Keypair(): X25519Keypair {
  return x25519KeypairFromPrivate(randomBytes(X25519_KEY_BYTES));
}

/** Computes X25519 Diffie-Hellman shared secret, rejecting non-canonical or low-order public keys. */
export function x25519Dh(privateKey: Uint8Array, peerPublicKey: Uint8Array): Buffer {
  if (!isCanonicalX25519PublicKey(peerPublicKey)) {
    throw new NoiseError("invalid_public_key", "Peer X25519 public key is non-canonical or low-order");
  }
  const clamped = clampScalar(privateKey);
  const privObj = createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, clamped]),
    format: "der",
    type: "pkcs8",
  });
  const pubObj = createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, Buffer.from(peerPublicKey)]),
    format: "der",
    type: "spki",
  });
  const shared = diffieHellman({ privateKey: privObj, publicKey: pubObj });
  const zero = Buffer.alloc(X25519_KEY_BYTES, 0);
  if (timingSafeEqual(shared, zero)) {
    throw new NoiseError("low_order_shared_secret", "X25519 DH produced an all-zero shared secret");
  }
  return shared;
}

function sha256(data: Uint8Array): Buffer {
  return createHash("sha256").update(data).digest();
}

function hmacSha256(key: Uint8Array, data: Uint8Array): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

/** Noise HKDF-2 over HMAC-SHA256. */
function hkdf2(chainingKey: Uint8Array, inputKeyMaterial: Uint8Array): [Buffer, Buffer] {
  const tempKey = hmacSha256(chainingKey, inputKeyMaterial);
  const out1 = hmacSha256(tempKey, Buffer.from([0x01]));
  const out2 = hmacSha256(tempKey, Buffer.concat([out1, Buffer.from([0x02])]));
  tempKey.fill(0);
  return [out1, out2];
}

function encodeChaChaNonce(n: bigint): Buffer {
  const iv = Buffer.alloc(CHACHAPOLY_NONCE_BYTES, 0);
  iv.writeBigUInt64LE(n, 4);
  return iv;
}

/**
 * Noise CipherState (ChaCha20-Poly1305 with 64-bit little-endian counter at nonce[4..12]).
 * Nonces are reserved synchronously before encryption and advanced on decryption only after tag
 * verification succeeds, preventing replay, reordering, or nonce wraparound.
 */
export class CipherState {
  private key: Buffer | null;
  private nonce = 0n;
  /** Set by destroy(): a destroyed state refuses, rather than act as the empty-key pass-through. */
  private destroyed = false;

  constructor(key: Uint8Array | null = null) {
    this.key = key ? Buffer.from(key) : null;
  }

  hasKey(): boolean {
    return this.key !== null;
  }

  currentNonce(): bigint {
    return this.nonce;
  }

  encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    this.refuseIfDestroyed();
    if (this.key === null) return new Uint8Array(plaintext);
    if (this.nonce > MAX_NONCE) {
      throw new NoiseError("nonce_exhausted", "Noise cipher nonce exhausted");
    }
    const n = this.nonce;
    this.nonce = n + 1n;
    const cipher = createCipheriv("chacha20-poly1305", this.key, encodeChaChaNonce(n), {
      authTagLength: CHACHAPOLY_TAG_BYTES,
    });
    if (ad.byteLength > 0) cipher.setAAD(ad, { plaintextLength: plaintext.byteLength });
    const enc = cipher.update(plaintext);
    const fin = cipher.final();
    const tag = cipher.getAuthTag();
    return new Uint8Array(Buffer.concat([enc, fin, tag]));
  }

  decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    this.refuseIfDestroyed();
    if (this.key === null) return new Uint8Array(ciphertext);
    if (this.nonce > MAX_NONCE) {
      throw new NoiseError("nonce_exhausted", "Noise cipher nonce exhausted");
    }
    if (ciphertext.byteLength < CHACHAPOLY_TAG_BYTES) {
      throw new NoiseError("decrypt_failed", "Ciphertext shorter than Poly1305 tag");
    }
    const n = this.nonce;
    const body = ciphertext.subarray(0, ciphertext.byteLength - CHACHAPOLY_TAG_BYTES);
    const tag = ciphertext.subarray(ciphertext.byteLength - CHACHAPOLY_TAG_BYTES);
    const decipher = createDecipheriv("chacha20-poly1305", this.key, encodeChaChaNonce(n), {
      authTagLength: CHACHAPOLY_TAG_BYTES,
    });
    if (ad.byteLength > 0) decipher.setAAD(ad, { plaintextLength: body.byteLength });
    decipher.setAuthTag(tag);
    try {
      const dec = decipher.update(body);
      const fin = decipher.final();
      this.nonce = n + 1n;
      return new Uint8Array(Buffer.concat([dec, fin]));
    } catch {
      throw new NoiseError("decrypt_failed", "Authenticated decryption failed");
    }
  }

  destroy(): void {
    this.destroyed = true;
    if (this.key) {
      this.key.fill(0);
      this.key = null;
    }
  }

  private refuseIfDestroyed(): void {
    if (this.destroyed) throw new NoiseError("cipher_destroyed", "Noise cipher state was destroyed");
  }
}

class SymmetricState {
  private ck: Buffer;
  private h: Buffer;
  private cipher = new CipherState(null);

  constructor(protocolName: string) {
    const nameBytes = Buffer.from(protocolName, "ascii");
    if (nameBytes.byteLength <= 32) {
      this.h = Buffer.alloc(32, 0);
      nameBytes.copy(this.h);
    } else {
      this.h = sha256(nameBytes);
    }
    this.ck = Buffer.from(this.h);
  }

  mixHash(data: Uint8Array): void {
    this.h = sha256(Buffer.concat([this.h, Buffer.from(data)]));
  }

  mixKey(inputKeyMaterial: Uint8Array): void {
    const [ck, tempK] = hkdf2(this.ck, inputKeyMaterial);
    this.ck.fill(0);
    this.ck = ck;
    this.cipher.destroy();
    this.cipher = new CipherState(tempK.subarray(0, CHACHAPOLY_KEY_BYTES));
    tempK.fill(0);
  }

  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const ciphertext = this.cipher.encryptWithAd(this.h, plaintext);
    this.mixHash(ciphertext);
    return ciphertext;
  }

  decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    const plaintext = this.cipher.decryptWithAd(this.h, ciphertext);
    this.mixHash(ciphertext);
    return plaintext;
  }

  split(): { c1: CipherState; c2: CipherState; handshakeHash: Uint8Array } {
    const [tempK1, tempK2] = hkdf2(this.ck, new Uint8Array(0));
    const c1 = new CipherState(tempK1.subarray(0, CHACHAPOLY_KEY_BYTES));
    const c2 = new CipherState(tempK2.subarray(0, CHACHAPOLY_KEY_BYTES));
    const handshakeHash = new Uint8Array(this.h);
    tempK1.fill(0);
    tempK2.fill(0);
    this.ck.fill(0);
    this.cipher.destroy();
    return { c1, c2, handshakeHash };
  }
}

export interface NoiseSession {
  readonly send: CipherState;
  readonly receive: CipherState;
  readonly handshakeHash: Uint8Array;
  destroy(): void;
}

function buildSession(send: CipherState, receive: CipherState, handshakeHash: Uint8Array): NoiseSession {
  return {
    send,
    receive,
    handshakeHash,
    destroy() {
      send.destroy();
      receive.destroy();
    },
  };
}

// ── Noise_NK_25519_ChaChaPoly_SHA256 (one-time pairing) ──────────────────────

export interface NkInitiatorState {
  completeMessage2(message2: Uint8Array): { payload: Uint8Array; session: NoiseSession };
}

export function startNkInitiator(options: {
  responderStaticPublicKey: Uint8Array;
  prologue?: Uint8Array;
  payload?: Uint8Array;
  ephemeralPrivateKey?: Uint8Array;
}): { message1: Uint8Array; state: NkInitiatorState } {
  const rs = options.responderStaticPublicKey;
  if (!isCanonicalX25519PublicKey(rs)) {
    throw new NoiseError("invalid_public_key", "Responder static public key is invalid");
  }
  const e = options.ephemeralPrivateKey
    ? x25519KeypairFromPrivate(options.ephemeralPrivateKey)
    : generateX25519Keypair();
  const sym = new SymmetricState(NOISE_NK_PROTOCOL_NAME);
  sym.mixHash(options.prologue ?? LUMENBOX_RELAY_PROLOGUE);
  sym.mixHash(rs);

  // -> e, es
  sym.mixHash(e.publicKey);
  const es = x25519Dh(e.privateKey, rs);
  sym.mixKey(es);
  es.fill(0);
  const encPayload = sym.encryptAndHash(options.payload ?? new Uint8Array(0));
  const message1 = new Uint8Array(Buffer.concat([Buffer.from(e.publicKey), Buffer.from(encPayload)]));

  return {
    message1,
    state: {
      completeMessage2(message2: Uint8Array) {
        if (message2.byteLength < X25519_KEY_BYTES + CHACHAPOLY_TAG_BYTES) {
          throw new NoiseError("truncated_handshake", "Noise NK message 2 is truncated");
        }
        // <- e, ee
        const re = message2.subarray(0, X25519_KEY_BYTES);
        sym.mixHash(re);
        const ee = x25519Dh(e.privateKey, re);
        sym.mixKey(ee);
        ee.fill(0);
        const payload = sym.decryptAndHash(message2.subarray(X25519_KEY_BYTES));
        const { c1, c2, handshakeHash } = sym.split();
        return { payload, session: buildSession(c1, c2, handshakeHash) };
      },
    },
  };
}

export function respondNk(options: {
  responderStaticKeypair: X25519Keypair;
  message1: Uint8Array;
  prologue?: Uint8Array;
  responsePayload?: Uint8Array | ((clientPayload: Uint8Array) => Uint8Array);
  ephemeralPrivateKey?: Uint8Array;
}): { clientPayload: Uint8Array; message2: Uint8Array; session: NoiseSession } {
  if (options.message1.byteLength < X25519_KEY_BYTES + CHACHAPOLY_TAG_BYTES) {
    throw new NoiseError("truncated_handshake", "Noise NK message 1 is truncated");
  }
  const s = options.responderStaticKeypair;
  const sym = new SymmetricState(NOISE_NK_PROTOCOL_NAME);
  sym.mixHash(options.prologue ?? LUMENBOX_RELAY_PROLOGUE);
  sym.mixHash(s.publicKey);

  // -> e, es
  const re = options.message1.subarray(0, X25519_KEY_BYTES);
  sym.mixHash(re);
  const es = x25519Dh(s.privateKey, re);
  sym.mixKey(es);
  es.fill(0);
  const clientPayload = sym.decryptAndHash(options.message1.subarray(X25519_KEY_BYTES));

  const replyBytes =
    typeof options.responsePayload === "function"
      ? options.responsePayload(clientPayload)
      : (options.responsePayload ?? new Uint8Array(0));

  // <- e, ee
  const e = options.ephemeralPrivateKey
    ? x25519KeypairFromPrivate(options.ephemeralPrivateKey)
    : generateX25519Keypair();
  sym.mixHash(e.publicKey);
  const ee = x25519Dh(e.privateKey, re);
  sym.mixKey(ee);
  ee.fill(0);
  const encReply = sym.encryptAndHash(replyBytes);
  const message2 = new Uint8Array(Buffer.concat([Buffer.from(e.publicKey), Buffer.from(encReply)]));
  const { c1, c2, handshakeHash } = sym.split();
  return { clientPayload, message2, session: buildSession(c2, c1, handshakeHash) };
}

// ── Noise_IK_25519_ChaChaPoly_SHA256 (mutual zero-knowledge reconnect) ───────

export interface IkInitiatorState {
  completeMessage2(message2: Uint8Array): { payload: Uint8Array; session: NoiseSession };
}

export function startIkInitiator(options: {
  initiatorStaticKeypair: X25519Keypair;
  responderStaticPublicKey: Uint8Array;
  prologue?: Uint8Array;
  payload?: Uint8Array;
  ephemeralPrivateKey?: Uint8Array;
}): { message1: Uint8Array; state: IkInitiatorState } {
  const s = options.initiatorStaticKeypair;
  const rs = options.responderStaticPublicKey;
  if (!isCanonicalX25519PublicKey(rs)) {
    throw new NoiseError("invalid_public_key", "Responder static public key is invalid");
  }
  const e = options.ephemeralPrivateKey
    ? x25519KeypairFromPrivate(options.ephemeralPrivateKey)
    : generateX25519Keypair();
  const sym = new SymmetricState(NOISE_IK_PROTOCOL_NAME);
  sym.mixHash(options.prologue ?? LUMENBOX_RELAY_PROLOGUE);
  sym.mixHash(rs);

  // -> e, es, s, ss
  sym.mixHash(e.publicKey);
  const es = x25519Dh(e.privateKey, rs);
  sym.mixKey(es);
  es.fill(0);

  const encStatic = sym.encryptAndHash(s.publicKey);
  const ss = x25519Dh(s.privateKey, rs);
  sym.mixKey(ss);
  ss.fill(0);

  const encPayload = sym.encryptAndHash(options.payload ?? new Uint8Array(0));
  const message1 = new Uint8Array(
    Buffer.concat([Buffer.from(e.publicKey), Buffer.from(encStatic), Buffer.from(encPayload)]),
  );

  return {
    message1,
    state: {
      completeMessage2(message2: Uint8Array) {
        if (message2.byteLength < X25519_KEY_BYTES + CHACHAPOLY_TAG_BYTES) {
          throw new NoiseError("truncated_handshake", "Noise IK message 2 is truncated");
        }
        // <- e, ee, se
        const re = message2.subarray(0, X25519_KEY_BYTES);
        sym.mixHash(re);
        const ee = x25519Dh(e.privateKey, re);
        sym.mixKey(ee);
        ee.fill(0);
        const se = x25519Dh(s.privateKey, re);
        sym.mixKey(se);
        se.fill(0);
        const payload = sym.decryptAndHash(message2.subarray(X25519_KEY_BYTES));
        const { c1, c2, handshakeHash } = sym.split();
        return { payload, session: buildSession(c1, c2, handshakeHash) };
      },
    },
  };
}

export function respondIk(options: {
  responderStaticKeypair: X25519Keypair;
  message1: Uint8Array;
  prologue?: Uint8Array;
  admitInitiator?: (
    initiatorStaticPublicKey: Uint8Array,
    clientPayload: Uint8Array,
  ) => Uint8Array | undefined;
  responsePayload?: Uint8Array;
  ephemeralPrivateKey?: Uint8Array;
}): {
  initiatorStaticPublicKey: Uint8Array;
  clientPayload: Uint8Array;
  message2: Uint8Array;
  session: NoiseSession;
} {
  const minMessage1 = X25519_KEY_BYTES + (X25519_KEY_BYTES + CHACHAPOLY_TAG_BYTES) + CHACHAPOLY_TAG_BYTES;
  if (options.message1.byteLength < minMessage1) {
    throw new NoiseError("truncated_handshake", "Noise IK message 1 is truncated");
  }
  const s = options.responderStaticKeypair;
  const sym = new SymmetricState(NOISE_IK_PROTOCOL_NAME);
  sym.mixHash(options.prologue ?? LUMENBOX_RELAY_PROLOGUE);
  sym.mixHash(s.publicKey);

  // -> e, es, s, ss
  const re = options.message1.subarray(0, X25519_KEY_BYTES);
  sym.mixHash(re);
  const es = x25519Dh(s.privateKey, re);
  sym.mixKey(es);
  es.fill(0);

  const encStaticEnd = X25519_KEY_BYTES + X25519_KEY_BYTES + CHACHAPOLY_TAG_BYTES;
  const rs = sym.decryptAndHash(options.message1.subarray(X25519_KEY_BYTES, encStaticEnd));
  if (!isCanonicalX25519PublicKey(rs)) {
    throw new NoiseError("invalid_public_key", "Initiator static public key is invalid");
  }
  const ss = x25519Dh(s.privateKey, rs);
  sym.mixKey(ss);
  ss.fill(0);

  const clientPayload = sym.decryptAndHash(options.message1.subarray(encStaticEnd));
  const admittedReply = options.admitInitiator?.(rs, clientPayload);
  const replyBytes = admittedReply ?? options.responsePayload ?? new Uint8Array(0);

  // <- e, ee, se
  const e = options.ephemeralPrivateKey
    ? x25519KeypairFromPrivate(options.ephemeralPrivateKey)
    : generateX25519Keypair();
  sym.mixHash(e.publicKey);
  const ee = x25519Dh(e.privateKey, re);
  sym.mixKey(ee);
  ee.fill(0);
  const se = x25519Dh(e.privateKey, rs);
  sym.mixKey(se);
  se.fill(0);

  const encReply = sym.encryptAndHash(replyBytes);
  const message2 = new Uint8Array(Buffer.concat([Buffer.from(e.publicKey), Buffer.from(encReply)]));
  const { c1, c2, handshakeHash } = sym.split();
  return {
    initiatorStaticPublicKey: rs,
    clientPayload,
    message2,
    session: buildSession(c2, c1, handshakeHash),
  };
}
