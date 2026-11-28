/**
 * What a person may read (docs/22 §5, INV-538, docs/111 §1): a box by its members, an agent by
 * its box, a task by its agent — or, when nobody holds it, by whether they asked for it. The one
 * answer both the page's routes (`server.ts`) and the client API (`client-api/`, docs/106 §4.3)
 * give, so a phone never sees what the page would not show the same person, nor the reverse.
 *
 * The box is the boundary for Admins too (docs/111 §1): nothing here gives a role more reach.
 */

import type { BoxEntry } from "../box/boxes.ts";
import { mayEnterBox } from "../box/membership.ts";

export interface Reach {
  box(boxId: string): boolean;
  agent(agentId: string): boolean;
  task(task: { assigneeId?: string | undefined; requester: string }): boolean;
}

export interface ReachWorld {
  boxById(boxId: string): Pick<BoxEntry, "members"> | undefined;
  /** The box an agent lives in; undefined for an agent that does not exist. */
  boxIdOf(agentId: string): string | undefined;
  /** Boxes this installation does not show anybody (a member's box still starting, the hidden one). */
  unavailable(): ReadonlySet<string>;
}

/**
 * `who` is read on every question, so a roster change between two of them counts. It answers
 * undefined for the installation's own credential (the operator): every box this installation shows.
 * `known`: the person is on the roster, which a box that is not everyone's requires.
 */
export function reachOf(who: () => { personId: string; known: boolean } | undefined, world: ReachWorld): Reach {
  const box = (boxId: string): boolean => {
    const entry = world.boxById(boxId);
    if (entry === undefined || world.unavailable().has(boxId)) return false;
    const person = who();
    return person === undefined || ((entry.members === "everyone" || person.known) && mayEnterBox(entry, person.personId));
  };
  const agent = (agentId: string): boolean => {
    const boxId = world.boxIdOf(agentId);
    return boxId !== undefined && box(boxId);
  };
  const task = (row: { assigneeId?: string | undefined; requester: string }): boolean => {
    const person = who();
    return person === undefined || (row.assigneeId ? agent(row.assigneeId) : row.requester === person.personId);
  };
  return { box, agent, task };
}
