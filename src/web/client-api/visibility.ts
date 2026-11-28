/**
 * What one call may see (docs/106 §4.3): the person's reach (reach.ts, the page's own answer),
 * and for a service token, only what its view names on top of that. A token never raises anything,
 * so every rule here narrows; none widens.
 *
 * Also the list cursors: opaque to a client, checked here — a cursor made for other filters, or not
 * made by this server, is refused rather than read as something else.
 */

import type { Task } from "../../host/tasks.ts";
import type { ChangeLine } from "./change-ledger.ts";
import type { Call } from "./frame.ts";
import { refuse } from "./frame.ts";
import { EMPTY_VIEW } from "./schema.ts";

export interface Sight {
  agent(agentId: string): boolean;
  task(task: Task): boolean;
  /** Whether conversation text and descriptions may be shown. */
  text: boolean;
  /** The top of what this work was made for, by the chain of `origin.parentId`. */
  topLevelOf(task: Task): Task;
  byId: ReadonlyMap<string, Task>;
  /**
   * Whether the caller may be told of this change: they hold the scope its type needs, and may read the
   * thing now — or, when it is gone, could have read it by what the ledger kept of it. A service token is
   * not told of work that is gone unless its view takes all work: what top-level work it was under is gone with it.
   */
  change(line: Pick<ChangeLine, "type" | "id" | "requester" | "assigneeId" | "boxId">): boolean;
}

export function sightOf(call: Call): Sight {
  const { person, credential } = call.caller!;
  const reach = call.deps.world.reachOf(person);
  const service = credential.kind === "service";
  const view = service ? (credential.view ?? EMPTY_VIEW) : undefined;
  const byId = new Map(call.deps.world.tasks().map(task => [task.id, task]));
  const topLevelOf = (task: Task): Task => {
    let at = task;
    for (let depth = 0; depth < 64; depth += 1) {
      const parent = at.origin?.parentId === undefined ? undefined : byId.get(at.origin.parentId);
      if (parent === undefined || parent.id === task.id) return at;
      at = parent;
    }
    return at;
  };
  const agent = (agentId: string): boolean => reach.agent(agentId) && (view === undefined || view.allAgents || view.agentIds.includes(agentId));
  const task = (row: Task): boolean => {
    if (!reach.task(row)) return false;
    if (view === undefined) return true;
    // Named work is seen with what was made for it; "all work" is the work the view's agents hold.
    return view.workIds.includes(topLevelOf(row).id) || (view.allWork && row.assigneeId !== undefined && agent(row.assigneeId));
  };
  const scopes = credential.scopes;
  const change = (line: Pick<ChangeLine, "type" | "id" | "requester" | "assigneeId" | "boxId">): boolean => {
    if (line.type === "agent") {
      if (!scopes.includes("agents:read")) return false;
      if (call.deps.world.agents().some(fact => fact.id === line.id)) return agent(line.id);
      return line.boxId !== undefined && reach.box(line.boxId) && (view === undefined || view.allAgents || view.agentIds.includes(line.id));
    }
    if (line.type === "inbox") {
      // That something waits on somebody, told to those who could be the one: the agent's box, the person who asked, or —
      // with neither (a held routine, an undelivered message) — everyone who decides. What it is comes from /inbox, filtered there.
      if (!scopes.includes("work:decide") || service) return false;
      if (line.assigneeId !== undefined) return reach.agent(line.assigneeId);
      return line.requester === undefined || line.requester === person.id;
    }
    if (line.type === "conversation" || line.type === "message") {
      // Conversations are conversation text: told to whoever may read the agent's conversations, never to a view without the text.
      if (!scopes.includes("chat:read") || (view !== undefined && !view.conversationText)) return false;
      return line.assigneeId !== undefined && agent(line.assigneeId);
    }
    if (!scopes.includes("work:read")) return false;
    const now = byId.get(line.id);
    if (now !== undefined) return task(now);
    const former = { requester: line.requester ?? "", ...(line.assigneeId !== undefined ? { assigneeId: line.assigneeId } : {}) };
    if (!reach.task(former)) return false;
    return view === undefined || (view.allWork && former.assigneeId !== undefined && agent(former.assigneeId));
  };
  return { agent, task, text: view === undefined || view.conversationText, topLevelOf, byId, change };
}

/** A cursor: the position to go on from and the filters it was given for, as base64url JSON. */
export function encodeCursor(position: unknown, filters: string): string {
  return Buffer.from(JSON.stringify({ p: position, f: filters })).toString("base64url");
}

/** The position in a cursor made for these filters; refuses anything else. */
export function decodeCursor<T>(cursor: unknown, filters: string, valid: (position: unknown) => position is T): T | undefined {
  if (cursor === undefined) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8")) as { p?: unknown; f?: unknown };
    if (parsed.f === filters && valid(parsed.p)) return parsed.p;
  } catch {
    // Not one of ours: refused below, with the same words.
  }
  return refuse("api-cursor-invalid");
}

/** `limit` as given, or the operation's default. */
export const limitOf = (call: Call, fallback = 50): number => (typeof call.params.limit === "number" ? call.params.limit : fallback);
