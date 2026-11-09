/** Consecutive failures reset on success; the work's durable recovery allowance does not. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { appendLineDurably } from "./jsonl.ts";
import { MAX_TURN_RETRIES, MAX_WORK_RETRIES } from "./transient.ts";

export class ModelRetries {
  private consecutive = 0;
  private turn = 0;
  private work = 0;
  private held = 0;
  private measured = 0;
  private base = 0;
  private hasBase = false;
  private stamp = "";
  private readonly costs = new Map<string, number>();
  private readonly path: string;
  constructor(dir: string, workId: string, private readonly turnLimit = MAX_TURN_RETRIES, private readonly workLimit = MAX_WORK_RETRIES) {
    this.path = join(dir, "model-retries", `${createHash("sha256").update(workId).digest("hex")}.jsonl`);
    this.refresh();
  }
  private refresh(): void {
    const stat = existsSync(this.path) ? statSync(this.path) : undefined;
    const stamp = stat === undefined ? "absent" : `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    if (stamp === this.stamp) return;
    this.work = 0; this.held = 0; this.measured = 0; this.base = 0; this.hasBase = false; this.costs.clear();
    if (stat !== undefined && stat.size > 0) {
      // Malformed durable state fails closed rather than silently restoring paid attempts.
      for (const line of readFileSync(this.path, "utf8").split("\n").filter(Boolean)) {
        const row = JSON.parse(line) as { retry?: number; heldCost?: number; baseCost?: number; cost?: number; id?: string };
        if (row.heldCost !== undefined && Number.isFinite(row.heldCost) && row.heldCost >= 0) this.held += row.heldCost;
        else if (row.retry !== undefined && Number.isSafeInteger(row.retry) && row.retry === this.work + 1) this.work = row.retry;
        else if (row.baseCost !== undefined && !this.hasBase && Number.isFinite(row.baseCost) && row.baseCost >= 0) { this.base = row.baseCost; this.hasBase = true; }
        else if (typeof row.id === "string" && row.cost !== undefined && Number.isFinite(row.cost) && row.cost >= 0 && !this.costs.has(row.id)) { this.costs.set(row.id, row.cost); this.measured += row.cost; }
        else throw new Error("Invalid model recovery ledger");
      }
    }
    this.stamp = stamp;
  }
  private append(row: object): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendLineDurably(this.path, JSON.stringify(row));
    const stat = statSync(this.path); this.stamp = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  }
  /** Seed pre-upgrade reported spend once; it is not added again by later Goal reports. */
  seedCost(cost: number): void {
    this.refresh();
    if (this.hasBase) return;
    if (!Number.isFinite(cost) || cost < 0) throw new Error("Invalid initial Goal cost");
    this.append({ baseCost: cost }); this.base = cost; this.hasBase = true;
  }
  get hasCostLedger(): boolean { this.refresh(); return this.hasBase || this.costs.size > 0; }
  get knownCost(): number { this.refresh(); return this.base + this.measured; }
  /** Each paid response has one immutable identity, before tools or turn completion can crash. */
  recordCost(id: string, cost: number): void {
    this.refresh();
    if (!Number.isFinite(cost) || cost < 0) throw new Error("Invalid model response cost");
    const prior = this.costs.get(id);
    if (prior !== undefined) { if (prior !== cost) throw new Error("Model response cost changed"); return; }
    this.append({ id, cost }); this.costs.set(id, cost); this.measured += cost;
  }
  get heldCost(): number { this.refresh(); return this.held; }
  holdCost(cost: number): void {
    if (!Number.isFinite(cost) || cost < 0) throw new Error("Invalid recovery cost bound");
    this.refresh(); this.append({ heldCost: cost }); this.held += cost;
  }
  get attempt(): number { return this.consecutive + 1; }
  get exhausted(): boolean { return this.turn >= this.turnLimit || this.work >= this.workLimit; }
  succeeded(): void { this.consecutive = 0; }
  /** Reserve before the paid retry, so process restart cannot refund it. */
  reserve(): boolean {
    this.refresh(); // another execution of the same work may have reserved since construction
    if (this.exhausted) return false;
    this.append({ retry: this.work + 1 });
    this.work++; this.turn++; this.consecutive++;
    return true;
  }
}

/** Durable work totals include overlapping executor, verifier and background calls already. */
export function accountedGoalCost(current: number, reported: number, budget?: ModelRetries): number {
  return budget?.hasCostLedger ? Math.max(current, budget.knownCost) : current + reported;
}
