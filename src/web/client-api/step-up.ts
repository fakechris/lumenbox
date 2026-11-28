/**
 * Step-up for a decision with an outside effect, answered from a phone (docs/110 §4, INV-2214).
 *
 * **When.** An approval whose action leaves the box or touches authority — the policy gate's own tiers
 * `reach`, `spend`, `credential`, `irreversible`, `run-later` (host/side-effects.ts), the ones the gate
 * asks a person about — and any approval whose tier the gate did not record (an extension's
 * confirmation, an Outbox draft, an approval from before the tier was kept): unknown is treated as
 * outside. Allowing it needs a proof; refusing it never does, because refusing has no effect to guard.
 *
 * **What the proof is.** At sign-in a device registers a P-256 public key (PR 1, `stepUpPublicKey`) whose
 * private half it created to require the person's biometrics for every use (iOS: Secure Enclave,
 * `.biometryCurrentSet`; Android: StrongBox/TEE, user authentication required for every use, invalidated
 * on a new enrolment). To allow, the device unlocks that key and signs, with ECDSA over SHA-256, the text
 *
 *     lumenbox-step-up/1\n<deviceId>\n<item id>\n<decision>\n<detail>
 *
 * — the decision bound to this device, this item, this answer, and for an edited draft the SHA-256 of
 * the words — and sends `{ keyId, signature }`, the signature DER or raw `r||s`, base64url. An item is
 * answered once, so a proof cannot be used twice.
 *
 * **What the server cannot know.** Whether the key really requires biometrics: that would need the
 * platform's attestation (App Attest, Android Key Attestation), which v1 does not check. What it checks
 * is possession of the key the device registered when its person signed in; the biometric requirement is
 * the app's to set when it creates the key, and the apps' contract says so (docs/110 §4).
 */

import { createHash, createPublicKey, verify } from "node:crypto";
import type { SideEffectTier } from "../../host/side-effects.ts";

/** The tiers whose approval needs a step-up: what the gate asks a person about, and a file run later by somebody else. */
const OUTSIDE: ReadonlySet<SideEffectTier> = new Set(["reach", "spend", "credential", "irreversible", "run-later"]);

/** Whether allowing an approval of this tier needs a step-up. Unknown is outside. */
export const stepUpRequiredFor = (tier: SideEffectTier | undefined): boolean => tier === undefined || OUTSIDE.has(tier);

/** The text a device signs. `detail`: the scope for an approval, the words' SHA-256 for an edited draft, else "-". */
export function stepUpText(deviceId: string, itemId: string, decision: string, detail = "-"): string {
  return `lumenbox-step-up/1\n${deviceId}\n${itemId}\n${decision}\n${detail}`;
}

export const wordsDigest = (words: string): string => createHash("sha256").update(words, "utf8").digest("base64url");

/** Whether `signature` (DER or raw r||s, base64url) is the registered key's signature over `text`. */
export function verifyStepUp(publicKey: string, text: string, signature: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKey, "base64url"), format: "der", type: "spki" });
    const bytes = Buffer.from(signature, "base64url");
    // Raw r||s is 64 bytes for P-256; a DER signature is longer and starts with a SEQUENCE.
    const dsaEncoding = bytes.length === 64 ? "ieee-p1363" : "der";
    return verify("sha256", Buffer.from(text, "utf8"), { key, dsaEncoding }, bytes);
  } catch {
    return false;
  }
}
