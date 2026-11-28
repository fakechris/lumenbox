/**
 * `/auth/*` and `/devices` (docs/106 §4.2–4.3, docs/110 §4, INV-2214): how a person's phone or desktop
 * client signs in — through an organisation's channel with PKCE, or with a pairing code a signed-in
 * page showed — keeps itself signed in with a rotating refresh token, and how the person sees and ends
 * their devices. What it reads and changes comes through `DeviceAuth`, wired in mount.ts.
 */

import { createPublicKey } from "node:crypto";
import type { Locale } from "../../i18n/locale.ts";
import type { DeviceSignInInput, DeviceStore, DeviceView, IssuedTokens } from "../device-credentials.ts";
import { type DoorOutcome, isAppRedirect, type PairingFor } from "../device-sign-in.ts";
import type { ClientCredential } from "../mcp-tokens.ts";
import type { Call } from "./frame.ts";
import { refuse } from "./frame.ts";
import { meOf } from "./me.ts";
import { DEVICE_SCOPES } from "./schema.ts";
import { apiTime } from "./times.ts";
import { decodeCursor, encodeCursor, limitOf } from "./visibility.ts";

type Holder = { principalId: string; identity: string; via: "sign-in" | "person" };

/** What the auth and device operations read and change (mount.ts wires it to the server's objects). */
export interface DeviceAuth {
  /** The channels a device signs in through here, named in this language. */
  providers(locale: Locale): { id: string; type: string; displayName: string }[];
  /** A sign-in begins: the address the app opens, or undefined when `providerId` does not sign a device in here. */
  start(input: { providerId: string; codeChallenge: string; redirectUri: string; state?: string }): { authorizationUrl: string; expiresAt: number } | undefined;
  exchange(code: string, verifier: string, check: { providerId?: string; redirectUri: string }): (DoorOutcome & { providerId: string }) | undefined;
  pair(code: string): PairingFor | undefined;
  /** Whether a device's sign-in is still its person's: they are on the roster, and the sign-in it came from is still one of theirs. */
  holds(holder: Holder): boolean;
  signIn(input: DeviceSignInInput): { device: DeviceView; tokens: IssuedTokens };
  credentialOf(accessToken: string): ClientCredential | undefined;
  refresh(refreshToken: string): ReturnType<DeviceStore["refresh"]>;
  list(principalId: string): DeviceView[];
  remove(id: string, why: "removed" | "signed-out", by: string, may: (device: DeviceView) => boolean): boolean;
  /** A device's credential was ended here: open streams and desktops let go of it now. */
  ended(): void;
  /** A person signed in on a device: their own computer is made now if they are owed one and have none (INV-2203). */
  arrived(personId: string, locale: Locale): void;
  /** What a person whose request waits for an Admin is told, in this language. */
  askedWords(locale: Locale): string;
}

export function listAuthProviders(call: Call) {
  return { items: call.deps.devices.providers(call.locale) };
}

export function startOAuth(call: Call) {
  const body = call.body as { provider: string; codeChallenge: string; codeChallengeMethod: string; redirectUri: string; state?: string };
  if (body.codeChallengeMethod !== "S256") return refuse("api-param-invalid", { name: "codeChallengeMethod", why: "S256" });
  if (!call.deps.devices.providers(call.locale).some(provider => provider.id === body.provider)) return refuse("auth-provider-unknown");
  if (!isAppRedirect(body.redirectUri)) return refuse("auth-redirect-invalid");
  const started = call.deps.devices.start({ providerId: body.provider, codeChallenge: body.codeChallenge, redirectUri: body.redirectUri, ...(body.state !== undefined ? { state: body.state } : {}) });
  if (started === undefined) return refuse("auth-provider-unknown");
  return { authorizationUrl: started.authorizationUrl, ...(body.state !== undefined ? { state: body.state } : {}), expiresAt: apiTime(new Date(started.expiresAt).toISOString()) };
}

/** The device's own description of itself, checked: a name, a platform, and a step-up key that is a P-256 public key, or none. */
function deviceOf(body: Record<string, unknown>): { name: string; platform: string; stepUpKey?: { id: string; publicKey: string } } {
  const platform = String(body.platform);
  if (!/^[a-z0-9-]{1,20}$/.test(platform)) return refuse("api-param-invalid", { name: "platform", why: "a lower-case word, at most 20 characters" });
  const keyId = body.stepUpKeyId as string | undefined, publicKey = body.stepUpPublicKey as string | undefined;
  if ((keyId === undefined) !== (publicKey === undefined)) return refuse("api-param-invalid", { name: keyId === undefined ? "stepUpKeyId" : "stepUpPublicKey", why: "given with the other" });
  if (publicKey !== undefined) {
    try {
      const key = createPublicKey({ key: Buffer.from(publicKey, "base64url"), format: "der", type: "spki" });
      if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error("not P-256");
    } catch {
      return refuse("api-param-invalid", { name: "stepUpPublicKey", why: "a P-256 public key, SubjectPublicKeyInfo DER in base64url" });
    }
  }
  return { name: String(body.deviceName), platform, ...(keyId !== undefined && publicKey !== undefined ? { stepUpKey: { id: keyId, publicKey } } : {}) };
}

function tokensOf(tokens: IssuedTokens, now: Date) {
  return {
    deviceId: tokens.deviceId, tokenType: "Bearer", accessToken: tokens.accessToken,
    expiresInSeconds: Math.max(0, Math.round((Date.parse(tokens.accessTokenExpiresAt) - now.getTime()) / 1000)),
    accessTokenExpiresAt: apiTime(tokens.accessTokenExpiresAt), refreshToken: tokens.refreshToken, refreshTokenExpiresAt: apiTime(tokens.refreshTokenExpiresAt), scopes: [...tokens.scopes],
  };
}

/** A person let in, on this device: a device credential, their own computer on its way, and who they are as `GET /me` says it. */
function signedIn(call: Call, holder: Holder & { signedInAt?: string }, method: "oauth" | "pairing", providerId?: string) {
  const { devices } = call.deps;
  const person = call.deps.person(holder.principalId);
  if (person === undefined || !devices.holds(holder)) return refuse("access-removed");
  const made = devices.signIn({
    ...holder, method, ...(providerId !== undefined ? { providerId } : {}), ...deviceOf(call.body), scopes: DEVICE_SCOPES,
    by: method === "pairing" ? holder.principalId : holder.identity,
  });
  call.signInSucceeded(person.id);
  devices.arrived(person.id, call.locale);
  const credential = devices.credentialOf(made.tokens.accessToken)!;
  return { status: "authenticated", tokens: tokensOf(made.tokens, new Date()), me: meOf({ ...call, caller: { credential, person } }) };
}

export function exchangeOAuthCode(call: Call) {
  const body = call.body as { code: string; codeVerifier: string; provider?: string; redirectUri: string };
  deviceOf(call.body); // a malformed device description is refused before the code is spent
  const outcome = call.deps.devices.exchange(body.code, body.codeVerifier, { ...(body.provider !== undefined ? { providerId: body.provider } : {}), redirectUri: body.redirectUri });
  if (outcome === undefined || outcome.kind === "refused") { call.signInFailed("auth-code"); return refuse("auth-code-invalid"); }
  if (outcome.kind === "asked") return { status: "asked_to_join", message: call.deps.devices.askedWords(call.locale) };
  return signedIn(call, { principalId: outcome.principalId, identity: outcome.identity, via: "sign-in" }, "oauth", outcome.providerId);
}

export function pairDevice(call: Call) {
  deviceOf(call.body);
  const pairing = call.deps.devices.pair(String(call.body.code));
  if (pairing === undefined) { call.signInFailed("pairing-code"); return refuse("pairing-code-invalid"); }
  return signedIn(call, pairing, "pairing");
}

export function refreshDeviceToken(call: Call) {
  const found = call.deps.devices.refresh(String(call.body.refreshToken));
  if ("refused" in found) {
    if (found.refused === "invalid") { call.signInFailed("unknown-refresh-token"); return refuse("api-credential-invalid"); }
    if (found.refused === "expired") return refuse("api-credential-expired");
    if (found.refused === "superseded") return refuse("refresh-superseded");
    // Removed, or spent and back again: the device is over, for whoever holds its tokens; its streams close now.
    if (found.refused === "reused") call.deps.devices.ended();
    return refuse("access-removed");
  }
  return tokensOf(found.tokens, new Date());
}

export function signOutDevice(call: Call) {
  const { credential, person } = call.caller!;
  if (credential.kind !== "device") return refuse("device-credential-needed");
  call.deps.devices.remove(credential.id, "signed-out", person.id, () => true);
  call.deps.devices.ended();
  return { id: credential.id, endedAt: apiTime(new Date().toISOString()) };
}

const position = (value: unknown): value is string => typeof value === "string";

export function listDevices(call: Call) {
  const { credential, person } = call.caller!;
  const all = call.deps.devices.list(person.id);
  const after = decodeCursor(call.params.cursor, "devices", position);
  const rest = after === undefined ? all : all.slice(all.findIndex(device => device.id === after) + 1);
  const page = rest.slice(0, limitOf(call));
  return {
    items: page.map(device => ({
      id: device.id, name: device.name, platform: device.platform, signInMethod: device.method, ...(device.providerId !== undefined ? { providerId: device.providerId } : {}),
      scopes: [...device.scopes], createdAt: apiTime(device.createdAt), ...(device.lastUsedAt !== undefined ? { lastUsedAt: apiTime(device.lastUsedAt) } : {}),
      current: credential.kind === "device" && credential.id === device.id, stepUpKey: device.hasStepUpKey,
    })),
    ...(rest.length > page.length ? { nextCursor: encodeCursor(page.at(-1)!.id, "devices") } : {}),
  };
}

export function deleteDevice(call: Call) {
  const { person } = call.caller!;
  const id = String(call.params.id);
  // Only the person's own: another person's device is not theirs to know of.
  if (!call.deps.devices.remove(id, "removed", person.id, device => device.principalId === person.id)) return refuse("api-not-found");
  call.deps.devices.ended();
  return { id, endedAt: apiTime(new Date().toISOString()) };
}
