/**
 * `GET /api/history/search` (INV-1751): the page's search over every conversation, on the same index
 * and the same query as the `SearchHistory` tool (transcript-index.ts) — there is no second
 * implementation here, only the reader. The reader is a person, so what it may search is what it
 * may read: the boxes it is a member of (`mayReadAgent`, the transcript route's rule). Nothing is
 * left out as "current": a person searching is not inside any one conversation.
 *
 * `q` words, or `regex`; `since` (`3d`, `12h`, `2w`, an ISO date), `agent` (an id), `conversation`,
 * `kinds` (comma-separated; the injected ones are hidden unless named).
 */

import type { AgentRegistry } from "../agents/registry.ts";
import { HIT_KINDS, type HitKind, parseSince, transcriptIndexFor } from "../host/transcript-index.ts";
import { apiError } from "./api-error.ts";

export function historySearchRoute(
  route: string,
  url: URL,
  deps: { registry: AgentRegistry; mayReadAgent: (agentId: string) => boolean; held: () => ReadonlyMap<string, string> }
): { status: number; body: unknown } | undefined {
  if (route !== "GET /api/history/search") return undefined;
  const param = (name: string) => (url.searchParams.get(name) ?? "").trim();
  let since: Date | undefined;
  if (param("since") !== "") {
    since = parseSince(param("since"));
    if (since === undefined) return { status: 400, body: apiError("history-search-since", { since: param("since").slice(0, 40) }) };
  }
  const kinds = param("kinds").split(/[\s,]+/).filter((kind): kind is HitKind => HIT_KINDS.includes(kind as HitKind));
  const result = transcriptIndexFor(deps.registry, { held: deps.held }).search(deps.registry, deps.mayReadAgent, {
    ...(param("q") !== "" ? { words: param("q") } : {}),
    ...(param("regex") !== "" ? { regex: param("regex") } : {}),
    ...(since !== undefined ? { since } : {}),
    ...(param("agent") !== "" ? { agents: [param("agent")] } : {}),
    ...(param("conversation") !== "" ? { conversation: param("conversation") } : {}),
    ...(kinds.length > 0 ? { kinds } : {}),
  });
  if (result.problem?.code === "empty") return { status: 400, body: apiError("history-search-empty") };
  if (result.problem?.code === "regex") return { status: 400, body: apiError("history-search-regex", { why: result.problem.why }) };
  return { status: 200, body: { hits: result.hits, more: result.more, ...(result.incomplete !== undefined ? { incomplete: result.incomplete } : {}) } };
}
