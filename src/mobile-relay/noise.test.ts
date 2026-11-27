import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CipherState,
  generateX25519Keypair,
  isCanonicalX25519PublicKey,
  LUMENBOX_RELAY_PROLOGUE,
  NoiseError,
  respondIk,
  respondNk,
  startIkInitiator,
  startNkInitiator,
  x25519KeypairFromPrivate,
} from "./noise.ts";
import {
  CHUNK_FLAG_FINAL,
  CHUNK_FLAG_FIRST,
  MAX_CHUNK_DATA_BYTES,
  openRecord,
  RECORD_KIND_BINARY,
  RECORD_KIND_TEXT,
  RecordFrameError,
  sealRecord,
} from "./records.ts";

// Official Noise Protocol Framework (Revision 34) vectors from rweather/noise-c cacophony.txt
const NK_VECTORS = [
  {
    prologue: "4a6f686e2047616c74",
    initEphemeral: "893e28b9dc6ca8d611ab664754b8ceb7bac5117349a4439a6b0569da977c464a",
    respStatic: "4a3acbfdb163dec651dfa3194dece676d437029c62a408b4c5ea9114246e4893",
    respStaticPub: "31e0303fd6418d2f8c0e78b91f22e8caed0fbe48656dcf4767e4834f701b8f62",
    respEphemeral: "bbdb4cdbd309f1a1f2e1456967fe288cadd6f712d65dc7b7793d5e63da6b375b",
    messages: [
      {
        payload: "4c756477696720766f6e204d69736573",
        ciphertext:
          "ca35def5ae56cec33dc2036731ab14896bc4c75dbb07a61f879f8e3afa4c79448134d00711fdb390a0d178fa008f6d47d2891e5ea18ae136c3b4c23ac384efb0",
      },
      {
        payload: "4d757272617920526f746862617264",
        ciphertext:
          "95ebc60d2b1fa672c1f46a8aa265ef51bfe38e7ccb39ec5be34069f1448088438ea16e3701bc0d77744f117bee22451c9afa7f4cdbbcff00c04a8ee0913c88",
      },
      {
        payload: "462e20412e20486179656b",
        ciphertext: "a62de29ce27cb80245d440d986ed816c156e9d757d7008df2198b0",
      },
      {
        payload: "4361726c204d656e676572",
        ciphertext: "174a35f11c689f4530d7208618e0564ae12f2f50ba8eb4df5382ff",
      },
      {
        payload: "4a65616e2d426170746973746520536179",
        ciphertext: "337e475ebb8eae60f91974c4e455a5af38d1d8628d1803b160d60442874b0a1777",
      },
      {
        payload: "457567656e2042f6686d20766f6e2042617765726b",
        ciphertext: "047e80e060b7bb08b53c5a23dfe9920cae135b9d1dc6302fc475003062723700366346ac9d",
      },
    ],
  },
];

const hex = (s: string) => new Uint8Array(Buffer.from(s, "hex"));
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

test("Noise_NK_25519_ChaChaPoly_SHA256 matches official specification test vectors byte-for-byte", () => {
  for (const vec of NK_VECTORS) {
    const respKp = x25519KeypairFromPrivate(hex(vec.respStatic));
    assert.equal(toHex(respKp.publicKey), vec.respStaticPub);

    const prologue = hex(vec.prologue);
    const m0 = vec.messages[0]!;
    const m1 = vec.messages[1]!;

    const { message1, state } = startNkInitiator({
      responderStaticPublicKey: respKp.publicKey,
      prologue,
      payload: hex(m0.payload),
      ephemeralPrivateKey: hex(vec.initEphemeral),
    });
    assert.equal(toHex(message1), m0.ciphertext);

    const resp = respondNk({
      responderStaticKeypair: respKp,
      message1,
      prologue,
      responsePayload: hex(m1.payload),
      ephemeralPrivateKey: hex(vec.respEphemeral),
    });
    assert.equal(toHex(resp.clientPayload), m0.payload);
    assert.equal(toHex(resp.message2), m1.ciphertext);

    const initDone = state.completeMessage2(resp.message2);
    assert.equal(toHex(initDone.payload), m1.payload);
    assert.equal(toHex(initDone.session.handshakeHash), toHex(resp.session.handshakeHash));

    // Alternating transport messages (2..5)
    for (let i = 2; i < vec.messages.length; i++) {
      const msg = vec.messages[i]!;
      if (i % 2 === 0) {
        const ct = initDone.session.send.encryptWithAd(new Uint8Array(0), hex(msg.payload));
        assert.equal(toHex(ct), msg.ciphertext);
        const pt = resp.session.receive.decryptWithAd(new Uint8Array(0), ct);
        assert.equal(toHex(pt), msg.payload);
      } else {
        const ct = resp.session.send.encryptWithAd(new Uint8Array(0), hex(msg.payload));
        assert.equal(toHex(ct), msg.ciphertext);
        const pt = initDone.session.receive.decryptWithAd(new Uint8Array(0), ct);
        assert.equal(toHex(pt), msg.payload);
      }
    }
    initDone.session.destroy();
    resp.session.destroy();
  }
});

test("Noise_IK_25519_ChaChaPoly_SHA256 hides client static key on the wire, authenticates mutually, and rejects revoked keys", () => {
  const hostKp = x25519KeypairFromPrivate(
    hex("1111111111111111111111111111111111111111111111111111111111111111"),
  );
  const phoneKp = x25519KeypairFromPrivate(
    hex("2222222222222222222222222222222222222222222222222222222222222222"),
  );

  const { message1, state } = startIkInitiator({
    initiatorStaticKeypair: phoneKp,
    responderStaticPublicKey: hostKp.publicKey,
    prologue: LUMENBOX_RELAY_PROLOGUE,
    payload: Buffer.from("hello-mac", "utf8"),
  });

  // Phone's static public key must be encrypted inside message1, never visible in cleartext!
  assert.equal(Buffer.from(message1).includes(Buffer.from(phoneKp.publicKey)), false);

  const resp = respondIk({
    responderStaticKeypair: hostKp,
    message1,
    prologue: LUMENBOX_RELAY_PROLOGUE,
    admitInitiator: (clientPub, payload) => {
      assert.equal(toHex(clientPub), toHex(phoneKp.publicKey));
      assert.equal(Buffer.from(payload).toString("utf8"), "hello-mac");
      return Buffer.from("admitted-ok", "utf8");
    },
  });

  const init = state.completeMessage2(resp.message2);
  assert.equal(Buffer.from(init.payload).toString("utf8"), "admitted-ok");
  assert.equal(toHex(init.session.handshakeHash), toHex(resp.session.handshakeHash));

  // Revoked / unknown device rejection inside admitInitiator
  assert.throws(
    () =>
      respondIk({
        responderStaticKeypair: hostKp,
        message1,
        prologue: LUMENBOX_RELAY_PROLOGUE,
        admitInitiator: () => {
          throw new NoiseError("device_revoked", "Device revoked");
        },
      }),
    (err: unknown) => err instanceof NoiseError && err.code === "device_revoked",
  );

  // Wrong host key fails authenticated decryption
  const wrongHostKp = generateX25519Keypair();
  assert.throws(
    () => respondIk({ responderStaticKeypair: wrongHostKp, message1 }),
    (err: unknown) => err instanceof NoiseError && err.code === "decrypt_failed",
  );

  init.session.destroy();
  resp.session.destroy();
});

test("isCanonicalX25519PublicKey rejects low-order torsion points and coordinates >= 2^255 - 19", () => {
  const valid = generateX25519Keypair().publicKey;
  assert.equal(isCanonicalX25519PublicKey(valid), true);

  // Low-order points
  assert.equal(isCanonicalX25519PublicKey(new Uint8Array(32)), false);
  const one = new Uint8Array(32);
  one[0] = 1;
  assert.equal(isCanonicalX25519PublicKey(one), false);
  assert.equal(
    isCanonicalX25519PublicKey(
      hex("e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800"),
    ),
    false,
  );
  assert.equal(
    isCanonicalX25519PublicKey(
      hex("ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f"),
    ),
    false,
  );

  // Non-canonical (>= p = 2^255 - 19)
  assert.equal(
    isCanonicalX25519PublicKey(
      hex("edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f"),
    ),
    false,
  );
  assert.equal(isCanonicalX25519PublicKey(new Uint8Array(32).fill(0xff)), false);
});

test("AEAD record framing handles multi-chunk payloads and rejects replay, reordering, tampering, and 4 GiB forged headers without allocating", () => {
  const key = new Uint8Array(32).fill(0x42);
  const sender = new CipherState(key);
  const receiver = new CipherState(key);

  // Multi-chunk round trip (> 2 * MAX_CHUNK_DATA_BYTES)
  const big = new Uint8Array(MAX_CHUNK_DATA_BYTES * 2 + 1234);
  for (let i = 0; i < big.byteLength; i++) big[i] = i & 0xff;

  const wire = sealRecord(sender, { kind: RECORD_KIND_BINARY, streamId: 7, payload: big });
  const opened = openRecord(receiver, wire);
  assert.equal(opened.kind, RECORD_KIND_BINARY);
  assert.equal(opened.streamId, 7);
  assert.deepEqual(opened.payload, big);

  // Replay of the exact same wire record fails because receiver counter advanced!
  assert.throws(
    () => openRecord(receiver, wire),
    (err: unknown) => err instanceof RecordFrameError && err.code === "decrypt_failed",
  );

  // Out-of-order delivery fails
  const wireA = sealRecord(sender, {
    kind: RECORD_KIND_TEXT,
    streamId: 1,
    payload: Buffer.from("A"),
  });
  const wireB = sealRecord(sender, {
    kind: RECORD_KIND_TEXT,
    streamId: 1,
    payload: Buffer.from("B"),
  });
  assert.throws(
    () => openRecord(receiver, wireB),
    (err: unknown) => err instanceof RecordFrameError && err.code === "decrypt_failed",
  );
  // Receiver counter did NOT advance on failed authentication, so wireA still opens cleanly!
  const openedA = openRecord(receiver, wireA);
  assert.equal(Buffer.from(openedA.payload).toString("utf8"), "A");
  const openedB = openRecord(receiver, wireB);
  assert.equal(Buffer.from(openedB.payload).toString("utf8"), "B");

  // Forged plaintext header claiming 4 GiB (0xffff_ffff) inside a valid AEAD ciphertext is
  // rejected BEFORE allocating any 4 GiB buffer!
  const badPlain = Buffer.alloc(15, 0);
  badPlain[0] = RECORD_KIND_BINARY;
  badPlain[1] = CHUNK_FLAG_FIRST | CHUNK_FLAG_FINAL;
  badPlain.writeUInt32BE(0xffff_ffff, 2); // 4 GiB claim!
  badPlain.writeUInt32BE(9, 6);
  const forgedCt = sender.encryptWithAd(new Uint8Array(0), badPlain);
  const forgedWire = Buffer.allocUnsafe(2 + forgedCt.byteLength);
  forgedWire.writeUInt16BE(forgedCt.byteLength, 0);
  forgedWire.set(forgedCt, 2);

  const rssBefore = process.memoryUsage().heapUsed;
  assert.throws(
    () => openRecord(receiver, forgedWire),
    (err: unknown) => err instanceof RecordFrameError && err.code === "length_mismatch",
  );
  const rssDelta = process.memoryUsage().heapUsed - rssBefore;
  assert.ok(rssDelta < 5 * 1024 * 1024, `expected zero large allocation, heap delta=${rssDelta}`);

  // Reserved flags rejected
  const rsvPlain = Buffer.alloc(10, 0);
  rsvPlain[0] = RECORD_KIND_TEXT;
  rsvPlain[1] = CHUNK_FLAG_FIRST | CHUNK_FLAG_FINAL | 0x80;
  const rsvCt = sender.encryptWithAd(new Uint8Array(0), rsvPlain);
  const rsvWire = Buffer.allocUnsafe(2 + rsvCt.byteLength);
  rsvWire.writeUInt16BE(rsvCt.byteLength, 0);
  rsvWire.set(rsvCt, 2);
  assert.throws(
    () => openRecord(receiver, rsvWire),
    (err: unknown) => err instanceof RecordFrameError && err.code === "reserved_flags",
  );
});
