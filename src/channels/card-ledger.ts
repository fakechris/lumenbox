/**
 * Where each task's chat card lives, durably.
 *
 * The card handle used to exist only inside the closure of the request that posted it,
 * which produced two lies people actually saw: a host restart orphaned every card of a
 * running task at "进行中" forever, and "可以" accepting reviewed work could not flip
 * the card to green because the acceptance arrives in a later message — a different
 * closure, no handle.
 *
 * One record per task: which adapter posted the card, the handle that rewrites it, and
 * the card as last drawn — enough to redraw it in any later process. Same jsonl shape
 * as every durable log here: append per change, latest line per task wins, torn tail
 * skipped on read. Entries close when the card reaches green; everything else is kept,
 * because "not done yet" is exactly the population a later flip is for.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appendLine } from "../host/jsonl.ts";
import { agentboxHome, envNumber } from "../config.ts";
import type { TaskCardState } from "./manager.ts";

export function cardLedgerPath(): string {
  return process.env.AGENTBOX_CARDS_LOG ?? join(agentboxHome(), "cards.jsonl");
}

export interface CardRecord {
  taskId: string;
  /** The adapter that posted it — the only wire whose handle this is. */
  adapter: string;
  handle: string;
  /** The card as last drawn, so a later process can redraw it whole. */
  card: TaskCardState;
}

type CardLine = { kind: "card"; record: CardRecord } | { kind: "closed"; taskId: string };

export class CardLedger {
  private readonly byTask = new Map<string, CardRecord>();
  private lines = 0;
  /** Read at construction, not import, so a test can set the threshold before building. */
  private readonly compactAt = envNumber("AGENTBOX_CARDS_COMPACT_AT", 2_000);

  constructor(
    private readonly path: string | null = cardLedgerPath(),
    private readonly onWarn: (message: string) => void = () => {}
  ) {
    this.replay();
  }

  record(record: CardRecord): void {
    this.byTask.set(record.taskId, record);
    this.append({ kind: "card", record });
  }

  get(taskId: string): CardRecord | undefined {
    const record = this.byTask.get(taskId);
    return record === undefined ? undefined : { ...record, card: { ...record.card } };
  }

  /** The card reached its final state; nothing will rewrite it again. */
  close(taskId: string): void {
    if (!this.byTask.delete(taskId)) return;
    this.append({ kind: "closed", taskId });
  }

  private append(line: CardLine): void {
    if (this.path === null) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendLine(this.path, JSON.stringify(line));
      this.lines += 1;
      if (this.lines > this.compactAt) this.compact();
    } catch (error) {
      // Never fail a card update over bookkeeping; the in-memory state still serves.
      const detail = error instanceof Error ? error.message : String(error);
      this.onWarn(`cards: cannot write ${this.path} (${detail})`);
    }
  }

  private replay(): void {
    if (this.path === null || !existsSync(this.path)) return;
    try {
      let lines = 0;
      for (const raw of readFileSync(this.path, "utf8").split("\n")) {
        if (raw.trim() === "") continue;
        lines += 1;
        try {
          const line = JSON.parse(raw) as CardLine;
          if (line.kind === "closed" && typeof line.taskId === "string") {
            this.byTask.delete(line.taskId);
          } else if (line.kind === "card" && typeof line.record?.taskId === "string") {
            this.byTask.set(line.record.taskId, line.record);
          }
        } catch {
          // A torn last line costs one update, not the ledger.
        }
      }
      this.lines = lines;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.onWarn(`cards: cannot read ${this.path} (${detail})`);
    }
  }

  private compact(): void {
    if (this.path === null) return;
    try {
      const kept = [...this.byTask.values()].map(record =>
        JSON.stringify({ kind: "card", record } satisfies CardLine)
      );
      const temp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(temp, kept.length > 0 ? `${kept.join("\n")}\n` : "", "utf8");
      renameSync(temp, this.path);
      this.lines = kept.length;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.onWarn(`cards: cannot compact ${this.path} (${detail})`);
    }
  }
}
