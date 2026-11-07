/**
 * An Orchestrate plan on the task board (INV-1740).
 *
 * A plan submitted from a turn working a task is that task split into pieces, so the board says so:
 * each item becomes a card assigned to the planning agent, `doing` from the start because the plan
 * is working it, and the task waits on the cards (`blockedBy`). The parent card reads "waiting on 2
 * of 3" while the plan runs, its turn ending does not close it, and each card closes with its item —
 * done, or dropped when the item failed or was blocked, with the item's own words in the note. The
 * plan's one result message is what wakes the parent (task-deps.ts skips its release wake: the cards
 * are closed as `plan`).
 *
 * Past `ORCHESTRATE_CONFIRM_AT` items a plan is a batch, and a card per item would bury the board:
 * it gets one card for the whole plan instead. A plan submitted with no task in hand leaves no cards.
 */

import { currentTaskOf } from "./autonomy-level.ts";
import { ORCHESTRATE_CONFIRM_AT, type PlanBoard } from "./orchestrate.ts";
import { PLAN_ACTOR } from "./task-deps.ts";
import type { TaskStore } from "./tasks.ts";

export function planCards(tasks: TaskStore): PlanBoard {
  return {
    open({ agentId, parent, plan }) {
      const task = currentTaskOf({ agent: { id: agentId }, conversation: parent, tasks });
      if (task === undefined) return [];
      const titles = plan.items.length <= ORCHESTRATE_CONFIRM_AT
        ? plan.items.map((item, index) => `${plan.brief} — ${index + 1}/${plan.items.length}: ${item}`)
        : [`${plan.brief} — all ${plan.items.length} items`];
      const cards = titles
        .map(title => tasks.create({ title, description: `Part of ${task.id}, run by an Orchestrate plan; it closes with its item — do not work it yourself. Each item is asked: ${plan.prompt}`, requester: agentId, assigneeId: agentId, conversation: parent })?.id)
        .filter((id): id is string => id !== undefined);
      // Doing from the start: the plan is working them, and an open card on the agent's plate reads as work to take.
      for (const id of cards) tasks.update(id, { status: "doing", note: `run by the plan "${plan.brief}"` }, PLAN_ACTOR);
      if (cards.length > 0) tasks.update(task.id, { blockedBy: [...new Set([...(task.blockedBy ?? []), ...cards])] }, agentId);
      return cards;
    },
    settle(cardId, status, text) {
      const card = tasks.get(cardId);
      if (card === undefined || card.status === "done" || card.status === "dropped") return;
      const closed = status === "failed" || status === "blocked" ? "dropped" : "done";
      tasks.update(cardId, { status: closed, note: `plan item ${status}: ${text.split("\n")[0]!.slice(0, 300)}` }, PLAN_ACTOR);
    },
  };
}
