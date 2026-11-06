/**
 * The Configure dialog's History tab and the conversation header's version chip (INV-1669).
 *
 *   GET  /api/agents/config-versions?agent=a1[&conversation=c]  every version with what it changed,
 *        the one now saved, and — for a conversation — the versions it ran under and from when
 *   GET  /api/agents/config-versions/diff?agent=a1&from=2&to=5  what differs between two versions
 *   POST /api/agents/config-versions/restore {agent, version}   "go back to this version": its
 *        settings become the agent's and a new version records that; no version is rewritten
 *
 * Who may read or restore is who may open the agent's Configure dialog: the same `refused` the
 * agent update route asks.
 */

import { changesFor, configDiff, type ConfigVersion, switchesInConversation } from "../agents/config-versions.ts";
import type { AgentRegistry } from "../agents/registry.ts";

export async function configVersionRoute(
  route: string,
  url: URL,
  deps: {
    registry: AgentRegistry;
    refused: (agentId: string) => boolean;
    readJson: () => Promise<Record<string, unknown>>;
    /** Who is saving, as a version names them. */
    by: () => string;
    log: (line: string) => void;
  }
): Promise<{ status: number; body: unknown } | undefined> {
  if (route !== "GET /api/agents/config-versions" && route !== "GET /api/agents/config-versions/diff" && route !== "POST /api/agents/config-versions/restore") return undefined;
  const body = route.startsWith("POST") ? await deps.readJson() : {};
  const agentId = String(route.startsWith("POST") ? body.agent ?? "" : url.searchParams.get("agent") ?? "");
  if (deps.refused(agentId)) return { status: 0, body: null };
  const record = deps.registry.tryGet(agentId);
  if (record === undefined) return { status: 404, body: { error: `No agent ${agentId}` } };
  const store = deps.registry.configVersions;

  if (route === "GET /api/agents/config-versions") {
    const versions = store.list(agentId);
    const conversation = url.searchParams.get("conversation");
    return {
      status: 200,
      body: {
        agent: agentId,
        current: versions.at(-1)?.n ?? null,
        versions: versions.map((version, index) => ({ ...version, changes: index === 0 ? [] : configDiff(versions[index - 1]!.config, version.config) })),
        ...(conversation !== null ? { switches: switchesInConversation(deps.registry, { id: agentId, name: record.profile.name }, conversation) } : {}),
      },
    };
  }

  const versionOf = (raw: unknown): ConfigVersion | undefined => store.get(agentId, Number(raw));
  if (route === "GET /api/agents/config-versions/diff") {
    const from = versionOf(url.searchParams.get("from"));
    const to = versionOf(url.searchParams.get("to"));
    if (from === undefined || to === undefined) return { status: 404, body: { error: "No such version." } };
    return { status: 200, body: { from: from.n, to: to.n, changes: configDiff(from.config, to.config) } };
  }

  const target = versionOf(body.version);
  if (target === undefined) return { status: 404, body: { error: "No such version." } };
  const before = record.profile;
  const after = deps.registry.update(agentId, changesFor(target.config)).profile;
  const made = store.saved(agentId, after, deps.by(), { before, restoredFrom: target.n });
  deps.log(`agent ${after.name} (${agentId}) went back to configuration version ${target.n} as version ${made.n}`);
  return { status: 200, body: { version: made.n, restoredFrom: target.n } };
}
