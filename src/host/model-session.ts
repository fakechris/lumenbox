/**
 * Which conversation a model request belongs to, for an endpoint that asks to be told (INV-2325).
 *
 * OpenCode Go routes and caches by a session id the client sends in `x-opencode-session`, one per
 * conversation, and treats traffic without it as a client it does not know. The request is built
 * deep inside the turn, the summariser, the memory extractor and the reviewers, none of which know
 * the conversation, so the scope is entered where a turn or a background producer captures its
 * context (AgentRegistry.withContext) and read where the request leaves (provider.ts).
 *
 * The id is a hash of the agent's id and the conversation's, so it is the same for every request in
 * that conversation, the same after a restart, and says nothing about whose it is: agent ids are
 * random, and the conversation id is hashed with it, never sent. A request outside any conversation
 * (a connection test, a startup probe) gets the caller's fixed background key instead, so it is
 * still stable rather than new on every call.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

const scope = new AsyncLocalStorage<{ agentId: string; conversation: string }>();

/** Runs `run` as part of this agent's conversation: every model request inside carries its session. */
export function withModelSession<T>(agentId: string, conversation: string, run: () => T): T {
  const current = scope.getStore();
  if (current?.agentId === agentId && current.conversation === conversation) return run();
  return scope.run({ agentId, conversation }, run);
}

/** The session id of the conversation in scope, or of `background` when no conversation is. */
export function modelSessionId(background: string): string {
  const current = scope.getStore();
  return sessionIdOf(current === undefined ? `background\n${background}` : `conversation\n${current.agentId}\n${current.conversation}`);
}

/** The id for one key: 32 hex characters, the same for the same key in every process. */
export function sessionIdOf(key: string): string {
  return createHash("sha256").update(`lumenbox-model-session-v1\n${key}`).digest("hex").slice(0, 32);
}
