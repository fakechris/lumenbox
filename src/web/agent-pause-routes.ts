/** Pause and resume an agent from the page (INV-1554): admin only, like the roster. */

import type { AgentPauses } from "../host/agent-pause.ts";
import { apiError } from "./api-error.ts";

export async function agentPauseRoute(
  route: string,
  pauses: AgentPauses,
  deps: { readJson: () => Promise<Record<string, unknown>>; refusedAdmin: () => boolean; agentIds: () => string[]; caller: () => string }
): Promise<{ status: number; body: unknown } | undefined> {
  if (route === "GET /api/agents/pauses") {
    if (deps.refusedAdmin()) return { status: 0, body: null };
    return { status: 200, body: { paused: Object.fromEntries(deps.agentIds().flatMap(id => { const pause = pauses.pauseOf(id); return pause === undefined ? [] : [[id, pause]]; })) } };
  }
  if (route !== "POST /api/agents/pause" && route !== "POST /api/agents/resume") return undefined;
  if (deps.refusedAdmin()) return { status: 0, body: null };
  const body = await deps.readJson();
  const id = String(body.id ?? "");
  if (!deps.agentIds().includes(id)) return { status: 404, body: apiError("agent-unknown", { agent: id }) };
  if (route === "POST /api/agents/pause") {
    if (pauses.pauseOf(id) !== undefined) return { status: 200, body: { paused: true, already: true } };
    const done = await pauses.pause(id, deps.caller(), String(body.reason ?? "").trim().slice(0, 200));
    return { status: 200, body: { paused: true, ...done } };
  }
  return { status: 200, body: { resumed: await pauses.resume(id, deps.caller()) } };
}
