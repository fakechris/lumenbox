import { redactText } from "./secret-redaction.ts";
/** Resource revocations and operator receipts, never a second task or execution database. */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { appendLineDurably } from "./jsonl.ts";
export const LEDGER_KIND = "record";
import type { InboundMessage } from "../agents/admitted-message.ts";
import { messageWorkId } from "../agents/work-attention.ts";

export const resourceKey = (kind: string, id: string) =>
  JSON.stringify([kind, id]);
export const routineResource = (skill: { boxId?: string; slug: string }) =>
  resourceKey("routine", JSON.stringify([skill.boxId ?? "", skill.slug]));
export type GovernanceAction = "stop" | "pause" | "disable" | "discard";
export interface GovernedResource {
  key: string;
  kind: string;
  title: string;
  section: "running" | "future" | "history" | "members";
  state: string;
  source: string;
  conditions?: string[];
  condition?: string;
  next?: string;
  version: string;
  agentId?: string;
  boxId?: string;
  taskId?: string;
  conversation?: string;
  actions: GovernanceAction[];
  scope: string;
  unknown: string[];
  members?: string[];
  coverage?: { kind: string; count: number }[];
  target: Record<string, string>;
  archived?: boolean;
  revoked?: GovernanceAction;
}
export interface ResourceResult {
  key: string;
  state: "requested" | "confirmed" | "unconfirmed";
  detail?: string;
}
export interface Operation {
  schema: "work-governance/v1";
  id: string;
  digest: string;
  by: string;
  at: string;
  selections: { row: GovernedResource; action: GovernanceAction }[];
  prepared?: string[];
  results: ResourceResult[];
}
export class GovernanceLedger {
  private readonly operations = new Map<string, Operation>();
  private readonly barriers = new Map<string, GovernanceAction>();
  constructor(private readonly path: string | null = null) {
    if (path && existsSync(path))
      for (const line of readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)) {
        const row = JSON.parse(line) as Operation;
        if (
          row.schema !== "work-governance/v1" ||
          !row.id ||
          !Array.isArray(row.selections) ||
          !Array.isArray(row.results)
        )
          throw Error(
            "Invalid resource revocation ledger; restore it before running work.",
          );
        this.replay(row);
      }
  }
  private replay(row: Operation) {
    this.operations.set(row.id, row);
    for (const selection of row.selections)
      if (selection.action !== "pause") {
        this.barriers.set(selection.row.key, selection.action);
        if (selection.row.kind === "goal" && selection.row.target.workId)
          this.barriers.set(
            resourceKey("work", selection.row.target.workId),
            selection.action,
          );
      }
  }
  save(row: Operation) {
    if (this.path) appendLineDurably(this.path, JSON.stringify(row));
    this.replay(structuredClone(row));
  }
  pendingPause(agentId: string) {
    for (const operation of this.operations.values()) for (const selection of operation.selections) if (selection.action === "pause" && operation.results.find(result=>result.key===selection.row.key)?.state !== "confirmed" && selection.row.agentId === agentId && !operation.prepared?.includes(selection.row.key)) return { by: operation.by, at: operation.at, reason: "Selected member pause is awaiting durable handoff" };
    return undefined;
  }
  restorePauses(prepare: (agentId: string, by: string, at: string) => boolean): void {
    for (const stored of this.operations.values()) { const operation = structuredClone(stored); let changed = false;
      for (const selection of operation.selections) if (selection.action === "pause" && operation.results.find(result=>result.key===selection.row.key)?.state !== "confirmed" && selection.row.agentId && !operation.prepared?.includes(selection.row.key) && prepare(selection.row.agentId, operation.by, operation.at)) { operation.prepared = [...(operation.prepared ?? []), selection.row.key]; changed = true; }
      if (changed) this.save(operation);
    }
  }
  pendingOperations(): Operation[] { return [...this.operations.values()].filter(row => row.results.some(result => result.state !== "confirmed")).map(row => structuredClone(row)); }
  operation(id: string) {
    const row = this.operations.get(id);
    return row && structuredClone(row);
  }
  revoked(key: string) {
    return this.barriers.get(key);
  }
  /** Exact identity only. Unknown relationships confer no cancellation authority. */
  allows(message: InboundMessage): boolean {
    return (
      !this.revoked(resourceKey("message", message.id)) &&
      !(
        message.resumeOf &&
        this.revoked(resourceKey("recovery", message.resumeOf.id))
      ) &&
      ![
        messageWorkId(message),
        message.goal?.workId,
        message.resumeOf?.workId,
      ].some((id) => id && this.revoked(resourceKey("work", id)))
    );
  }
}
export interface GovernanceAdapter {
  inspect?(row: GovernedResource): GovernedResource;
  prepare?(
    selections: { row: GovernedResource; action: GovernanceAction }[],
    by: string,
  ): void;
  inventory(): Promise<{ rows: GovernedResource[]; unknown: string[] }>;
  apply(
    row: GovernedResource,
    action: GovernanceAction,
    by: string,
  ): Promise<{ confirmed: boolean; detail?: string }>;
  mayRead(row: GovernedResource): boolean;
}
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export class WorkGovernance {
  private readonly key = randomBytes(32);
  private readonly busy = new Set<string>();
  private readonly inFlight = new Map<string, Promise<Operation>>();
  private readonly previews = new Map<
    string,
    { selections: Operation["selections"]; at: number }
  >();
  constructor(readonly ledger: GovernanceLedger) {}
  operation(adapter: GovernanceAdapter, id: string, by: string) { const row = this.ledger.operation(id); if (!row || row.by !== by || row.selections.some(selection => !adapter.mayRead(selection.row))) throw Error("Operation unavailable."); return row; }
  async list(
    adapter: GovernanceAdapter,
    input: {
      section?: string;
      search?: string;
      offset?: number;
      limit?: number;
      archive?: boolean;
    },
  ) {
    const inventory = await adapter.inventory(),
      permitted = inventory.rows.filter((row) => adapter.mayRead(row));
    const rows = permitted.filter(
      (row) =>
        (input.archive || !row.archived &&
          !["ended", "cancelled", "sent", "discarded"].includes(row.state)) &&
        (!input.section ||
          (input.section === "automatic"
            ? row.section === "running" || row.section === "future"
            : row.section === input.section)) &&
        (!input.search ||
          `${row.title} ${row.source}`
            .toLowerCase()
            .includes(input.search.toLowerCase())),
    );
    const offset = Number.isFinite(input.offset)
        ? Math.max(0, Math.floor(input.offset!))
        : 0,
      limit = Number.isFinite(input.limit)
        ? Math.min(50, Math.max(1, Math.floor(input.limit!)))
        : 50;
    const counts = Object.fromEntries(
      ["running", "future", "history", "members"].map((section) => [
        section,
        permitted.filter((row) => row.section === section).length,
      ]),
    );
    rows.sort(
      (a, b) =>
        Number(["ended", "cancelled", "sent", "discarded"].includes(a.state)) -
          Number(
            ["ended", "cancelled", "sent", "discarded"].includes(b.state),
          ) || a.key.localeCompare(b.key),
    );
    return {
      metrics: {
        executions: permitted.filter((row) => row.kind === "execution").length,
        cards: permitted.filter(
          (row) => row.kind === "work" || row.kind === "record",
        ).length,
        future: permitted.filter(
          (row) =>
            row.section === "future" &&
            !this.ledger.revoked(row.key) &&
            !["paused", "disabled"].includes(row.state),
        ).length,
      },
      rows: rows
        .slice(offset, offset + limit)
        .map((row) => ({ ...row, revoked: this.ledger.revoked(row.key) })),
      total: rows.length,
      offset,
      limit,
      counts,
      unknown: inventory.unknown,
      observedAt: new Date().toISOString(),
    };
  }
  async preview(
    adapter: GovernanceAdapter,
    choices: { key: string; action: GovernanceAction }[],
  ) {
    if (
      !Array.isArray(choices) ||
      !choices.length ||
      choices.length > 100 ||
      new Set(choices.map((row) => row.key)).size !== choices.length
    )
      throw Error("Select 1–100 distinct resources.");
    const inventory = await adapter.inventory();
    const selections = choices.map((choice) => {
      const row = inventory.rows.find((row) => row.key === choice.key);
      if (!row || !adapter.mayRead(row) || !row.actions.includes(choice.action))
        throw Error("Selected resource unavailable or action not allowed.");
      return { row: adapter.inspect?.(row) ?? row, action: choice.action };
    });
    const hash = digest(selections),
      token = createHmac("sha256", this.key)
        .update(hash + randomBytes(16).toString("hex"))
        .digest("hex");
    for (const [id, preview] of this.previews)
      if (Date.now() - preview.at > 600_000) this.previews.delete(id);
    if (this.previews.size >= 100)
      this.previews.delete(this.previews.keys().next().value!);
    this.previews.set(token, { selections, at: Date.now() });
    return { token, selections, unknown: inventory.unknown };
  }
  execute(adapter: GovernanceAdapter, input: {token: string; operationId: string}, by: string): Promise<Operation> {
    const key = input.operationId, existing = this.inFlight.get(key); if (existing) return existing.then(() => this.execute(adapter,input,by));
    const pending = this.perform(adapter,input,by); this.inFlight.set(key,pending);
    void pending.then(()=>this.inFlight.delete(key),()=>this.inFlight.delete(key)); return pending;
  }
  private async perform(
    adapter: GovernanceAdapter,
    input: { token: string; operationId: string },
    by: string,
  ) {
    if (!/^[a-zA-Z0-9-]{8,100}$/.test(input.operationId))
      throw Error("Invalid operation identity.");
    let operation = this.ledger.operation(input.operationId);
    if (
      operation &&
      this.previews.has(input.token) &&
      digest(this.previews.get(input.token)!.selections) !== operation.digest
    )
      throw Error("Operation identity belongs to a different preview.");
    if (operation && operation.by !== by) throw Error("Operation unavailable.");
    if (!operation) {
      const preview = this.previews.get(input.token);
      if (!preview || Date.now() - preview.at > 600_000)
        throw Error("Preview expired; inspect the scope again.");
      const inventory = await adapter.inventory();
      for (const selection of preview.selections) {
        const current = inventory.rows.find(
          (row) => row.key === selection.row.key,
        );
        if (
          !current ||
          !adapter.mayRead(current) ||
          current.version !== selection.row.version
        )
          throw Error("Selected resources changed; preview again.");
      }
      operation = {
        schema: "work-governance/v1",
        id: input.operationId,
        digest: digest(preview.selections),
        by,
        at: new Date().toISOString(),
        selections: preview.selections,
        results: preview.selections.map(({ row }) => ({
          key: row.key,
          state: "requested",
        })),
      };
      // The entire explicit scope is barred before the first asynchronous cleanup.
      this.ledger.save(operation);
    }
    if (operation.selections.some(({ row }) => !adapter.mayRead(row)))
      throw Error("Resource access required for every selected scope.");
    if (this.busy.has(operation.id) || operation.results.every(result => result.state === "confirmed")) return operation;
    this.busy.add(operation.id);
    try {
      const unfinished = operation.selections.filter(selection => operation!.results.find(result => result.key === selection.row.key)?.state !== "confirmed");
      adapter.prepare?.(unfinished, by);
      operation.prepared = [...new Set([...(operation.prepared ?? []), ...unfinished.filter(selection => selection.action === "pause").map(selection => selection.row.key)])];
      this.ledger.save(operation);
      for (const selection of operation.selections) {
        const result = operation.results.find(
          (row) => row.key === selection.row.key,
        )!;
        if (result.state === "confirmed") continue;
        try {
          const applied = await adapter.apply(
            selection.row,
            selection.action,
            by,
          );
          result.state = applied.confirmed ? "confirmed" : "unconfirmed";
          result.detail = applied.detail;
        } catch (error) {
          result.state = "unconfirmed";
          result.detail =
            error instanceof Error
              ? redactText(error.message).slice(0, 500)
              : "Resource cleanup unconfirmed";
        }
        this.ledger.save(operation);
      }
      return operation;
    } finally {
      this.busy.delete(operation.id);
    }
  }
}
