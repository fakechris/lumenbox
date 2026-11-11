/** Recovery of a reply is a transport decision, never acceptance of the underlying work. */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { Delivery, Deliveries } from "./deliveries.ts";
import type { Task } from "./tasks.ts";
import type { Outbox, Receipt } from "./outbox.ts";
import { answerDeliveryId } from "./outbound.ts";
import { appendLineDurably, type LedgerKind } from "./jsonl.ts";
import { redactText } from "./secret-redaction.ts";
export const LEDGER_KIND: LedgerKind = "record";
const STALE_MS = 7 * 24 * 3_600_000;
type Phase = "sending" | "sent" | "unknown" | "discarded";
interface Decision { schema: "delivery-disposition/v1"; id: string; phase: Phase; by: string; at: string; delivery: Delivery; title: string; reason?: string; externalEffectUnconfirmed?: boolean }
export interface RecoveryView {
  id: string; title: string; agentId: string; taskId?: string; conversation: string; destination: string; at: string;
  phase: "ready" | "waiting" | "needs_review" | "cancelled" | Phase;
  source: "verified" | "legacy" | "missing" | "conflict";
  reason: string; content: string; contentIncluded: boolean; canSend: boolean; canDiscard: boolean; token: string; externalEffectUnconfirmed?: boolean;
}
interface Dependencies {
  deliveries: Deliveries; outbox: Outbox; decisionsPath: string;
  task: (id: string) => Task | undefined; reply: (delivery: Delivery) => string;
  isWorking: (delivery: Delivery) => boolean;
  send: (delivery: Delivery, reply: string) => Promise<void>;
  now?: () => Date;
}

export class DeliveryRecovery {
  private readonly signingKey = randomBytes(32);
  private readonly busy = new Set<string>();
  private readonly now: () => Date;
  constructor(private readonly deps: Dependencies) { this.now = deps.now ?? (() => new Date()); }

  private decisions(): Map<string, Decision> {
    const rows = new Map<string, Decision>();
    if (!existsSync(this.deps.decisionsPath)) return rows;
    for (const line of readFileSync(this.deps.decisionsPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const row = JSON.parse(line) as Decision;
      if (row.schema !== "delivery-disposition/v1" || !row.id || !["sending", "sent", "unknown", "discarded"].includes(row.phase) || row.delivery?.id !== row.id || !row.by || !row.at) throw new Error("Invalid delivery disposition; recovery is held until its durable record is restored.");
      rows.set(row.id, row);
    }
    return rows;
  }
  private record(delivery: Delivery, title: string, phase: Phase, by: string, extras: Partial<Pick<Decision, "reason" | "externalEffectUnconfirmed">> = {}): void {
    appendLineDurably(this.deps.decisionsPath, JSON.stringify({ schema: "delivery-disposition/v1", id: delivery.id, phase, by, at: this.now().toISOString(), delivery: { ...delivery, ...(delivery.requestTitle ? { requestTitle: redactText(delivery.requestTitle) } : {}) }, title, ...extras, ...(extras.reason ? { reason: redactText(extras.reason) } : {}) } satisfies Decision));
  }
  private pending(id: string): Delivery | undefined { return this.deps.deliveries.entries().find(row => row.id === id); }

  private view(delivery: Delivery, decision?: Decision, includeContent = true): RecoveryView {
    const id = delivery.id;
    const task = delivery.taskId ? this.deps.task(delivery.taskId) : undefined;
    const title = redactText(task?.title || delivery.requestTitle || decision?.title || `Old reply from ${delivery.at.slice(0, 10)}; original request unavailable`).slice(0, 200);
    let raw = "";
    try { if (includeContent) raw = this.deps.reply(delivery).trim(); } catch { /* Missing source is an explicit state, not an executable request. */ }
    const root = task?.workRoot;
    const causal = !!delivery.messageId && (task?.sourceMessageId === delivery.messageId || root?.requests?.some(row => row.id === delivery.messageId));
    const conflict = task && (task.assigneeId !== delivery.agentId || (task.conversation ?? "main") !== delivery.conversation || root && (root.state.owner !== delivery.agentId || root.state.conversation !== delivery.conversation || root.state.taskId !== undefined && root.state.taskId !== task.id));
    const source: RecoveryView["source"] = !task ? "missing" : conflict ? "conflict" : causal && root && !root.state.unresolved ? "verified" : "legacy";
    let phase: RecoveryView["phase"] = "ready", reason = "The original request and reply are linked.";
    if (this.deps.isWorking(delivery)) { phase = "waiting"; reason = "The original execution has not finished."; }
    else if (!this.deps.deliveries.isCurrent(delivery) || root?.cancellation || root?.state.status === "cancelled") { phase = "cancelled"; reason = "This work was cancelled; its old reply will not be sent."; }
    else if (includeContent && !raw || !task) { phase = "needs_review"; reason = "The original request or reply is unavailable; do not reconstruct or resend it."; }
    else if (delivery.kind === "interaction" && (task.status === "done" || task.status === "dropped")) { phase = "needs_review"; reason = "The interaction has ended but an old reply remains pending."; }
    else if (source !== "verified" || !Number.isFinite(Date.parse(delivery.at)) || this.now().getTime() - Date.parse(delivery.at) > STALE_MS) { phase = "needs_review"; reason = source === "conflict" ? "The sending agent differs from the task's current assignee; inspect the reply and destination." : "This historical reply requires inspection before sending."; }
    if (!includeContent && phase === "ready") { phase = "needs_review"; reason = "Open this reply to inspect its content and current authorization."; }
    if (decision) { phase = decision.phase === "sending" && !this.busy.has(id) ? "unknown" : decision.phase; reason = decision.reason ?? (phase === "unknown" ? "A prior send may have reached the recipient; its outcome is unknown." : `Reply disposition: ${phase}.`); }
    const canSend = includeContent && this.deps.deliveries.isCurrent(delivery) && !!raw && !!task && !this.deps.isWorking(delivery) && !root?.cancellation && root?.state.status !== "cancelled" && !["sending", "sent", "discarded"].includes(phase);
    const row = { id, title, agentId: delivery.agentId, ...(delivery.taskId ? { taskId: delivery.taskId } : {}), conversation: delivery.conversation, destination: delivery.chatKey, at: delivery.at, phase, source, reason, content: redactText(raw).slice(0, 8000), contentIncluded: includeContent, canSend, canDiscard: phase !== "sent" && phase !== "discarded", ...(decision?.externalEffectUnconfirmed ? { externalEffectUnconfirmed: true } : {}) };
    const signature = JSON.stringify([row, createHash("sha256").update(raw).digest("hex"), task?.updatedAt, task?.workRoot, decision]);
    return { ...row, token: createHmac("sha256", this.signingKey).update(signature).digest("hex") };
  }
  preview(id: string): RecoveryView | undefined {
    const decision = this.decisions().get(id), delivery = this.pending(id) ?? decision?.delivery;
    return delivery ? this.view(delivery, decision) : undefined;
  }
  list(limit = 50, offset = 0, allowed: (row: Delivery) => boolean = () => true): RecoveryView[] {
    const decisions = this.decisions(), deliveries = new Map(this.deps.deliveries.entries().map(row => [row.id, row]));
    for (const row of decisions.values()) if (!deliveries.has(row.id)) deliveries.set(row.id, row.delivery);
    const start = Number.isFinite(offset) ? Math.max(0, Math.trunc(offset)) : 0;
    const count = Number.isFinite(limit) ? Math.min(100, Math.max(1, Math.trunc(limit))) : 50;
    return [...deliveries.values()].filter(allowed).slice(start, start + count).map(row => this.view(row, decisions.get(row.id), false));
  }
  private pinned(id: string, token: string): { delivery: Delivery; view: RecoveryView } {
    const view = this.preview(id), delivery = this.pending(id) ?? this.decisions().get(id)?.delivery;
    if (!view || !delivery || view.token !== token) throw new Error("The reply or its state changed; preview it again before acting.");
    return { delivery, view };
  }
  discard(id: string, token: string, by: string): RecoveryView {
    const existing = this.preview(id); if (existing?.phase === "discarded") return existing;
    const { delivery, view } = this.pinned(id, token);
    if (view.phase === "sent") throw new Error("The reply has already been sent; discarding cannot undo it.");
    if (view.phase !== "discarded") this.record(delivery, view.title, "discarded", by, { reason: "The operator chose not to send this old reply.", ...(this.busy.has(id) || view.phase === "unknown" ? { externalEffectUnconfirmed: true } : {}) });
    // The durable decision comes first; old queue callbacks cannot undo it, even after compaction.
    for (const receipt of this.deps.outbox.pending()) if (answerDeliveryId(receipt.purpose) === id) this.deps.outbox.dropped(receipt.id, "Reply discarded by the operator");
    this.deps.deliveries.close(id);
    return this.preview(id)!;
  }
  async send(id: string, token: string, by: string): Promise<RecoveryView> {
    const existing = this.preview(id); if (existing?.phase === "sent") return existing;
    const { delivery, view } = this.pinned(id, token);
    if (!view.canSend || this.busy.has(id)) throw new Error("This reply cannot be sent in its current state.");
    this.record(delivery, view.title, "sending", by); this.busy.add(id);
    try {
      await this.deps.send(delivery, this.deps.reply(delivery).trim());
      if (this.decisions().get(id)?.phase === "discarded") {
        this.record(delivery, view.title, "discarded", by, { reason: "The old send had already started when it was discarded; it may have reached the recipient.", externalEffectUnconfirmed: true });
      } else { this.record(delivery, view.title, "sent", by); this.deps.deliveries.close(id); }
    } catch (error) {
      if (this.decisions().get(id)?.phase !== "discarded") this.record(delivery, view.title, "unknown", by, { reason: `The send was not confirmed: ${error instanceof Error ? error.message.slice(0, 200) : "unknown error"}`, externalEffectUnconfirmed: true });
    } finally { this.busy.delete(id); }
    return this.preview(id)!;
  }
  async sweep(): Promise<void> {
    for (const delivery of this.deps.deliveries.entries()) {
      const view = this.preview(delivery.id);
      if (view?.phase === "ready") await this.send(delivery.id, view.token, "host");
    }
  }
  /** Rechecked before every outbox retry, including jobs already queued in a chat's chain. */
  authorizeReceipt(receipt: Pick<Receipt, "purpose">): { allow: boolean; terminal?: boolean; reason?: string } {
    const id = answerDeliveryId(receipt.purpose);
    if (id === null) return { allow: false, reason: "The answer receipt has no delivery identity" };
    if (!id) return { allow: true };
    const decision = this.decisions().get(id);
    const delivery = this.pending(id) ?? decision?.delivery;
    const root = delivery?.taskId ? this.deps.task(delivery.taskId)?.workRoot : undefined;
    if (root?.cancellation || root?.state.status === "cancelled") return { allow: false, terminal: true, reason: "The work was cancelled" };
    if (decision?.phase === "sent" || decision?.phase === "discarded") return { allow: false, terminal: true, reason: "The reply has ended or was discarded" };
    if (decision?.phase === "sending") return { allow: this.busy.has(id), reason: "A prior send requires inspection" };
    if (decision) return { allow: false, reason: "The prior send has an unknown outcome" };
    return { allow: this.preview(id)?.phase === "ready", reason: "The reply requires inspection" };
  }
  allowReceipt(receipt: Pick<Receipt, "purpose">): boolean { return this.authorizeReceipt(receipt).allow; }
}
