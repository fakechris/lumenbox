/**
 * `SearchHistory`: every recorded conversation of a member and its teammates, searched at once
 * (INV-1751). The index is transcript-index.ts; this is the tool's reading of it.
 *
 * What a member may search is what it may read: its own conversations and those of the agents
 * sharing its box (`teammatesOf`, the one definition of teammate). Its own current conversation is
 * left out — it can see it, and `ReadHistory` searches what was summarised away — so a search is
 * not answered with the sentence it was asked from. Each hit names the agent, conversation and
 * anchor `ReadHistory` takes, because a snippet is a pointer to the record, not the record.
 *
 * Behind the lookup pair (tool-roster.ts): the list is at its thirty.
 */

import { agentboxHome } from "../config.ts";
import { outcomeLine } from "../protocol/index.ts";
import { heldValues } from "./audit-export.ts";
import { withReadOutcome } from "./read-outcome.ts";
import type { ToolContext, ToolOutcome } from "./tools.ts";
import { type Hit, HIT_KINDS, type HitKind, parseSince, problemText, type SearchResult, transcriptIndexFor } from "./transcript-index.ts";

export const SEARCH_HISTORY = "SearchHistory";

export function withSearchHistoryTool(tools: { name: string; input_schema: unknown }[]): void {
  tools.push({
    name: SEARCH_HISTORY,
    description:
      "Search every recorded conversation of yours and your teammates' for exact words or a regex, newest first. " +
      "Each hit names agent, conversation and anchor: ReadHistory with those and `around` reads it in full. Your current conversation is left out.",
    input_schema: {
      type: "object",
      properties: {
        words: { type: "string", description: "Words that must all appear." },
        regex: { type: "string" },
        since: { type: "string", description: "`3d`, `12h`, `2w` or an ISO date." },
        agent: { type: "string" },
        conversation: { type: "string" },
        kinds: { type: "string", description: "Comma-separated, from message, call, result, notice, summary, reminder. The last three are hidden unless named." },
      },
    },
  } as never);
}

/** The installation's values that must not come back out, or none when there is no installation to read. */
export function installationHeld(): ReadonlyMap<string, string> {
  try {
    return heldValues(agentboxHome());
  } catch {
    return new Map();
  }
}

function refused(reason: string): ToolOutcome {
  return { text: outcomeLine("refused", reason), isError: true };
}

export function searchHistoryTool(context: Pick<ToolContext, "agent" | "registry" | "conversation" | "historyConversation" | "side">, input: unknown): ToolOutcome {
  if (context.side === true) return refused("this turn answers a colleague beside a person's request; searching conversations is not part of it");
  const args = (input ?? {}) as Record<string, unknown>;
  const word = (key: string) => (typeof args[key] === "string" ? (args[key] as string).trim() : "");
  const self = context.agent;
  const mates = context.registry.teammatesOf(self.id);
  const readable = new Set([self.id, ...mates.map(mate => mate.id)]);

  let agents: string[] | undefined;
  if (word("agent") !== "") {
    const named = word("agent").replace(/^@/, "").toLowerCase();
    const found = [self, ...mates].find(record => record.id === word("agent") || record.profile.name.toLowerCase() === named);
    if (found === undefined) return refused(`no agent "${word("agent")}" whose conversations you can read: you can search your own and your teammates'`);
    agents = [found.id];
  }
  let since: Date | undefined;
  if (word("since") !== "") {
    since = parseSince(word("since"));
    if (since === undefined) return refused(`"${word("since").slice(0, 40)}" is not a time: give 3d, 12h, 2w or an ISO date`);
  }
  let kinds: HitKind[] | undefined;
  if (word("kinds") !== "") {
    const asked = word("kinds").split(/[\s,]+/).filter(Boolean);
    const unknown = asked.filter(kind => !HIT_KINDS.includes(kind as HitKind));
    if (unknown.length > 0) return refused(`unknown kind ${unknown.join(", ")}: use ${HIT_KINDS.join(", ")}`);
    kinds = asked as HitKind[];
  }
  const current = [...new Set([context.historyConversation, context.conversation].filter((id): id is string => id !== undefined))];
  const result = transcriptIndexFor(context.registry, { held: installationHeld }).search(context.registry, id => readable.has(id), {
    ...(word("words") !== "" ? { words: word("words") } : {}),
    ...(word("regex") !== "" ? { regex: word("regex") } : {}),
    ...(since !== undefined ? { since } : {}),
    ...(agents !== undefined ? { agents } : {}),
    ...(word("conversation") !== "" ? { conversation: word("conversation") } : {}),
    ...(kinds !== undefined ? { kinds } : {}),
    exclude: (current.length > 0 ? current : ["main"]).map(id => `${self.id}/${id}`),
  });
  if (result.problem !== undefined) return refused(problemText(result.problem));
  return { text: describeSearch(result, self.id) };
}

/** Who wrote a piece, in a few words. */
function whoSaid(hit: Hit, selfId: string): string {
  const member = hit.agentId === selfId ? "you" : hit.agent;
  if (hit.role === "person") return "the person";
  if (hit.role === "teammate") return "a teammate";
  if (hit.role === "host") return `the host (${hit.kind})`;
  if (hit.role === "tool") return "a tool result";
  return hit.kind === "call" ? `${member} called` : member;
}

export function describeSearch(result: SearchResult, selfId: string): string {
  const lines = result.hits.map(hit => {
    const whose = hit.agentId === selfId ? "you" : hit.agent;
    return `${whose} · ${hit.conversation} ${hit.anchor} · ${hit.at.slice(0, 16).replace("T", " ")} · ${whoSaid(hit, selfId)}: ${hit.snippet}`;
  });
  const cut: string[] = [];
  if (result.incomplete?.behind !== undefined) cut.push(`${result.incomplete.behind} transcript file(s) not indexed yet; the index is still catching up, so ask again shortly`);
  const reached = result.incomplete?.reached;
  if (reached !== undefined) cut.push(`the search ran out of time at entries from ${reached.slice(0, 16).replace("T", " ") || "the newest"}; narrow it with since, agent or conversation`);
  const body = lines.length === 0
    ? "Nothing matched. This is a plain word match, not a search that guesses at meaning: try other words, or name the hidden kinds."
    : [`${lines.length}${result.more ? "+" : ""} hits, newest first. ReadHistory with agent, conversation and around (the anchor) reads one in full:`, "", ...lines].join("\n");
  const notes = [
    ...(result.more ? [`More matched than shown; narrow with since, agent or conversation.`] : []),
    ...cut.map(reason => `Incomplete: ${reason}.`),
  ];
  return withReadOutcome(
    { completeness: cut.length > 0 || result.more ? "clipped" : "summary", shape: { results: lines.length }, note: cut.length > 0 ? "incomplete" : "snippets, not whole entries" },
    [body, ...(notes.length > 0 ? ["", ...notes] : [])].join("\n")
  );
}
