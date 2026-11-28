/**
 * What each `/api/v1` operation answers: a resource of `schema.ts`, built field by field from
 * what the server knows. Never an internal object passed through — a field the schema does not
 * name never reaches a client, and the contract tests check that on every answer.
 */

import { getAgent, listAgents } from "./agents.ts";
import type { Call, Handlers } from "./frame.ts";
import { apiTime } from "./times.ts";
import { getBoard, getWork, listWork, listWorkHistory } from "./work.ts";
import { getChanges, streamEvents } from "./sync.ts";
import { API_VERSION, OPERATIONS } from "./schema.ts";

/** Whether a service token's view lets it read an agent; a personal token is held by its person's reach alone. */
export function viewAllowsAgent(call: Call, agentId: string): boolean {
  const view = call.caller?.credential.view;
  if (call.caller?.credential.kind !== "service") return true;
  return view !== undefined && (view.allAgents || view.agentIds.includes(agentId));
}

export const HANDLERS: Handlers = {
  listAgents, getAgent, listWork, getWork, listWorkHistory, getBoard, getChanges, streamEvents,

  getMeta: ({ deps }) => ({
    api: API_VERSION,
    server: deps.version,
    installation: { mode: deps.installationMode() },
    capabilities: OPERATIONS.filter(operation => operation.tier === "stable").map(operation => operation.operationId),
    preview: OPERATIONS.filter(operation => (operation.tier as string) === "preview").map(operation => operation.operationId),
  }),

  getMe: call => {
    const { person, credential } = call.caller!;
    const home = call.deps.homeAgentOf(person.id);
    return {
      id: person.id,
      name: person.name,
      role: person.role,
      ...(home !== undefined && viewAllowsAgent(call, home) ? { homeAgentId: home } : {}),
      credential: {
        id: credential.id,
        kind: credential.kind,
        label: credential.label,
        scopes: credential.scopes,
        createdAt: apiTime(credential.createdAt),
        expiresAt: apiTime(credential.expiresAt),
        ...(credential.lastUsedAt !== undefined ? { lastUsedAt: apiTime(credential.lastUsedAt) } : {}),
        ...(credential.view !== undefined ? { view: { ...credential.view } } : {}),
      },
    };
  },
};
