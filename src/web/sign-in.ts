/**
 * How a person comes in through the web (INV-1701). There is one sign-in, with two ways to
 * present yourself: an invite code (`POST /api/login`), or a Feishu door (`/auth/<door>`, the
 * OAuth dance in `handleFeishuAuth`). Either way the answer is the same session cookie, issued to
 * a person already on the roster or admitted by the code; a Feishu account nobody linked gets the
 * knock instructions, never a session. Who the person is and what they may do is then
 * `GET /api/me` — the app's join window (electron/organisations.cjs) reads it, and so will an
 * organisation issuing node credentials to its Admins (INV-1697).
 *
 * What lives here is what both pages and the invite route need to agree on: which doors a person
 * may sign in through, how they appear on `/login`, and the link an Admin hands out.
 */

import type { Locale } from "../i18n/locale.ts";
import { tr } from "../i18n/messages.ts";

export type SignInDoor = { id: string; name: string };

/** Where `LOGIN_HTML` takes its doors: replaced by nothing when there are none. */
export const SIGN_IN_DOORS_MARKER = "<!--sign-in-doors-->";

/**
 * The doors a person may sign in through on the web: Feishu doors whose app is set, and only on an
 * installation with a public address — the vendor sends the person back to it, so without one the
 * button would lead to a refusal (`public-url-unset`). DingTalk joins when INV-729 lands.
 */
export function webSignInDoors(
  records: readonly { id: string; name: string; type: string }[],
  credentialsSet: (record: { id: string; type: string }) => boolean,
  publicUrl: string | undefined,
): SignInDoor[] {
  if (publicUrl === undefined || publicUrl.trim() === "") return [];
  return records.filter(record => record.type === "feishu" && credentialsSet(record)).map(record => ({ id: record.id, name: record.name || record.id }));
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

/** The sign-in page with one "Sign in with <door>" button per door, above the invite-code form. */
export function loginPageWithDoors(page: string, doors: readonly SignInDoor[], locale: Locale): string {
  if (doors.length === 0) return page.replace(SIGN_IN_DOORS_MARKER, "");
  const buttons = doors
    .map(door => `<a class="door" data-sign-in-door="${escapeHtml(door.id)}" href="/auth/${encodeURIComponent(door.id)}">${escapeHtml(tr("page.login.with-door", locale, { door: door.name }))}</a>`)
    .join("");
  return page.replace(SIGN_IN_DOORS_MARKER, `<div class="doors">${buttons}</div><p class="note">${escapeHtml(tr("page.login.or-code", locale))}</p>`);
}

/**
 * The invite as a link: `<public address>/login?code=…`, which the sign-in page fills in and the
 * app's "join an organisation" accepts as typed. Without a public address there is no link to give
 * — the address this server is bound to is wrong for anybody else — so the answer says why instead.
 */
export function invitationLink(publicUrl: string | undefined, code: string): { link: string } | { linkUnavailable: "public-url-unset" } {
  const base = publicUrl?.trim().replace(/\/+$/, "") ?? "";
  if (base === "") return { linkUnavailable: "public-url-unset" };
  return { link: `${base}/login?code=${encodeURIComponent(code)}` };
}
