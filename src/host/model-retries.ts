/** Consecutive failures reset on success; the work's durable recovery allowance does not. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appendLineDurably } from "./jsonl.ts";
import { MAX_TURN_RETRIES, MAX_WORK_RETRIES } from "./transient.ts";

export class ModelRetries {
  private consecutive = 0;
  private turn = 0;
  private work = 0;
  private held = 0;
  private readonly path: string;
  constructor(dir: string, workId: string, private readonly turnLimit = MAX_TURN_RETRIES, private readonly workLimit = MAX_WORK_RETRIES) {
    this.path = join(dir, "model-retries", `${createHash("sha256").update(workId).digest("hex")}.jsonl`);
    this.refresh();
  }
  private refresh(): void {
    this.work = 0; this.held = 0;
    if (existsSync(this.path)) {
      // Malformed durable state fails closed rather than silently restoring paid attempts.
      for (const line of readFileSync(this.path, "utf8").split("\n").filter(Boolean)) {
        const row = JSON.parse(line) as { retry?: number; heldCost?: number };
        if (row.heldCost !== undefined && Number.isFinite(row.heldCost) && row.heldCost >= 0) this.held += row.heldCost;
        else if (row.retry !== undefined && Number.isSafeInteger(row.retry) && row.retry === this.work + 1) this.work = row.retry;
        else throw new Error("Invalid model recovery ledger");
      }
    }
  }
  get heldCost(): number { this.refresh(); return this.held; }
  holdCost(cost: number): void {
    if (!Number.isFinite(cost) || cost < 0) throw new Error("Invalid recovery cost bound");
    mkdirSync(dirname(this.path), { recursive: true });
    appendLineDurably(this.path, JSON.stringify({ heldCost: cost }));
  }
  get attempt(): number { return this.consecutive + 1; }
  get exhausted(): boolean { return this.turn >= this.turnLimit || this.work >= this.workLimit; }
  succeeded(): void { this.consecutive = 0; }
  /** Reserve before the paid retry, so process restart cannot refund it. */
  reserve(): boolean {
    this.refresh(); // another execution of the same work may have reserved since construction
    if (this.exhausted) return false;
    mkdirSync(dirname(this.path), { recursive: true });
    appendLineDurably(this.path, JSON.stringify({ retry: this.work + 1 }));
    this.work++; this.turn++; this.consecutive++;
    return true;
  }
}
