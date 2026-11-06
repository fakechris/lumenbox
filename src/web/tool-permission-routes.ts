/**
 * The Configure dialog's tool permissions (INV-1664): what each tool is set to for one agent,
 * which group it is in, and what the organisation requires of it — the floor a chip cannot be
 * set below, with where it comes from. Saving goes through the agent's own update, so the
 * setting lives on the profile with the rest of the agent's configuration.
 */

import type { Rule } from "../host/rules.ts";
import type { TierGateMode } from "../host/side-effects.ts";
import { groupOf, NEVER_ASKED, orgFloor, type OrgFloor, parseToolPermissions, type ToolPermissions, TOOL_GROUPS } from "../host/tool-permissions.ts";

/** `toolPermissions` from a create or update body: absent, cleared (`null`), a setting, or why it is not one. */
export function readToolPermissions(body: Record<string, unknown>): ToolPermissions | null | undefined | Error {
  return body.toolPermissions === undefined ? undefined : parseToolPermissions(body.toolPermissions);
}

export async function toolPermissionRoute(
  route: string,
  url: URL,
  deps: {
    refused: (agentId: string) => boolean;
    agent: (agentId: string) => { id: string; name: string; toolPermissions?: ToolPermissions } | undefined;
    allTools: readonly string[];
    floorContext: () => { rules: readonly Rule[]; approvalTools: readonly string[]; tierGate: TierGateMode | undefined };
  }
): Promise<{ status: number; body: unknown } | undefined> {
  if (route !== "GET /api/agents/tool-permissions") return undefined;
  const agentId = url.searchParams.get("agent") ?? "";
  // No id is the dialog for a new agent: the groups and the floors, nothing of anyone's.
  if (agentId !== "" && deps.refused(agentId)) return { status: 0, body: null };
  const agent = agentId === "" ? { id: "", name: "" } : deps.agent(agentId);
  if (agent === undefined) return { status: 404, body: { error: `No agent ${agentId}` } };
  const context = deps.floorContext();
  const groups: Record<string, string[]> = Object.fromEntries(TOOL_GROUPS.map(group => [group, [] as string[]]));
  const floors: Record<string, OrgFloor> = {};
  for (const tool of deps.allTools) {
    groups[groupOf(tool)]!.push(tool);
    const floor = orgFloor(tool, agent, context);
    if (floor !== undefined) floors[tool] = floor;
  }
  return { status: 200, body: { agent: agent.id, groups, permissions: (agent as { toolPermissions?: ToolPermissions }).toolPermissions ?? {}, floors, neverAsked: [...NEVER_ASKED] } };
}
