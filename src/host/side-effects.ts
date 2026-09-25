/**
 * What each tool call does to the world, declared — and sorted by who it reaches and whether
 * it can be taken back, not by read versus write (INV-691).
 *
 * The earlier vocabulary here was read / mutate / publish / credential, declared in tools.ts and
 * consulted by nothing: no production caller, and one of its entries named a tool that does not
 * exist. This replaces it, and the policy gate now reads it.
 *
 * The distinction that matters to a person being asked for consent is not "does it write". An
 * agent rewriting its own notes, running a build, editing a file in its own box writes constantly
 * and should never interrupt anybody. What deserves a person's attention is an action that reaches
 * past the box and the person who asked — a message to somebody else, a change in an outside
 * service, a file uploaded somewhere — or one that touches authority or cannot be undone. So:
 *
 * - `observe` — looks, changes nothing.
 * - `self` — changes the box, the agent's own records, or the board; or talks to the person who
 *   asked. Reversible by the people involved.
 * - `reach` — acts past the box on something other than the requester: an outside service, a
 *   web page's upload, a tool we cannot see into.
 * - `spend` — commits money. No built-in tool does this on its own; a payment in a browser is
 *   caught per call as `irreversible` by the box (INV-401).
 * - `credential` — touches a secret, runs on the person's own machine, or changes who can act.
 * - `irreversible` — never declared per tool: the box found that *this call* would pay, publish,
 *   delete or authorise, and the host marks the request.
 *
 * Clicks and typing in a browser page are `self` on purpose. Most of them navigate, and a gate that
 * counted every click would bury the few that matter; the box's deterministic irreversible check is
 * what picks those out, per call.
 *
 * The verb phrase is ours, never the agent's or a skill's: it goes on the consent card above the
 * verbatim action, and a card whose wording the asking party could write is the injection surface
 * the verbatim rule exists to close.
 */
import { MCP_SEPARATOR } from "./mcp.ts";
import { engineToolNames } from "./engine-tools.ts";

export type SideEffectTier = "observe" | "self" | "reach" | "spend" | "credential" | "irreversible";

export interface SideEffect {
  tier: SideEffectTier;
  /** What the call does, as a short phrase for the consent card. Host-written only. */
  action?: string;
}

const DECLARED: Record<string, SideEffect> = {
  // Looks.
  read_file: { tier: "observe" },
  list_dir: { tier: "observe" },
  Teammates: { tier: "observe" },
  Jobs: { tier: "observe" },
  ReadHistory: { tier: "observe" },
  ReadKept: { tier: "observe" },
  OtherThreads: { tier: "observe" },
  Recall: { tier: "observe" },
  WebFetch: { tier: "observe" },
  WebSearch: { tier: "observe" },
  ReadFeishuDoc: { tier: "observe" },
  WaitForControl: { tier: "observe" },
  browser_pages: { tier: "observe" },
  browser_snapshot: { tier: "observe" },
  browser_read: { tier: "observe" },
  browser_scroll: { tier: "observe" },
  browser_wait_for: { tier: "observe" },

  // The box, the agent's own records, the board, the team, and the person who asked.
  bash: { tier: "self" },
  edit_file: { tier: "self" },
  write_file: { tier: "self" },
  computer: { tier: "self" },
  browser_open: { tier: "self" },
  browser_act: { tier: "self" },
  Fork: { tier: "self" },
  Delegate: { tier: "self" },
  SetPlan: { tier: "self" },
  Checkpoint: { tier: "self" },
  SetTodos: { tier: "self" },
  ClaimWork: { tier: "self" },
  RememberFact: { tier: "self" },
  Tasks: { tier: "self" },
  NoteSiteLearning: { tier: "self" },
  SendToAgent: { tier: "self" },
  AskUser: { tier: "self" },
  AskSecret: { tier: "self" },
  HandOverDesktop: { tier: "self" },
  // Staged only; nothing is shared until the person publishes it from the card.
  PackTemplate: { tier: "self" },

  // Past the box.
  browser_upload: { tier: "reach", action: "upload a file from the box to a web page" },

  // Authority.
  RunOnHost: { tier: "credential", action: "run a command on the person's own machine" },
  browser_fill_secret: { tier: "credential", action: "type a stored secret into a web page" },
  CreateAgent: { tier: "credential", action: "create a new agent with its own tools" },
  UpdateAgent: { tier: "credential", action: "change an agent's tools or instructions" },
};

/** Every tool this file declares, for the guard that holds it to the real tool list. */
export function declaredTools(): readonly string[] {
  return Object.keys(DECLARED);
}

/**
 * The effect of one call. Per call rather than per tool where the input decides: a GET through a
 * connector reads, anything else through it changes the outside service.
 */
export function sideEffectOf(tool: string, input: Record<string, unknown> = {}): SideEffect {
  if (tool === "connector_request") {
    const method = String(input.method ?? "GET").toUpperCase();
    const connector = String(input.connector ?? "a connected service");
    if (method === "GET" || method === "HEAD") return { tier: "observe" };
    return { tier: "reach", action: `change something in ${connector} as the person who connected it` };
  }
  const declared = DECLARED[tool];
  if (declared !== undefined) return declared;
  // A delegated engine's own tool, as the MCP face names what it does not map: read by what it
  // maps to here, so an engine reading a file is not counted as reaching outside. Unmapped, it is
  // an engine tool we cannot see into, which is `reach` like any other.
  if (tool.startsWith("engine:")) {
    const ours = engineToolNames(tool.slice("engine:".length));
    if (ours !== undefined) {
      const tiers = ours.map(name => sideEffectOf(name).tier);
      return { tier: RANK.find(tier => tiers.includes(tier)) ?? "reach" };
    }
    return { tier: "reach", action: `let a delegated engine run its ${tool.slice("engine:".length)} tool` };
  }
  // A tool from a server or an extension: we cannot see what it does, so it is assumed to leave
  // the box. Not `credential` — that would make every MCP read ask — and never `observe`, because
  // assuming a tool is harmless is how a harmless-looking one gets to act.
  const separator = tool.indexOf(MCP_SEPARATOR);
  if (separator > 0) {
    const server = tool.slice(0, separator);
    const name = tool.slice(separator + MCP_SEPARATOR.length);
    return { tier: "reach", action: `call ${name} on ${server}, a service outside the box` };
  }
  return { tier: "reach" };
}

/** Most-reaching first: a call that maps to several tools is as far-reaching as the furthest. */
const RANK: readonly SideEffectTier[] = ["irreversible", "credential", "spend", "reach", "self", "observe"];

/** The tiers a person would be asked about, once the gate enforces. */
export function tierAsks(tier: SideEffectTier): boolean {
  return tier === "reach" || tier === "spend" || tier === "credential" || tier === "irreversible";
}

/**
 * Whether the tier gate only records what it would have asked (`shadow`, the default), actually
 * asks (`enforce`), or does neither (`off`). Read when the gate is built, after config.json's env
 * has landed — the same reason `defaultLimits` reads its variables late.
 */
export type TierGateMode = "off" | "shadow" | "enforce";

export function tierGateMode(env: NodeJS.ProcessEnv = process.env): TierGateMode {
  const raw = (env.AGENTBOX_TIER_GATE ?? "").trim().toLowerCase();
  if (raw === "off" || raw === "0") return "off";
  if (raw === "enforce") return "enforce";
  return "shadow";
}
