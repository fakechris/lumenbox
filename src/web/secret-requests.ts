/**
 * An agent's request for a secret (AskSecret), answered on the page or from a phone (INV-2214).
 *
 * The value goes straight into the vault, granted to the agent that asked, and nowhere else: not the
 * transcript, not a log, not an answer the API keeps for a retry (the client API's `secret` operations
 * replay from memory, frame.ts). The agent is told the secret is saved, by its id, never by its value.
 * Who answered is recorded, never what.
 */

import { MAIN_CONVERSATION } from "../agents/registry.ts";
import type { WorkStamp } from "../agents/work-attention.ts";
import type { Vault } from "../host/vault.ts";

export interface SecretRequest {
  agentId: string;
  agentName: string;
  id: string;
  description: string;
  work?: WorkStamp;
  conversation?: string;
  at: string;
}

export interface SecretAnswerDeps {
  pending: Map<string, SecretRequest>;
  vault: Pick<Vault, "setSecret">;
  deliverSystem(agentId: string, text: string, conversation: string, work?: WorkStamp): void;
  log(line: string): void;
}

/** Saves `value` for the request `id`. `unknown`: not waiting; `empty`: nothing to save. */
export function answerSecret(deps: SecretAnswerDeps, id: string, value: string, by: string): "saved" | "unknown" | "empty" {
  const request = deps.pending.get(id);
  if (request === undefined) return "unknown";
  if (value.trim() === "") return "empty";
  // Into the vault with a grant to the agent that asked, and nothing else changes: the box never sees it, the
  // transcript never holds it, RunOnHost may name it.
  deps.vault.setSecret({ id, description: request.description, value, grants: [{ holder: request.agentId }] });
  deps.pending.delete(id);
  deps.log(`secret ${id} saved for ${request.agentName} by ${by}`);
  deps.deliverSystem(
    request.agentId,
    `[The person saved the secret ${id} securely. You never see its value; name it in RunOnHost's \`secrets\` to use it, ` +
      `or, if it is a provider key, delegated engines can use it through the relay. Confirm it by its effect, never by printing it.]`,
    request.conversation ?? MAIN_CONVERSATION, request.work,
  );
  return "saved";
}

/** Dismisses the request `id` without saving anything; false when it was not waiting. */
export function dismissSecret(deps: SecretAnswerDeps, id: string, by: string): boolean {
  const request = deps.pending.get(id);
  deps.pending.delete(id);
  if (request === undefined) return false;
  deps.log(`secret request ${id} of ${request.agentName} dismissed by ${by}`);
  deps.deliverSystem(request.agentId, `[The person dismissed your request for ${id} without saving it. Do without it, or say plainly what cannot be done.]`, request.conversation ?? MAIN_CONVERSATION, request.work);
  return true;
}
