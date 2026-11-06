/**
 * What a person has set, per agent, about asking before a tool runs (INV-1664).
 *
 * Three states a person can read on a chip: **allow** (the gate decides as it always has),
 * **ask me** (every call waits for a person's consent card), and **off** (the tool is not
 * offered and is refused at dispatch). "Off" already had a home — `AgentProfile.tools`, the
 * allow-list the offer and the dispatch fence read — and keeps it; this module is the home of
 * the other axis, "ask", which before this only an administrator could set, in a rule file.
 *
 * Set two ways, the narrower winning: a default for a whole group (desk / web / code / team /
 * other, the catalog's tiers made into a partition so every tool is in exactly one) and an
 * override for one tool. Stored on the agent's profile as `toolPermissions`, the one place an
 * agent's configuration lives, so a version history of that profile versions this too.
 *
 * It is enforced through the operator rules' own path, not beside it: an "ask" becomes a
 * `Rule` with an `agents` matcher (rules.ts), and the gate's `decidingRule` takes the
 * strictest of the operator's rules and the agent's. So the order a person sees is the order
 * the code has: **the organisation's policy, then the agent's setting, then the group default**.
 * An agent-level "allow" produces no rule at all — it can only decline to tighten — so it never
 * lifts an operator's `ask` or `deny`, the approval lists, the tier gate, a host command or
 * the box's irreversible finding. Those are the floors `orgFloor` reports, which the Configure
 * dialog shows greyed with their source.
 */

import { CODE_TOOLS, DESK_TOOLS, TEAM_TOOLS, WEB_TOOLS } from "./catalog.ts";
import type { Rule } from "./rules.ts";
import { sideEffectOf, tierAsks, type TierGateMode } from "./side-effects.ts";

export type ToolPermission = "allow" | "ask";
export const TOOL_GROUPS = ["desk", "web", "code", "team", "other"] as const;
export type ToolGroup = (typeof TOOL_GROUPS)[number];

/** As stored on the profile. Both maps optional; an empty setting is no setting. */
export interface ToolPermissions {
  groups?: Partial<Record<ToolGroup, ToolPermission>>;
  tools?: Record<string, ToolPermission>;
}

/**
 * Tools that are the agent talking to the person, or the harness's own control flow. Asking a
 * person before asking a person is a loop, and a consent card in front of "I have nothing to
 * say" is noise — so these are allow-or-off only, and a group default passes over them.
 */
export const NEVER_ASKED: ReadonlySet<string> = new Set(["AskUser", "AskSecret", "HandOverDesktop", "NothingToSay", "Checkpoint", "WaitForControl"]);

/** The group a tool belongs to: the first tier that carries it. A connected service's tools (`server__tool`) ride with the desk, as `mcp:*` does. */
export function groupOf(tool: string): ToolGroup {
  if (DESK_TOOLS.includes(tool) || tool.includes("__") || tool.startsWith("mcp:")) return "desk";
  if (WEB_TOOLS.includes(tool)) return "web";
  if (CODE_TOOLS.includes(tool)) return "code";
  if (TEAM_TOOLS.includes(tool)) return "team";
  return "other";
}

/** Where the effective setting for a tool came from: its own chip, its group's default, or nothing set. */
export type PermissionSource = "tool" | "group" | "default";

export function permissionFor(permissions: ToolPermissions | undefined, tool: string): { permission: ToolPermission; source: PermissionSource; group: ToolGroup } {
  const group = groupOf(tool);
  if (NEVER_ASKED.has(tool)) return { permission: "allow", source: "default", group };
  const own = permissions?.tools?.[tool];
  if (own !== undefined) return { permission: own, source: "tool", group };
  const byGroup = permissions?.groups?.[group];
  if (byGroup !== undefined) return { permission: byGroup, source: "group", group };
  return { permission: "allow", source: "default", group };
}

/**
 * A setting as a request body carries it, checked. Unknown groups, non-string tool names and
 * values other than allow / ask are refused by name rather than dropped: a setting that quietly
 * lost its "ask" is the one failure a person would not notice until it mattered.
 */
export function parseToolPermissions(raw: unknown): ToolPermissions | null | Error {
  if (raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return new Error("toolPermissions must be an object { groups, tools } or null");
  const { groups, tools } = raw as { groups?: unknown; tools?: unknown };
  const groupsOut: Partial<Record<ToolGroup, ToolPermission>> = {};
  const toolsOut: Record<string, ToolPermission> = {};
  const value = (where: string, v: unknown): ToolPermission | Error =>
    v === "allow" || v === "ask" ? v : new Error(`${where} must be "allow" or "ask" (got ${JSON.stringify(v)}); "off" is the tool list's`);
  if (groups !== undefined) {
    if (typeof groups !== "object" || groups === null || Array.isArray(groups)) return new Error("toolPermissions.groups must be an object");
    for (const [group, v] of Object.entries(groups)) {
      if (!(TOOL_GROUPS as readonly string[]).includes(group)) return new Error(`no tool group "${group}" (one of ${TOOL_GROUPS.join(", ")})`);
      const parsed = value(`groups.${group}`, v);
      if (parsed instanceof Error) return parsed;
      groupsOut[group as ToolGroup] = parsed;
    }
  }
  if (tools !== undefined) {
    if (typeof tools !== "object" || tools === null || Array.isArray(tools)) return new Error("toolPermissions.tools must be an object");
    for (const [tool, v] of Object.entries(tools)) {
      if (tool.trim() === "" || tool.length > 200) return new Error("a tool name in toolPermissions.tools is empty or too long");
      const parsed = value(`tools.${tool}`, v);
      if (parsed instanceof Error) return parsed;
      if (!NEVER_ASKED.has(tool)) toolsOut[tool] = parsed;
    }
  }
  const out: ToolPermissions = {
    ...(Object.keys(groupsOut).length > 0 ? { groups: groupsOut } : {}),
    ...(Object.keys(toolsOut).length > 0 ? { tools: toolsOut } : {}),
  };
  return out.groups === undefined && out.tools === undefined ? null : out;
}

/**
 * The rule the agent's setting makes for one call, when it asks: a `Rule` like any operator's,
 * scoped by `agents` to this agent, so it is decided on the same path and named on the card.
 * An "allow" makes none — see the module comment for why that is the whole safety argument.
 */
export function agentRulesFor(agent: { id: string; name: string }, permissions: ToolPermissions | undefined, tool: string): Rule[] {
  const { permission, source, group } = permissionFor(permissions, tool);
  if (permission !== "ask") return [];
  const why = source === "tool" ? `ask before ${tool}` : `ask before any ${group} tool`;
  return [{
    id: `agent:${agent.name}/${source === "tool" ? tool : group}`,
    name: `${agent.name}: ${why}`,
    effect: "ask",
    tools: [tool],
    commands: [],
    hosts: [],
    principals: [],
    agents: [agent.id],
    source: "agent",
    text: `${agent.name}'s settings say ${why}. A person set this in the agent's Configure dialog.`,
  }];
}

/** What the organisation requires of a tool for this agent, whatever the agent's own setting. */
export interface OrgFloor {
  effect: "ask" | "deny";
  /** Where it comes from, in words a person can act on. */
  source: string;
}

/**
 * The floor under one tool: the strictest thing outside the agent's own setting that applies to
 * every call of it. Conditional rules (a command prefix, a host, a person) are not floors — they
 * hold for some calls — and still apply at the gate; only what holds for all of them greys a chip.
 */
export function orgFloor(
  tool: string,
  agent: { id: string; name: string },
  context: { rules: readonly Rule[]; approvalTools: readonly string[]; tierGate: TierGateMode | undefined }
): OrgFloor | undefined {
  let floor: OrgFloor | undefined;
  for (const rule of context.rules) {
    if (rule.source === "agent" || rule.effect === "allow") continue;
    if (rule.commands.length > 0 || rule.hosts.length > 0 || rule.principals.length > 0) continue;
    if (rule.tools.length === 0 || !(rule.tools.includes("*") || rule.tools.includes(tool))) continue;
    const agents = rule.agents ?? [];
    if (agents.length > 0 && !agents.some(entry => entry === agent.id || entry.toLowerCase() === agent.name.toLowerCase())) continue;
    if (floor === undefined || (rule.effect === "deny" && floor.effect === "ask")) floor = { effect: rule.effect, source: `operator rule ${rule.id}` };
  }
  if (floor?.effect === "deny") return floor;
  if (floor !== undefined) return floor;
  if (tool === "RunOnHost") return { effect: "ask", source: "a command on the person's own machine always asks" };
  if (context.approvalTools.includes(tool)) return { effect: "ask", source: "the installation's approval list of tools that always ask" };
  const tier = sideEffectOf(tool).tier;
  if (context.tierGate === "enforce" && tierAsks(tier)) return { effect: "ask", source: `the side-effect gate asks for every ${tier} call` };
  return undefined;
}
