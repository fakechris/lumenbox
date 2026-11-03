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
  /** The agents, for the refusal to name: "Ada (id), Bob (id)". */
  describe: () => string;
}

export class UnknownAgentError extends Error {
  constructor(readonly role: "assignee" | "reviewer", readonly id: string, team: string) {
    super(`No agent with id ${id} to be the ${role}.${team === "" ? "" : ` The agents are: ${team}.`}`);
    this.name = "UnknownAgentError";
  }
}

/** Throws for an assignee or reviewer being named that is not an agent; null (clearing it) is not naming. */
export function refuseUnknownAgents(agents: TaskAgents | undefined, named: { assigneeId?: string | null; reviewerId?: string | null }): void {
  if (agents === undefined) return;
  for (const [role, id] of [["assignee", named.assigneeId], ["reviewer", named.reviewerId]] as const) {
    if (typeof id === "string" && !agents.has(id)) throw new UnknownAgentError(role, id, agents.describe());
  }
}
