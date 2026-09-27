/**
 * The completion gate of goal mode (docs/74 §3.4, §7 R1/R2/R3/R12; INV-771).
 *
 * An executor cannot finish a goal; it can only claim to, and the claim is judged by things it
 * does not control. First the host's own checks, which cost no model: open todos, and artifact
 * paths that must be in the workspace manifest taken at the moment of the claim. Then a
 * verifier — the same agent in a conversation with no history of the work, holding read tools
 * and a bash that runs only the commands the person confirmed — reads the current state and
 * answers item by item. Its verdict is parsed, not read. It fails closed: no verdict, an
 * unparsable one, a workspace that changed while it looked, a verifier turn that failed — each
 * is a rejection, never a pass. A pass moves the task to review, where the person's word is
 * done; a rejection returns the goal to `active` with the verifier's next action, and the
 * third rejection in a row hands the disagreement to the person.
 *
 * The verifying state is on the board, with the verifier's conversation and attempt, so a
 * process that restarts mid-verification finds it: a verdict already in that conversation's
 * transcript is applied; anything less is the interrupted case and is rejected.
 */
import type { InboundMessage } from "../agents/bus.ts";
import type { AgentRegistry } from "../agents/registry.ts";
import { createHash } from "node:crypto";
import type { Task, TaskStore } from "./tasks.ts";
import {
  type GoalMarker,
  type GoalVerdict,
  MAX_VERIFY_ATTEMPTS,
  MAX_VERIFY_REJECTIONS,
  type Pursuit,
  VERIFIER_TOOLS,
  parseGoalVerdict,
  verdictNotice,
  verifierPrompt,
} from "./goal-mode.ts";
import type { GoalTurnReport } from "./goal-loop.ts";

export interface GoalGateDeps {
  tasks: TaskStore;
  registry: Pick<AgentRegistry, "readDurableState" | "readTranscript">;
  bus: {
    sendFromUser(agentId: string, text: string, options: { conversation?: string; steerable?: boolean; lane?: "user" | "agent" | "background"; synthetic?: boolean; toolScope?: readonly string[]; goal?: GoalMarker }): number | undefined;
    wake(agentId: string): Promise<void>;
  };
  /** The workspace as path→hash, when there is a box to ask. */
  manifest?: () => Promise<Map<string, string> | undefined>;
  notify: (task: Task, text: string) => Promise<void>;
  log: (line: string) => void;
  now?: () => Date;
}

export type ClaimResult = { accepted: true; text: string } | { accepted: false; text: string };

/** One digest for a manifest, so the board stores a line rather than the tree. */
export function manifestHashOf(manifest: Map<string, string>): string {
  const hash = createHash("sha256");
  for (const [path, digest] of [...manifest.entries()].sort()) hash.update(`${path}\t${digest}\n`);
  return hash.digest("hex").slice(0, 16);
}

/** The conversation a verifier speaks in: this goal's, this attempt's, and nobody else's history. */
export function verifierConversation(taskId: string, claimNo: number): string {
  return `goalverify-${taskId}-${claimNo}`;
}

export class GoalGate {
  private seq = 0;

  constructor(private readonly deps: GoalGateDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /**
   * The executor's claim, from the Goal tool. Returns what the tool answers. Only an accepted
   * claim starts a verifier; a rejected one is a rejection on the record, like the verifier's.
   */
  async claim(taskId: string, agentId: string, evidence: readonly { id: string; evidence: string }[]): Promise<ClaimResult> {
    const task = this.deps.tasks.get(taskId);
    const pursuit = task?.pursuit;
    if (task === undefined || pursuit === undefined) return { accepted: false, text: `No goal ${taskId}.` };
    if (task.assigneeId !== agentId) return { accepted: false, text: `Goal ${taskId} is ${task.assigneeId ?? "nobody"}'s to claim.` };
    if (pursuit.status === "verifying") return { accepted: false, text: `Goal ${taskId} is already being verified (attempt ${pursuit.verifying?.attempt ?? 1}). Wait for the verdict.` };
    if (pursuit.status !== "active") return { accepted: false, text: `Goal ${taskId} is ${pursuit.status}; only an active goal can be claimed complete.` };
    if (pursuit.checklist.length === 0) return { accepted: false, text: "The checklist is empty. Add what would prove the objective is done (checklist_add) before claiming it is." };
    const conversation = task.conversation;
    if (conversation === undefined) return { accepted: false, text: `Goal ${taskId} has no conversation.` };

    // The host's own checks (docs/74 §3.4 step 1). Todos are the executor's own list, so an open
    // one is a hint rather than proof of anything — but claiming "done" over "doing" is the
    // shape the gate exists to refuse.
    const durable = this.deps.registry.readDurableState(agentId, conversation);
    const open = (durable.todos ?? []).filter(todo => todo.status === "pending" || todo.status === "doing");
    if (open.length > 0) {
      return { accepted: false, text: `Not claimed: ${open.length} todo(s) are still ${open.map(todo => `${todo.status} (${todo.text.slice(0, 60)})`).join("; ")}. Finish them, or mark them done with a reason, then claim.` };
    }
    const manifest = await this.deps.manifest?.();
    const missing = pursuit.checklist.filter(item => item.check?.kind === "artifact" && manifest !== undefined && !manifest.has(item.check.path));
    const claimNo = pursuit.spent.rejections + 1;
    const at = this.now().toISOString();
    const items = pursuit.checklist.map(item => ({ id: item.id, evidence: (evidence.find(entry => entry.id === item.id)?.evidence ?? "").trim().slice(0, 300) }));
    if (missing.length > 0) {
      const verdict: GoalVerdict = {
        passed: false,
        items: pursuit.checklist.map(item => ({ id: item.id, verdict: missing.includes(item) ? "contradicted" : "unverified", ...(missing.includes(item) ? { evidence: `not in the workspace: ${(item.check as { path: string }).path}` } : {}) })),
        nextAction: `Produce the missing artifact(s): ${missing.map(item => (item.check as { path: string }).path).join(", ")}`,
        body: "host check: artifact missing",
      };
      this.reject(task.id, verdict, `claim ${claimNo} rejected by the host's artifact check`, "rejected");
      return { accepted: false, text: `Not claimed: ${verdict.nextAction}. The goal stays active.` };
    }

    const verifyConversation = verifierConversation(task.id, claimNo);
    const seq = ++this.seq;
    this.deps.tasks.setPursuit(
      task.id,
      current => ({
        ...current,
        status: "verifying",
        claim: { at, items },
        verifying: { startedAt: at, conversation: verifyConversation, attempt: 1, ...(manifest !== undefined ? { manifestHash: manifestHashOf(manifest) } : {}) },
      }),
      `claim ${claimNo}: completion claimed; verifying in ${verifyConversation}`
    );
    this.deps.log(`goal ${task.id}: claim ${claimNo} accepted; verifier starts in ${verifyConversation}`);
    this.startVerifier(this.deps.tasks.get(task.id)!, agentId, seq);
    return { accepted: true, text: `Claim recorded. A verifier is checking every item against the current state; do not modify the workspace until it answers. Stopping now is fine — the verdict reaches the person, not you.` };
  }

  private startVerifier(task: Task, agentId: string, seq: number): void {
    const pursuit = task.pursuit!;
    const confirmedCommands = pursuit.checklist
      .filter(item => item.check?.kind === "command" && item.confirmed)
      .map(item => (item.check as { command: string }).command);
    const chinese = /[一-鿿]/.test(pursuit.objective);
    const marker: GoalMarker = {
      taskId: task.id,
      workId: pursuit.workId,
      seq,
      personSeq: 0,
      verify: { attempt: pursuit.verifying?.attempt ?? 1, confirmedCommands },
    };
    this.deps.bus.sendFromUser(agentId, verifierPrompt(task, chinese), {
      conversation: pursuit.verifying!.conversation,
      synthetic: true,
      steerable: false,
      lane: "background",
      toolScope: VERIFIER_TOOLS,
      goal: marker,
    });
    void this.deps.bus.wake(agentId);
  }

  /** The verifier's turn ended; parse, compare the workspace, and settle the claim. */
  async verifierEnded(report: GoalTurnReport): Promise<void> {
    const marker = report.marker;
    if (marker.verify === undefined) return;
    const task = this.deps.tasks.get(marker.taskId);
    const pursuit = task?.pursuit;
    if (task === undefined || pursuit === undefined || pursuit.status !== "verifying" || pursuit.verifying?.attempt !== marker.verify.attempt) {
      this.deps.log(`goal ${marker.taskId}: verifier report ignored (${pursuit?.status ?? "no goal"}, attempt ${marker.verify.attempt})`);
      return;
    }
    // The verifier's spend is the goal's spend (INV-772): ZCode left it off the books.
    if (report.cost !== undefined && report.cost > 0) {
      this.deps.tasks.setPursuit(task.id, current => ({ ...current, spent: { ...current.spent, cost: current.spent.cost + report.cost! } }), `verification attempt ${marker.verify.attempt} cost ${Math.round(report.cost)}`);
    }
    const verdict = report.how === "done" && report.finalText !== undefined ? parseGoalVerdict(report.finalText, pursuit.checklist) : undefined;
    if (verdict === undefined) {
      await this.noVerdict(task, `the verifier ${report.how === "done" ? "ended without a parsable verdict" : report.how}`, task.assigneeId!);
      return;
    }
    const manifest = await this.deps.manifest?.();
    if (pursuit.verifying.manifestHash !== undefined && manifest !== undefined && manifestHashOf(manifest) !== pursuit.verifying.manifestHash) {
      this.reject(task.id, { ...verdict, passed: false, nextAction: "The workspace changed while it was being verified; claim again once the work is still." }, "verification voided: the workspace changed during it", "rejected");
      await this.tell(task, verdictNotice(this.deps.tasks.get(task.id)!, verdict, "rejected"));
      return;
    }
    if (verdict.passed) {
      this.deps.tasks.setPursuit(
        task.id,
        current => ({
          ...current,
          status: "complete",
          verifying: undefined,
          checklist: current.checklist.map(item => ({ ...item, verdict: verdict.items.find(entry => entry.id === item.id)?.verdict ?? item.verdict })),
          lastVerdict: { at: this.now().toISOString(), passed: true, items: verdict.items },
        }),
        `verified complete on attempt ${marker.verify.attempt}: every item proven; awaiting the person's acceptance`
      );
      this.deps.log(`goal ${task.id}: verified complete; in review`);
      await this.tell(task, verdictNotice(this.deps.tasks.get(task.id)!, verdict, "passed"));
      return;
    }
    this.reject(task.id, verdict, `verifier rejected the claim: ${verdict.items.filter(item => item.verdict !== "proven").map(item => `${item.id} ${item.verdict}`).join(", ")}`, "rejected");
    const after = this.deps.tasks.get(task.id)!;
    await this.tell(after, verdictNotice(after, verdict, after.pursuit!.status === "paused" ? "needs_person" : "rejected"));
  }

  /** A verifier that produced no verdict: once more, then the person. Never a pass (review R2). */
  private async noVerdict(task: Task, why: string, agentId: string): Promise<void> {
    const attempt = task.pursuit!.verifying!.attempt;
    if (attempt < MAX_VERIFY_ATTEMPTS) {
      this.deps.tasks.setPursuit(task.id, current => ({ ...current, verifying: { ...current.verifying!, attempt: attempt + 1, startedAt: this.now().toISOString() } }), `verification attempt ${attempt} gave no verdict (${why}); trying once more`);
      this.deps.log(`goal ${task.id}: ${why}; verifier attempt ${attempt + 1}`);
      this.startVerifier(this.deps.tasks.get(task.id)!, agentId, ++this.seq);
      return;
    }
    const verdict: GoalVerdict = { passed: false, items: task.pursuit!.checklist.map(item => ({ id: item.id, verdict: "unverified" })), nextAction: "Verification could not be completed; the person decides.", body: why };
    this.reject(task.id, verdict, `no verdict after ${attempt} attempts (${why})`, "needs_person");
    await this.tell(this.deps.tasks.get(task.id)!, verdictNotice(this.deps.tasks.get(task.id)!, verdict, "needs_person"));
  }

  /**
   * A rejection: recorded, the checklist marked, the goal back to active with the next action
   * for the loop to carry — unless this is the third in a row, or the caller says the person
   * must decide, in which case the goal pauses and says so.
   */
  private reject(taskId: string, verdict: GoalVerdict, note: string, force: "rejected" | "needs_person"): void {
    this.deps.tasks.setPursuit(taskId, current => {
      const rejections = current.spent.rejections + 1;
      const toPerson = force === "needs_person" || rejections >= MAX_VERIFY_REJECTIONS;
      return {
        ...current,
        status: toPerson ? "paused" : "active",
        ...(toPerson ? { pausedReason: "needs_person" as const } : { pausedReason: undefined }),
        verifying: undefined,
        checklist: current.checklist.map(item => ({ ...item, verdict: verdict.items.find(entry => entry.id === item.id)?.verdict ?? item.verdict })),
        lastVerdict: { at: this.now().toISOString(), passed: false, items: verdict.items, ...(verdict.nextAction !== undefined ? { nextAction: verdict.nextAction } : {}) },
        spent: { ...current.spent, rejections, idleStreak: 0, stallStreak: 0 },
      };
    }, note);
    const after = this.deps.tasks.get(taskId)!.pursuit!;
    this.deps.log(`goal ${taskId}: claim rejected (${after.spent.rejections} in a row)${after.status === "paused" ? "; paused for the person" : "; continuing"}`);
  }

  /** On startup: a goal left verifying finds its verdict in the transcript, or fails closed. */
  async rearm(): Promise<number> {
    let seen = 0;
    for (const task of this.deps.tasks.list()) {
      const pursuit = task.pursuit;
      if (pursuit?.status !== "verifying" || pursuit.verifying === undefined || task.assigneeId === undefined) continue;
      seen += 1;
      const transcript = this.deps.registry.readTranscript(task.assigneeId, pursuit.verifying.conversation) as { role?: string; kind?: string; text?: string; blocks?: { type?: string; text?: string }[] }[];
      const last = [...transcript].reverse().find(entry => entry.role === "assistant" && (entry.text !== undefined || entry.blocks?.some(block => block.type === "text")));
      const text = last?.text ?? last?.blocks?.filter(block => block.type === "text").map(block => block.text ?? "").join("\n");
      const verdict = text === undefined ? undefined : parseGoalVerdict(text, pursuit.checklist);
      if (verdict !== undefined) {
        this.deps.log(`goal ${task.id}: verdict found in ${pursuit.verifying.conversation} after restart`);
        await this.verifierEnded({ marker: { taskId: task.id, workId: pursuit.workId, seq: ++this.seq, personSeq: 0, verify: { attempt: pursuit.verifying.attempt, confirmedCommands: [] } }, how: "done", worked: true, finalText: text });
        continue;
      }
      const interrupted: GoalVerdict = { passed: false, items: pursuit.checklist.map(item => ({ id: item.id, verdict: "unverified" })), nextAction: "Verification was interrupted by a restart; claim again when the work is still.", body: "interrupted" };
      this.reject(task.id, interrupted, "verification interrupted by a restart: no verdict in the transcript", "rejected");
      await this.tell(this.deps.tasks.get(task.id)!, verdictNotice(this.deps.tasks.get(task.id)!, interrupted, "interrupted"));
    }
    return seen;
  }

  /** For the turn loop: whether a goal-marked inbound is a verification the gate still wants. */
  verifierMayRun(inbound: readonly InboundMessage[]): boolean | undefined {
    const marker = inbound.find(message => message.goal?.verify !== undefined)?.goal;
    if (marker === undefined) return undefined;
    const pursuit = this.deps.tasks.get(marker.taskId)?.pursuit;
    return pursuit?.status === "verifying" && pursuit.verifying?.attempt === marker.verify!.attempt;
  }

  private async tell(task: Task, text: string): Promise<void> {
    try {
      await this.deps.notify(task, text);
    } catch (error) {
      this.deps.log(`goal ${task.id}: could not tell the person: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** Whether a bash command is one the person confirmed for this verification. */
export function commandIsConfirmed(marker: Pick<GoalMarker, "verify"> | undefined, command: string): boolean {
  if (marker?.verify === undefined) return true;
  const wanted = command.trim();
  return marker.verify.confirmedCommands.some(confirmed => confirmed.trim() === wanted);
}

export type { Pursuit };
