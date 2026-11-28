/**
 * A person's phones on the page (docs/110 §4, INV-2214): Settings → Mine → Phones. Internal routes,
 * like the token routes beside them; the phone itself uses `/api/v1` (client-api/auth.ts).
 *
 * - `POST /api/devices/pairing`: a pairing code and its QR code, for two minutes, once. Only after a
 *   sign-in in the last ten minutes (recent-sign-in.ts): a copied cookie must not become a phone that
 *   stays signed in for months. The QR code holds `lumenbox://pair#server=<origin>&code=<code>` — in the
 *   fragment, so nothing on the way logs it.
 * - `GET /api/devices`: the person's signed-in devices. Never a token.
 * - `POST /api/devices/remove` (`id`): ends one — the person's own, or anyone's for an Admin.
 *
 * Any role may pair a phone: a device credential never raises what its person may do.
 */

import { type Principals, type Role, roleAtLeast, soleAdmin } from "../host/principals.ts";
import { type ApiError, apiError } from "./api-error.ts";
import type { DeviceView } from "./device-credentials.ts";
import type { PairingFor } from "./device-sign-in.ts";
import { QR_MAX_BYTES, qrSvg } from "./qr.ts";

export interface DeviceRouteDeps {
  readJson(): Promise<Record<string, unknown>>;
  /** Who is signed in; absent for the installation's own credential (the operator). */
  userId: string | undefined;
  role: Role;
  principals: Pick<Principals, "list" | "resolve" | "isKnown">;
  devices: {
    showPairing(pairing: PairingFor, by: string): { code: string; expiresAt: number };
    list(principalId: string): DeviceView[];
    remove(id: string, by: string, may: (device: { principalId: string }) => boolean): boolean;
  };
  freshSignIn(): { ok: true; signedInAt?: string } | { ok: false; error: ApiError };
  publicUrl(): string | undefined;
}

type Answer = { status: number; body: unknown };

export async function deviceRoute(route: string, deps: DeviceRouteDeps): Promise<Answer | undefined> {
  if (route !== "GET /api/devices" && route !== "POST /api/devices/pairing" && route !== "POST /api/devices/remove") return undefined;
  // Nobody signed in is the installation's one Admin (INV-1681), as for tokens.
  const me = deps.userId === undefined ? soleAdmin(deps.principals.list()) : deps.principals.isKnown(deps.userId) ? deps.principals.resolve(deps.userId).id : undefined;
  if (me === undefined) return { status: 400, body: apiError("token-needs-person", { admins: deps.principals.list().filter(person => person.role === "admin").length }) };

  if (route === "GET /api/devices") return { status: 200, body: { devices: deps.devices.list(me) } };

  if (route === "POST /api/devices/remove") {
    const body = await deps.readJson().catch(() => undefined);
    if (body === undefined || body === null || typeof body !== "object" || Array.isArray(body)) return { status: 400, body: apiError("body-invalid") };
    const isAdmin = roleAtLeast(deps.role, "admin");
    const done = deps.devices.remove(String(body.id ?? ""), deps.userId ?? "operator", device => isAdmin || device.principalId === me);
    return done ? { status: 200, body: { removed: true } } : { status: 404, body: apiError("device-unknown") };
  }

  const fresh = deps.freshSignIn();
  if (!fresh.ok) return { status: 403, body: fresh.error };
  const origin = deps.publicUrl()?.trim().replace(/\/+$/, "") ?? "";
  // The phone needs an address it can reach: this installation's public one.
  if (origin === "") return { status: 503, body: apiError("public-url-unset") };
  // And one a QR code can hold with the code beside it (43 characters): refused before any code is made.
  const linkOf = (code: string) => `lumenbox://pair#server=${encodeURIComponent(origin)}&code=${code}`;
  if (Buffer.byteLength(linkOf("x".repeat(43))) > QR_MAX_BYTES) return { status: 503, body: apiError("public-url-too-long", { bytes: QR_MAX_BYTES }) };
  const pairing: PairingFor = deps.userId === undefined
    ? { principalId: me, identity: me, via: "person" }
    : { principalId: me, identity: deps.userId, via: "sign-in", ...(fresh.signedInAt !== undefined ? { signedInAt: fresh.signedInAt } : {}) };
  const shown = deps.devices.showPairing(pairing, deps.userId ?? "operator");
  const link = linkOf(shown.code);
  return { status: 200, body: { link, expiresAt: new Date(shown.expiresAt).toISOString(), qrSvg: qrSvg(link) } };
}
