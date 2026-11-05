/** Each agent's spend lines and today's spend, read and set from the page (INV-1615): admin only, like the roster. */

import type { SpendLimitConfig, SpendLimits, SpendToday } from "../host/spend-limits.ts";

export async function spendLimitRoute(
  route: string,
  limits: SpendLimits,
  deps: { readJson: () => Promise<Record<string, unknown>>; refusedAdmin: () => boolean; agentIds: () => string[] }
): Promise<{ status: number; body: unknown } | undefined> {
  if (route === "GET /api/agents/spend-limits") {
    if (deps.refusedAdmin()) return { status: 0, body: null };
    const agents: Record<string, SpendToday> = Object.fromEntries(deps.agentIds().map(id => [id, limits.today(id)]));
    return { status: 200, body: { agents, pausedForSpend: limits.pausedForSpend() } };
  }
  if (route !== "POST /api/agents/spend-limits") return undefined;
  if (deps.refusedAdmin()) return { status: 0, body: null };
  const body = await deps.readJson();
  const id = String(body.id ?? "");
  if (!deps.agentIds().includes(id)) return { status: 404, body: { error: `No agent ${id}` } };
  // null, or an empty object, puts the agent back on the defaults; a number sets that one line.
  const asked: Partial<SpendLimitConfig> = {};
  for (const key of ["perDay", "perWake", "perDayTokens", "perWakeTokens"] as const) {
    const raw = body[key];
    if (raw === undefined || raw === null || raw === "") continue;
    asked[key] = Number(raw);
  }
  try {
    limits.setLimits(id, body.limits === null || Object.keys(asked).length === 0 ? null : asked);
  } catch (error) {
    return { status: 400, body: { error: error instanceof Error ? error.message : String(error) } };
  }
  return { status: 200, body: limits.today(id) };
}
