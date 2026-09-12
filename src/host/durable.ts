/**
 * The state a long task cannot afford to lose in a paraphrase.
 *
 * Compaction summarises history, and a summary is prose. Prose drops things, rewrites things, and —
 * the failure that matters most — turns "attempted" into "done". An agent whose objective lived only
 * in the conversation loses the objective the first time the conversation is compacted, and then
 * drifts confidently.
 *
 * So the plan and the todo list are not conversation. They are structured state the agent maintains
 * with tools, stored as files, and **rendered into the system prompt every turn**.
 *
 * That placement is the whole design, and it differs from the obvious one. The obvious approach is to
 * re-render them into each summary, so compaction carries them forward. But this system rebuilds the
 * system prompt from scratch on every turn ([prompt.ts](prompt.ts)), which means anything in the
 * volatile tier is *structurally* immune to history compaction — there is no path by which a summary
 * could lose it, because it was never in the history to begin with. Re-rendering into summaries would
 * be a mechanism to maintain and get wrong; this is an absence of one.
 *
 * Within a turn the system prompt is built once, so an update at round 5 is not in the prompt at
 * round 300. That is covered from the other side: the tools echo the new state in their result, so
 * the change is in the message array where the agent can see it, and in-turn pruning only touches
 * images.
 *
 * Two rules from watching this go wrong elsewhere:
 *
 *   - **Absent renders as nothing, never as an empty container.** A block saying "here is the plan:"
 *     with nothing after it tells the model a plan exists and is empty, which is worse than silence.
 *   - **Adding a block id must not compile until it has a renderer.** The registry is a total record
 *     over the id union, so a new id is a type error until it is rendered.
 */

/** One item of work. Deliberately small: a status and a line of text. */
export interface TodoItem {
  /**
   * Free text, one line.
   *
   * Not an id and a title and a description. A todo list that needs a schema is a project tracker,
   * and an agent maintaining a project tracker is spending its turn on bookkeeping.
   */
  text: string;
  status: TodoStatus;
}

export type TodoStatus = "pending" | "doing" | "done" | "blocked";

export const TODO_STATUSES: readonly TodoStatus[] = ["pending", "doing", "done", "blocked"];

export function isTodoStatus(value: string): value is TodoStatus {
  return (TODO_STATUSES as readonly string[]).includes(value);
}

/** The most a plan may be. Beyond this it is a document, and documents belong in the work volume. */
export const MAX_PLAN_CHARS = 8_000;
/** Enough for real work, small enough that the list stays readable in a prompt and on a screen. */
export const MAX_TODOS = 40;
export const MAX_TODO_CHARS = 200;

export interface DurableState {
  /** Markdown the agent wrote. Empty or absent means there is no plan, not an empty plan. */
  plan?: string;
  todos?: readonly TodoItem[];
  /** When the plan was last written, so a stale plan can be recognised as one. */
  planUpdatedAt?: string;
  /** Results kept as they were reached (INV-410), so a stopped turn still hands something over. */
  checkpoints?: readonly Checkpoint[];
}

/**
 * A result written down the moment it exists (INV-410, browser-use-pi's checkpoint).
 *
 * A turn that runs out of rounds, is stopped, or dies used to hand over nothing, however
 * much it had found — the findings were in tool results the person never saw. A
 * checkpoint is the agent saying "this much is true so far": named, dated, and either
 * partial or final. It survives compaction like the plan does, it is shown back to the
 * agent on every round, and when a turn ends without a reply the report names what was
 * checkpointed so the person gets the half rather than the silence.
 */
export interface Checkpoint {
  name: string;
  value: string;
  at: string;
  /** True while more is expected; a final checkpoint is a result, not a snapshot of one. */
  partial: boolean;
}

export const MAX_CHECKPOINTS = 20;
export const MAX_CHECKPOINT_CHARS = 2_000;
const CHECKPOINT_NAME = /^[A-Za-z0-9][A-Za-z0-9 _.\-\u4e00-\u9fff]{0,63}$/;

export function validateCheckpoint(name: string, value: string): Rejection | undefined {
  if (!CHECKPOINT_NAME.test(name.trim())) {
    return { reason: "A checkpoint needs a short name — letters, digits, spaces, dots, dashes; up to 64 characters." };
  }
  if (value.trim() === "") return { reason: "A checkpoint with no value keeps nothing. Say what was found, or skip it." };
  if (value.length > MAX_CHECKPOINT_CHARS) {
    return {
      reason:
        `A checkpoint may hold ${MAX_CHECKPOINT_CHARS} characters and this is ${value.length}. Put the full ` +
        `result in a file under /home/box/work and checkpoint its path and a summary.`,
    };
  }
  return undefined;
}

/** Adds or replaces a checkpoint by name, newest last, capped. */
export function withCheckpoint(existing: readonly Checkpoint[] | undefined, next: Checkpoint): Checkpoint[] {
  const kept = (existing ?? []).filter(entry => entry.name !== next.name);
  kept.push(next);
  return kept.slice(-MAX_CHECKPOINTS);
}

/** The line a stopped turn's report ends with, or undefined when nothing was checkpointed. */
export function checkpointSummary(state: DurableState): string | undefined {
  const checkpoints = state.checkpoints ?? [];
  if (checkpoints.length === 0) return undefined;
  const partial = checkpoints.filter(entry => entry.partial).length;
  const lines = checkpoints.map(entry => `- ${entry.name}${entry.partial ? " (partial)" : ""}: ${entry.value.replace(/\s+/g, " ").slice(0, 300)}${entry.value.length > 300 ? "…" : ""}`);
  return [
    `Checkpointed before stopping (${checkpoints.length}${partial > 0 ? `, ${partial} partial` : ""}):`,
    ...lines,
  ].join("\n");
}

/**
 * Every block that survives a compaction, and how it renders.
 *
 * A total record over the id union: adding an id here is a compile error until it has a renderer, so
 * a block cannot be named in one place and forgotten in another.
 */
export type DurableBlockId = "plan" | "todos" | "checkpoints";

type Renderer = (state: DurableState) => string | undefined;

const RENDERERS: Record<DurableBlockId, Renderer> = {
  // Assigned below, after the checkpoint renderer is defined; a total record still, by the type.
  checkpoints: () => undefined,
  plan: state => {
    const plan = state.plan?.trim();
    // Nothing rather than an empty container. A heading with nothing under it tells the model a plan
    // exists and is empty, which reads as "there is no work to do".
    if (plan === undefined || plan === "") return undefined;
    return [
      "## Your current plan",
      "",
      "You wrote this earlier in this piece of work. It survives summarisation, so it is the one",
      "record of your intent that cannot have been paraphrased away. If it no longer matches what",
      "you are doing, update it with SetPlan rather than leaving it to contradict you.",
      "",
      plan,
    ].join("\n");
  },

  todos: state => {
    const todos = state.todos ?? [];
    if (todos.length === 0) return undefined;
    const done = todos.filter(item => item.status === "done").length;
    const lines = todos.map(item => `- [${MARKERS[item.status]}] ${item.text}`);
    return [
      `## Your todo list (${done}/${todos.length} done)`,
      "",
      "Also survives summarisation. Keep it current with SetTodos: a list that says something is",
      "pending when you finished it will make you redo the work, and one that says done when you",
      "did not will make you skip it.",
      "",
      ...lines,
    ].join("\n");
  },
};

const RENDER_CHECKPOINTS: Renderer = state => {
  const checkpoints = state.checkpoints ?? [];
  if (checkpoints.length === 0) return undefined;
  const lines = checkpoints.map(entry => `- **${entry.name}**${entry.partial ? " (partial)" : ""} — ${entry.at.slice(0, 16).replace("T", " ")}: ${entry.value}`);
  return [
    `## Your checkpoints (${checkpoints.length})`,
    "",
    "Results you wrote down as you reached them. They survive summarisation and are handed to the",
    "person if this turn stops before you reply. Replace one by checkpointing the same name; mark",
    "it final once nothing more is coming.",
    "",
    ...lines,
  ].join("\n");
};
RENDERERS.checkpoints = RENDER_CHECKPOINTS;

const MARKERS: Record<TodoStatus, string> = {
  pending: " ",
  doing: ">",
  done: "x",
  blocked: "!",
};

/**
 * The blocks to place, in order.
 *
 * Plan before todos because the plan is the why and the list is the what, and a model reading them in
 * that order has the context for the second by the time it arrives.
 */
const PLACEMENT: readonly DurableBlockId[] = ["plan", "todos", "checkpoints"];

/** Renders whatever is present, joined. Empty string when there is nothing, so callers can concat. */
export function renderDurableBlocks(state: DurableState): string {
  return PLACEMENT.map(id => RENDERERS[id](state))
    .filter((text): text is string => text !== undefined && text !== "")
    .join("\n\n");
}

// ── validation ────────────────────────────────────────────────────────────────────────

export interface Rejection {
  reason: string;
}

/**
 * Checks a plan before it is stored, and says what to do instead when it is refused.
 *
 * Refusals are written for the model: "too long" teaches nothing, "put it in a file under
 * /home/box/work and reference it" is actionable.
 */
export function validatePlan(plan: string): Rejection | undefined {
  if (plan.trim() === "") {
    return {
      reason:
        "A plan cannot be empty. To remove a plan, say so in one line — an empty plan reads as " +
        "'there is nothing to do' rather than 'there is no plan'.",
    };
  }
  if (plan.length > MAX_PLAN_CHARS) {
    return {
      reason:
        `A plan may be up to ${MAX_PLAN_CHARS} characters and this is ${plan.length}. It is in every ` +
        `request from now on, so length here is paid for repeatedly. Keep the intent and the shape ` +
        `here, and put detail in a file under /home/box/work that this plan points at.`,
    };
  }
  return undefined;
}

export function validateTodos(todos: readonly TodoItem[]): Rejection | undefined {
  if (todos.length > MAX_TODOS) {
    return {
      reason:
        `A todo list may hold ${MAX_TODOS} items and this has ${todos.length}. A list longer than ` +
        `that is a plan; write it with SetPlan and keep the list to what you are working through now.`,
    };
  }
  for (const item of todos) {
    if (item.text.trim() === "") {
      return { reason: "Every todo needs text. An empty item cannot be worked on or ticked off." };
    }
    if (item.text.length > MAX_TODO_CHARS) {
      return {
        reason:
          `A todo may be ${MAX_TODO_CHARS} characters and one is ${item.text.length}. One line each: ` +
          `if an item needs a paragraph it is really several items, or it belongs in the plan.`,
      };
    }
    if (!isTodoStatus(item.status)) {
      return {
        reason: `"${String(item.status)}" is not a status. Use ${TODO_STATUSES.join(", ")}.`,
      };
    }
  }
  return undefined;
}

/**
 * How the tools report back, so a mid-turn change is visible in the message array.
 *
 * The system prompt is built once per turn, so an update at round 5 is not in the prompt at round
 * 300. Echoing the whole new state in the tool result is what closes that gap — the agent sees its
 * own list, in the history, where in-turn pruning does not reach.
 */
export function describeTodos(todos: readonly TodoItem[]): string {
  if (todos.length === 0) return "The todo list is now empty.";
  const done = todos.filter(item => item.status === "done").length;
  return [
    `Todo list updated — ${done}/${todos.length} done:`,
    ...todos.map(item => `- [${MARKERS[item.status]}] ${item.text}`),
  ].join("\n");
}
