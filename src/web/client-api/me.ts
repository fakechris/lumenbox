/** `GET /me` (docs/106 §4.2): the person a credential acts for, and the credential — never the token. Also what a device's sign-in answers as `me`. */

import type { Call } from "./frame.ts";
import { apiTime } from "./times.ts";

/** Whether a service token's view lets it read an agent; a personal token or a device is held by its person's reach alone. */
export function viewAllowsAgent(call: Call, agentId: string): boolean {
  const view = call.caller?.credential.view;
  if (call.caller?.credential.kind !== "service") return true;
  return view !== undefined && (view.allAgents || view.agentIds.includes(agentId));
}

export function meOf(call: Call) {
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
}
