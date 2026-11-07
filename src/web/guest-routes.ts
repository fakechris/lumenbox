/**
 * Settings → Team → Guests (INV-1708, docs/97): who each agent answers in group chats, the guest
 * turns a group chat may have in a day, and the knowledge public to guests. Admin only, like the
 * roster; a personal installation reads `available: false` and every write is refused, because a
 * personal installation answers no guests and has no switch that would make it.
 */

import type { GuestAnswerMode, GuestDesk } from "../host/guests.ts";
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
  }
): Promise<{ status: number; body: unknown } | undefined> {
  if (!route.startsWith("GET /api/guests") && !route.startsWith("POST /api/guests")) return undefined;
  if (deps.refusedAdmin()) return { status: 0, body: null };
  const available = deps.installationMode() === "organisation";
  const state = () => ({
    available,
    agents: Object.fromEntries(deps.agentIds().map(id => [id, desk.modeOf(id)])),
    perGroupPerDay: desk.cap(),
    knowledge: desk.knowledge(),
    recent: desk.recentTurns(20),
  });
  if (route === "GET /api/guests") return { status: 200, body: available ? state() : { available } };
  if (!available) return { status: 409, body: apiError("guests-personal") };
  const body = await deps.readJson();
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
  if (route === "POST /api/guests/knowledge") {
    const title = typeof body.title === "string" ? body.title : "";
    const text = typeof body.text === "string" ? body.text : "";
    if (title.trim() === "" || text.trim() === "") return { status: 400, body: apiError("guests-entry-invalid") };
    desk.addKnowledge({ title, text }, deps.by());
    return { status: 200, body: state() };
  }
  if (route === "POST /api/guests/knowledge/remove") {
    const id = String(body.id ?? "");
    if (!desk.removeKnowledge(id, deps.by())) return { status: 404, body: apiError("guests-entry-unknown", { id }) };
    return { status: 200, body: state() };
  }
  return undefined;
}
