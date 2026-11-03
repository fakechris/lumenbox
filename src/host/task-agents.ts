/**
 * Who a task may name as its assignee or reviewer: an agent on this team (INV-1542).
 *
 * Ids made up for a test reached the board through the web API — 7c3e91a4-0000-4000-8000-000000000001,
 * "Bob" — and a note the system then wrote for one of them stopped the server. The board refuses
 * them when they are named; a task that already names one is left as it is, and can still be
 * reassigned or cleared.
 */

export interface TaskAgents {
  has: (id: string) => boolean;
}

export class UnknownAgentError extends Error {
  // The refusal names no agents: the caller may not be allowed to see every box's roster.
  constructor(readonly role: "assignee" | "reviewer", readonly id: string) {
    super(`No agent with id ${id} to be the ${role}. Name an agent of this team by its id.`);
    this.name = "UnknownAgentError";
  }
}

/** Throws for an assignee or reviewer being named that is not an agent; null (clearing it) is not naming. */
export function refuseUnknownAgents(agents: TaskAgents | undefined, named: { assigneeId?: string | null; reviewerId?: string | null }): void {
  if (agents === undefined) return;
  for (const [role, id] of [["assignee", named.assigneeId], ["reviewer", named.reviewerId]] as const) {
    if (typeof id === "string" && !agents.has(id)) throw new UnknownAgentError(role, id);
  }
}
