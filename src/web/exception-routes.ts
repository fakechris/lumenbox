/**
 * The Issues view's routes (INV-1741): the exception list grouped by task, and its three actions.
 *
 *   GET  /api/exceptions            open entries and the last week's resolved ones, by task
 *   POST /api/exceptions/retry      { id } — each kind through its own path (exceptions.ts)
 *   POST /api/exceptions/hand       { id } — becomes a decision on the attention strip
 *   POST /api/exceptions/dismiss    { id }
 *
 * Reading follows who may read the agent; acting needs the right to drive it — the same right a
 * prompt needs, since a Retry starts a turn or runs a command as that agent. An entry with no
 * agent (the box, a delivery the host sent) needs an admin.
 */

import type { BoxClient } from "../box/client.ts";
import { type ExceptionLedger, groupExceptions, retryException, type RetryDeps } from "../host/exceptions.ts";
import type { WatchedJob } from "../host/job-watch.ts";
import { apiError } from "./api-error.ts";

/** How long a retried command holds the request before it runs on as a job the watch settles. */
const FOREGROUND_MS = 10_000;

export interface ExceptionRouteDeps {
  ledger: ExceptionLedger;
  readJson: () => Promise<Record<string, unknown>>;
  /** Whether the caller may read this agent's entries; undefined is the installation's own. */
  mayRead: (agentId: string | undefined) => boolean;
  /** Refuses (and answers) when the caller may not act on this agent's entry; undefined needs an admin. */
  refused: (agentId: string | undefined) => boolean;
  by: () => string;
  titleOf: (taskId: string) => string | undefined;
  retry: RetryDeps;
}

export async function exceptionRoute(route: string, deps: ExceptionRouteDeps): Promise<{ status: number; body: unknown } | undefined> {
  if (route === "GET /api/exceptions") {
    const entries = deps.ledger.list().filter(entry => deps.mayRead(entry.agent));
    // The newest open entry of each task, for the Retry on its card.
    const byTask: Record<string, string> = {};
    for (const entry of entries) if (entry.task !== undefined && entry.resolvedAt === undefined && byTask[entry.task] === undefined) byTask[entry.task] = entry.id;
    return { status: 200, body: { open: entries.filter(entry => entry.resolvedAt === undefined).length, groups: groupExceptions(entries, deps.titleOf), byTask } };
  }
  const action = /^POST \/api\/exceptions\/(retry|hand|dismiss)$/.exec(route)?.[1];
  if (action === undefined) return undefined;
  const body = await deps.readJson();
  const id = String(body.id ?? "");
  const entry = deps.ledger.get(id);
  if (entry === undefined || !deps.mayRead(entry.agent)) return { status: 404, body: apiError("exception-unknown", { id }) };
  if (deps.refused(entry.agent)) return { status: 0, body: null };
  if (entry.resolvedAt !== undefined) return { status: 409, body: apiError("exception-resolved", { id }) };
  if (action === "hand") return { status: 200, body: { entry: deps.ledger.hand(id, deps.by()) } };
  if (action === "dismiss") return { status: 200, body: { entry: deps.ledger.dismiss(id, deps.by()) } };
  const outcome = await retryException(deps.ledger, id, deps.by(), deps.retry);
  return { status: 200, body: { ...outcome, entry: deps.ledger.get(id) } };
}

/** The five Retry paths, from what the server already holds: the orchestrator, the outbox, the box watch. */
export function exceptionRetryDeps(input: {
  ledger: ExceptionLedger;
  prompt: (agentId: string, text: string, conversation: string) => Promise<unknown>;
  boxFor: (agentId: string) => BoxClient | undefined;
  ownerOf: (agentId: string) => string | undefined;
  watch: (job: Omit<WatchedJob, "startedAt">) => void;
  by: () => string;
  redeliver: (chatKey: string) => Promise<{ tried: number; sent: number }>;
  runRoutine: (slug: string) => Promise<{ ok: true } | { ok: false; reason: string }>;
  reconnectBox: () => Promise<{ connected: boolean; detail: string }>;
}): RetryDeps {
  return {
    rerunTurn: async (agentId, conversation, note) => { await input.prompt(agentId, note, conversation); },
    rerunCommand: async (agentId, conversation, command) => {
      const box = input.boxFor(agentId);
      if (box === undefined) throw new Error("the agent's box is not connected");
      // The agent's own shell session for the conversation, so the command runs where it ran: same directory, same environment.
      const owner = input.ownerOf(agentId);
      const result = await box.exec(command, { session: `${agentId}/${conversation}`, foregroundMs: FOREGROUND_MS, actor: `person:${input.by()}`, ...(owner !== undefined ? { owner } : {}) });
      if (result.still_running !== undefined) {
        input.watch({ agentId, conversation, jobId: result.still_running.job_id, command, onEnd: "wake_on_failure" });
        return { running: true };
      }
      const tail = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
      return { exit_code: result.exit_code, tail };
    },
    redeliver: input.redeliver,
    runRoutine: input.runRoutine,
    reconnectBox: input.reconnectBox,
  };
}

/** A host message's try (outbox-sender.ts), onto the list: a failure counts against the chat, a send resolves it. */
export function noteDelivery(ledger: ExceptionLedger, event: "sent" | "failed" | "dropped", detail: { chatKey: string; error?: string }, taskOf: (chatKey: string) => string | undefined): void {
  if (event === "sent") { ledger.succeeded({ kind: "delivery", subject: detail.chatKey }); return; }
  const task = taskOf(detail.chatKey);
  ledger.failed({ kind: "delivery", subject: detail.chatKey, reason: `${event === "dropped" ? "dropped: " : ""}${detail.error ?? "could not send"}`, ...(task !== undefined ? { task } : {}) });
}
