/**
 * The speaking right of a host-initiated message (INV-1459): what it is for, and whether the
 * state it claims actually holds.
 *
 * A person's own turn answers them; that is the conversation and no gate stands in it. Every
 * other message into a chat is the host or an agent deciding to speak, and until now the only
 * checks were after the fact (answer review) and by volume (the follow-up budget). Neither
 * answers "what is this message for, and is that true": a result for work that is not finished,
 * an answer to a question nobody asked, a question that is not the one on file all went out.
 *
 * So a push names its purpose, and the gate reads the world for it:
 *
 *   - `result`    the task it reports is in review, done or dropped
 *   - `attention` the question it carries is the one that is pending, word for word
 *   - `answer`    a reply is owed to that person, and this one consumes it
 *   - `ack`       at most one per message a person sent
 *   - `notice`    the host reporting what it did or saw; allowed, and counted
 *   - `draft`     an agent's draft from the Outbox (INV-1739): a person approved it
 *
 * A refusal is returned with its reason — to the agent, never swallowed — and written to the
 * policy ledger, so a prompt that keeps trying to announce an unfinished draft leaves a trail.
 */

export type OutboundPurpose =
  | { kind: "result"; taskId: string }
  | { kind: "attention"; ref: string; question: string }
  | { kind: "answer"; deliveryId: string }
  | { kind: "ack"; messageId: string }
  | { kind: "notice"; about?: string }
  | { kind: "draft"; id: string };

/** What the gate reads; each answers one purpose's claim. */
export interface OutboundWorld {
  /** The task's status, or undefined for a task that does not exist. */
  taskStatus: (taskId: string) => string | undefined;
  /** The question pending under this ref: a watched question's id, or a blocked task's id. */
  pendingQuestion: (ref: string) => string | undefined;
  /** Whether an answer is still owed under this delivery id. */
  answerOwed: (deliveryId: string) => boolean;
  /** Whether a person approved this Outbox draft (outbox-drafts.ts); absent means no draft is. */
  draftApproved?: (id: string) => boolean;
}

export type OutboundVerdict = { allow: true } | { allow: false; reason: string };

const RESULT_STATES: ReadonlySet<string> = new Set(["review", "done", "dropped"]);

/**
 * The gate. `acked` is the messages already acknowledged, kept by the caller so a restart
 * does not forget them where it matters; in memory it still stops a double ack within a run.
 */
export function outboundVerdict(purpose: OutboundPurpose, world: OutboundWorld, acked: Set<string>): OutboundVerdict {
  switch (purpose.kind) {
    case "result": {
      const status = world.taskStatus(purpose.taskId);
      if (status === undefined) return { allow: false, reason: `result refused: task ${purpose.taskId} does not exist` };
      if (!RESULT_STATES.has(status)) return { allow: false, reason: `result refused: task ${purpose.taskId} is ${status}, not finished — report progress on the board, deliver when it is in review or done` };
      return { allow: true };
    }
    case "attention": {
      const pending = world.pendingQuestion(purpose.ref);
      if (pending === undefined) return { allow: false, reason: `attention refused: no question is pending under ${purpose.ref}` };
      if (pending.trim() !== purpose.question.trim()) return { allow: false, reason: `attention refused: the question on file under ${purpose.ref} is not this one` };
      return { allow: true };
    }
    case "answer":
      return world.answerOwed(purpose.deliveryId) ? { allow: true } : { allow: false, reason: `answer refused: nothing is owed under ${purpose.deliveryId}` };
    case "ack":
      if (acked.has(purpose.messageId)) return { allow: false, reason: `ack refused: ${purpose.messageId} was already acknowledged` };
      acked.add(purpose.messageId);
      return { allow: true };
    case "notice":
      return { allow: true };
    case "draft":
      return world.draftApproved?.(purpose.id) === true ? { allow: true } : { allow: false, reason: `draft refused: ${purpose.id} is not approved by a person — it waits in the Outbox` };
  }
}

/** One line for the audit row and the log: the purpose and what it names. */
const ANSWER_PREFIX = "answer owed as ";
/** Reads the host's own persisted transport-purpose format, including old queue records. */
export function answerDeliveryId(purpose: string): string | null | undefined { return !purpose.startsWith(ANSWER_PREFIX) ? undefined : purpose.length > ANSWER_PREFIX.length ? purpose.slice(ANSWER_PREFIX.length) : null; }

export function describePurpose(purpose: OutboundPurpose): string {
  switch (purpose.kind) {
    case "result": return `result for ${purpose.taskId}`;
    case "attention": return `attention under ${purpose.ref}`;
    case "answer": return ANSWER_PREFIX + purpose.deliveryId;
    case "ack": return `ack of ${purpose.messageId}`;
    case "notice": return purpose.about === undefined ? "notice" : `notice: ${purpose.about}`;
    case "draft": return `outbox draft ${purpose.id}`;
  }
}

/** The question a blocked task puts to its person, as the board card words it; undefined for any other task. */
export function blockedQuestion(task: { id: string; title: string; status: string; history: readonly { note?: string; options?: readonly string[] }[] } | undefined): string | undefined {
  if (task === undefined || task.status !== "blocked") return undefined;
  const last = task.history.at(-1);
  return last?.note === undefined || last.options === undefined || last.options.length === 0 ? undefined : `${task.id}「${task.title}」卡住了：${last.note}`;
}
