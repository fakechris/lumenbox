/** Each agent's daily allowance for unprompted pushes, read and set from the page (INV-1576): admin only, like the roster. */

import type { PushBudget, PushCounts } from "../host/push-budget.ts";

export async function pushBudgetRoute(
  route: string,
  budget: PushBudget,
  deps: { readJson: () => Promise<Record<string, unknown>>; refusedAdmin: () => boolean; agentIds: () => string[] }
): Promise<{ status: number; body: unknown } | undefined> {
  if (route === "GET /api/agents/push-budget") {
    if (deps.refusedAdmin()) return { status: 0, body: null };
    const agents: Record<string, PushCounts> = Object.fromEntries(deps.agentIds().map(id => [id, budget.counts(id)]));
    return { status: 200, body: { agents } };
  }
  if (route !== "POST /api/agents/push-budget") return undefined;
  if (deps.refusedAdmin()) return { status: 0, body: null };
  const body = await deps.readJson();
  const id = String(body.id ?? "");
  if (!deps.agentIds().includes(id)) return { status: 404, body: { error: `No agent ${id}` } };
  const raw = body.perDay;
  const perDay = raw === null || raw === "" || raw === undefined ? null : Number(raw);
  try {
    budget.setPerDay(id, perDay);
  } catch (error) {
    return { status: 400, body: { error: error instanceof Error ? error.message : String(error) } };
  }
  return { status: 200, body: budget.counts(id) };
}
