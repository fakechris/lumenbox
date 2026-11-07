/**
 * Settings → Team → Guests and Settings → Guests (INV-1708, INV-1713, docs/97): who each agent
 * answers in group chats, the guest turns a group chat may have in a day, the short window, the
 * knowledge collections and which of them each agent may use, the group chats that hold answers
 * until the review passes, and the audit list of guest turns with their reviews. Admin only, like
 * the roster; a personal installation reads `available: false` and every write is refused,
 * because a personal installation answers no guests and has no switch that would make it.
 */

import { type GuestAnswerMode, type GuestDesk, GUEST_WINDOW_LIMIT } from "../host/guests.ts";
import { apiError } from "./api-error.ts";

export async function guestRoute(
  route: string,
  desk: GuestDesk,
  deps: {
    readJson: () => Promise<Record<string, unknown>>;
    refusedAdmin: () => boolean;
    agentIds: () => string[];
    installationMode: () => "single-machine" | "organisation";
    by: () => string;
    /** The request's query, for the audit list's filters. */
    query?: () => URLSearchParams;
    /** Sends an approved answer into its group chat. */
    send?: (chatKey: string, text: string) => Promise<{ delivered: boolean; why?: string }>;
  }
): Promise<{ status: number; body: unknown } | undefined> {
  if (!route.startsWith("GET /api/guests") && !route.startsWith("POST /api/guests")) return undefined;
  if (deps.refusedAdmin()) return { status: 0, body: null };
  const available = deps.installationMode() === "organisation";
  const state = () => ({
    available,
    agents: Object.fromEntries(deps.agentIds().map(id => [id, desk.modeOf(id)])),
    ticks: Object.fromEntries(deps.agentIds().map(id => [id, desk.ticksOf(id)])),
    perGroupPerDay: desk.cap(),
    window: desk.window(),
    windowLimit: GUEST_WINDOW_LIMIT,
    collections: desk.collections(),
    knowledge: desk.knowledge(),
    groups: desk.groups(),
    recent: desk.recentTurns(20),
  });
  if (route === "GET /api/guests") return { status: 200, body: available ? state() : { available } };
  if (!available) return { status: 409, body: apiError("guests-personal") };
  if (route === "GET /api/guests/audit") {
    const query = deps.query?.() ?? new URLSearchParams();
    const pick = (name: string) => { const value = query.get(name); return value === null || value === "" ? undefined : value; };
    const days = Number(pick("days") ?? 0);
    const since = Number.isFinite(days) && days > 0 ? new Date(Date.now() - days * 86_400_000).toISOString() : undefined;
    const chatKey = pick("chat"), agentId = pick("agent");
    const rows = desk.audit({ ...(chatKey !== undefined ? { chatKey } : {}), ...(agentId !== undefined ? { agentId } : {}), ...(since !== undefined ? { since } : {}), flagged: pick("flagged") === "1", held: pick("held") === "1" });
    return { status: 200, body: { rows, groups: desk.groups() } };
  }
  const body = await deps.readJson();
  const text = (key: string) => (typeof body[key] === "string" ? (body[key] as string) : "");
  if (route === "POST /api/guests/answers") {
    const id = String(body.id ?? "");
    if (!deps.agentIds().includes(id)) return { status: 404, body: apiError("agent-unknown", { agent: id }) };
    if (body.mode !== "members" && body.mode !== "guests") return { status: 400, body: apiError("guests-mode-unknown") };
    desk.setMode(id, body.mode as GuestAnswerMode, deps.by());
    return { status: 200, body: state() };
  }
  if (route === "POST /api/guests/cap") {
    const cap = Number(body.perGroupPerDay);
    if (!Number.isInteger(cap) || cap < 1) return { status: 400, body: apiError("guests-cap-invalid") };
    desk.setCap(cap, deps.by());
    return { status: 200, body: state() };
  }
  if (route === "POST /api/guests/window") {
    const exchanges = Number(body.exchanges), minutes = Number(body.minutes);
    if (!Number.isInteger(exchanges) || exchanges < 0 || exchanges > GUEST_WINDOW_LIMIT.exchanges || !Number.isInteger(minutes) || minutes < 1 || minutes > GUEST_WINDOW_LIMIT.minutes) {
      return { status: 400, body: apiError("guests-window-invalid", { ...GUEST_WINDOW_LIMIT }) };
    }
    desk.setWindow(exchanges, minutes, deps.by());
    return { status: 200, body: state() };
  }
  if (route === "POST /api/guests/collections") {
    if (text("name").trim() === "") return { status: 400, body: apiError("guests-collection-invalid") };
    desk.addCollection(text("name"), deps.by());
    return { status: 200, body: state() };
  }
  if (route === "POST /api/guests/collections/rename") {
    if (text("name").trim() === "") return { status: 400, body: apiError("guests-collection-invalid") };
    if (desk.renameCollection(text("id"), text("name"), deps.by()) === undefined) return { status: 404, body: apiError("guests-collection-unknown", { id: text("id") }) };
    return { status: 200, body: state() };
  }
  if (route === "POST /api/guests/collections/remove") {
    if (!desk.collections().some(collection => collection.id === text("id"))) return { status: 404, body: apiError("guests-collection-unknown", { id: text("id") }) };
    if (!desk.removeCollection(text("id"), deps.by())) return { status: 409, body: apiError("guests-collection-default") };
    return { status: 200, body: state() };
  }
  if (route === "POST /api/guests/ticks") {
    const id = String(body.id ?? "");
    if (!deps.agentIds().includes(id)) return { status: 404, body: apiError("agent-unknown", { agent: id }) };
    const ticked = Array.isArray(body.collections) ? body.collections.map(String) : [];
    const known = new Set(desk.collections().map(collection => collection.id));
    const unknown = ticked.find(tick => !known.has(tick));
    if (unknown !== undefined) return { status: 404, body: apiError("guests-collection-unknown", { id: unknown }) };
    desk.setTicks(id, ticked, deps.by());
    return { status: 200, body: state() };
  }
  if (route === "POST /api/guests/knowledge") {
    if (text("title").trim() === "" || text("text").trim() === "") return { status: 400, body: apiError("guests-entry-invalid") };
    const collection = text("collection") || undefined;
    if (collection !== undefined && !desk.collections().some(known => known.id === collection)) return { status: 404, body: apiError("guests-collection-unknown", { id: collection }) };
    desk.addKnowledge({ title: text("title"), text: text("text"), ...(collection !== undefined ? { collection } : {}) }, deps.by());
    return { status: 200, body: state() };
  }
  if (route === "POST /api/guests/knowledge/remove") {
    const id = String(body.id ?? "");
    if (!desk.removeKnowledge(id, deps.by())) return { status: 404, body: apiError("guests-entry-unknown", { id }) };
    return { status: 200, body: state() };
  }
  if (route === "POST /api/guests/hold") {
    if (text("door") === "" || text("chatKey") === "") return { status: 400, body: apiError("guests-group-invalid") };
    desk.setHold(text("door"), text("chatKey"), body.hold === true, deps.by());
    return { status: 200, body: state() };
  }
  if (route === "POST /api/guests/audit/approve" || route === "POST /api/guests/audit/discard") {
    const turnId = text("turnId");
    const held = desk.held(turnId);
    if (held === undefined) return { status: 404, body: apiError("guests-held-unknown", { id: turnId }) };
    if (route.endsWith("/approve")) {
      // Sent first, settled after: an answer that did not go out stays held, to be approved again.
      const sent = deps.send === undefined ? { delivered: false, why: "no channel can send" } : await deps.send(held.turn.chatKey, held.answer);
      if (!sent.delivered) return { status: 502, body: apiError("guests-send-failed", { why: sent.why ?? "" }) };
    }
    desk.settle(turnId, route.endsWith("/approve") ? "approved" : "discarded", deps.by());
    return { status: 200, body: { rows: desk.audit(), groups: desk.groups() } };
  }
  return undefined;
}
