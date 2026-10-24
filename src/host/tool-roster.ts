/**
 * Which built-in tools ride in every prompt, and which wait behind the lookup pair (INV-1341).
 *
 * The forty-nine built-in definitions cost about 72 KB of every request, and past thirty or so
 * a model's tool choice measurably degrades (Anthropic, "Building agents", 2026-10-22; INV-1339).
 * Thirty days of the step ledger (2026-09-24..10-24, 1,835 calls) said which ones are actually
 * reached for: eighteen names account for every call but a handful, and thirty definitions were
 * called once or never. So the roster is split, not renamed:
 *
 *   - **resident**: in the tool list of every turn — what is used, what faces the person, and
 *     the connector doors. Nothing about these changes.
 *   - **deferred**: still built, still gated, still dispatched by the same name with the same
 *     side-effect tier — but found through `FindMcpTool` and called through `UseMcpTool`, the
 *     pair that already does this for external tools. The catalog is one catalog.
 *
 * Nothing is renamed, so nothing stored on disk, in a skill or in a scope changes meaning; a
 * deferred name in a profile's allowlist or a routine's tool scope keeps working. What the model
 * sees is a shorter list and one line saying where the rest are.
 */

import type Anthropic from "@anthropic-ai/sdk";

/** Built-in tools that stay in the list. Everything else `buildTools` offers is deferred. */
export const RESIDENT_TOOLS: ReadonlySet<string> = new Set([
  // Used daily (step ledger, 30 days).
  "bash",
  "edit_file",
  "read_file",
  "write_file",
  "list_dir",
  "computer",
  "Tasks",
  "ShowUI",
  "SendToAgent",
  "SetTodos",
  "Checkpoint",
  "WebFetch",
  "WebSearch",
  "RememberFact",
  "ReadHistory",
  // Faces the person or ends the turn: never worth a lookup round trip.
  "AskUser",
  "NothingToSay",
  // Hands work to an engine; the one spawn path that is reached for.
  "Delegate",
  // The goal loop's own verb (checklist, claim_complete): the prompt tells the agent to call it, so
  // it must not cost a lookup round trip when the moment comes.
  "Goal",
  // The browser's core four; the rest of the browser_* family is deferred.
  "browser_open",
  "browser_snapshot",
  "browser_read",
  "browser_act",
  // Connector doors: each is one intent-level tool already.
  "connector_request",
  "FeishuWrite",
  "DingTalkWrite",
  // The door out of the box; approval-gated, and its absence is how "off" is signalled.
  "RunOnHost",
]);

/** The lookup pair itself: resident whenever anything is behind it. */
export const GATEWAY_TOOLS: ReadonlySet<string> = new Set(["FindMcpTool", "UseMcpTool"]);

/** The section a deferred built-in is listed under in the catalog. */
export const BUILT_IN_SECTION = "built-in";

/** Up to this many built-ins ride as they are: a list already narrowed by a profile or a routine is not made to pay a round trip. */
export const ROSTER_BUDGET = 30;

export function splitRoster(tools: readonly Anthropic.Tool[]): { resident: Anthropic.Tool[]; deferred: Anthropic.Tool[] } {
  if (tools.length <= ROSTER_BUDGET) return { resident: [...tools], deferred: [] };
  const resident: Anthropic.Tool[] = [];
  const deferred: Anthropic.Tool[] = [];
  for (const tool of tools) (RESIDENT_TOOLS.has(tool.name) || GATEWAY_TOOLS.has(tool.name) ? resident : deferred).push(tool);
  return { resident, deferred };
}

/** The first sentence, clamped — the same shape mcp.ts gives an external tool in the catalog. */
function firstSentence(text: string, max = 160): string {
  const line = text.replace(/\s+/g, " ").trim();
  const end = line.search(/[.!?](\s|$)/);
  const sentence = end === -1 ? line : line.slice(0, end + 1);
  return sentence.length > max ? `${sentence.slice(0, max - 1)}…` : sentence;
}

/**
 * The deferred built-ins as catalog text, in the shape of `McpManager.describeTools` so the two
 * read as one: `tool` gives one tool's full description and schema, `pattern` filters, nothing
 * lists them all under one heading. Undefined when the query names a server (built-ins have
 * none) or nothing matches, so the caller can fall through to the external catalog alone.
 */
export function describeDeferred(deferred: readonly Anthropic.Tool[], input: { server?: string; tool?: string; pattern?: string } = {}): string | undefined {
  if (deferred.length === 0) return undefined;
  if (input.tool !== undefined && input.tool !== "") {
    const found = deferred.find(tool => tool.name === input.tool);
    if (found === undefined) return undefined;
    return `${found.name}\n${found.description ?? ""}\n\ninput schema:\n${JSON.stringify(found.input_schema, null, 2)}\n\nCall it with UseMcpTool, tool: "${found.name}".`;
  }
  if (input.server !== undefined && input.server !== "" && input.server !== BUILT_IN_SECTION) return undefined;
  const needle = (input.pattern ?? "").toLowerCase();
  const matching = deferred.filter(tool => needle === "" || tool.name.toLowerCase().includes(needle) || (tool.description ?? "").toLowerCase().includes(needle));
  if (matching.length === 0) return undefined;
  return [`## ${BUILT_IN_SECTION} (${matching.length})`, ...matching.map(tool => `- ${tool.name}: ${firstSentence(tool.description ?? "")}`)].join("\n");
}

/**
 * The lookup pair as offered: nothing when nothing is behind it; otherwise `FindMcpTool` whose
 * description says what is there — `externalCount` services' tools when they are over budget,
 * the deferred built-ins by name — and `UseMcpTool` to call either kind.
 */
export function lookupPair(externalCount: number, deferred: readonly Anthropic.Tool[]): Anthropic.Tool[] {
  if (externalCount === 0 && deferred.length === 0) return [];
  const external = externalCount > 0 ? `${externalCount} tools from connected external services are available, too many to list in full here. ` : "";
  const builtIn = deferred.length > 0 ? `${deferred.length} less-used built-in tools (${deferred.map(tool => tool.name).join(", ")}) are behind this pair as well. ` : "";
  return [
    {
      name: "FindMcpTool",
      description:
        `${external}${builtIn}Search them with this, then call one with \`UseMcpTool\`. No arguments lists everything ` +
        "with a one-line description each; `pattern` filters by substring; `server` narrows to one service " +
        "(or `built-in`); `tool` returns that one tool's full description and input schema, which is what you need before calling it.",
      input_schema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Substring to look for." },
          server: { type: "string", description: "Only this service's tools, or `built-in`." },
          tool: { type: "string", description: "One tool's full detail, by exact name." },
        },
      },
    },
    {
      name: "UseMcpTool",
      description:
        "Call one of the tools found with `FindMcpTool` — an external one, or a less-used built-in. Look the tool up " +
        "first: its input schema is not shown here, and guessing the arguments wastes the call. A built-in called this " +
        "way is governed exactly as if it were in the list.",
      input_schema: {
        type: "object",
        properties: {
          tool: { type: "string", description: "The exact tool name: `service__tool`, or a built-in's name." },
          arguments: { type: "object", description: "Its arguments, per its schema." },
        },
        required: ["tool"],
      },
    },
  ];
}
