/**
 * A recent sign-in, for what outlives the session it is asked from (INV-2318, INV-2214).
 *
 * Minting a token — a personal or service token for `/api/v1`, a side-door token — and starting a
 * phone's pairing each turn a page session into a credential that lives on without it: a token for up
 * to a year, a phone's refresh token for months. A session cookie lasts thirty days, so a cookie
 * somebody copied would otherwise buy a credential that survives signing that person out. These ask
 * for a sign-in made in the last ten minutes instead, read from the time the session cookie signs
 * (session.ts); a cookie from before that field reads the page as it did and mints nothing.
 *
 * Who is not asked: the installation's own credential (the operator: on the local level the token
 * holder, off it only the server's own machine, exposure.ts R2), and a person a gateway vouches for on
 * every request (the control plane's sign-in is its own). On the local level nobody is asked: there is
 * one person on one machine, and nothing changes for them.
 */

import { type ApiError, apiError } from "./api-error.ts";
import type { ExposureLevel } from "./exposure.ts";

/** How recent: ten minutes. Long enough to sign in and press the button; short enough that a copied cookie is stale. */
export const RECENT_SIGN_IN_SECONDS = 10 * 60;

/** How the request in hand says who it is. */
export type SignInProof = { via: "operator" } | { via: "gateway" } | { via: "session"; signedAt?: number };

/** Yes, with the sign-in time a record names (absent when nobody signed in); or the refusal to answer with 403. */
export function recentSignIn(level: ExposureLevel, proof: SignInProof, now: Date = new Date()): { ok: true; signedInAt?: string } | { ok: false; error: ApiError } {
  if (proof.via !== "session") return { ok: true };
  const signedInAt = proof.signedAt === undefined ? undefined : new Date(proof.signedAt * 1000).toISOString();
  if (level === "local") return { ok: true, ...(signedInAt !== undefined ? { signedInAt } : {}) };
  const age = proof.signedAt === undefined ? Number.POSITIVE_INFINITY : now.getTime() / 1000 - proof.signedAt;
  // A time in the future is a clock that moved, not a fresh sign-in: allowed only within a minute of now.
  if (age <= RECENT_SIGN_IN_SECONDS && age >= -60) return { ok: true, signedInAt: signedInAt! };
  return { ok: false, error: apiError("sign-in-again", { minutes: RECENT_SIGN_IN_SECONDS / 60 }) };
}
