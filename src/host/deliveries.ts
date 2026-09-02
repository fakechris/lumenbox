/**
 * Answers that have been earned but not yet handed over.
 *
 * A channel request is answered by an awaited promise, and that promise is the only thing
 * that knows where the answer goes. Kill the process and it is gone — while the turn is
 * recovered from the ledger and runs to completion, so the work is done, the money is
 * spent, and the reply is delivered nowhere.
 *
 * The repair is small because the expensive part is already durable. A reply is not held
 * in memory anywhere: it is reconstructed from the transcript by `replySince(agent, index,
 * conversation)`, and the transcript is on disk. So all that has to survive a restart is
 * the *note of where an answer was owed* — four fields written when the request is
 * accepted — and the answer can be recovered and delivered afterwards by anything.
 *
 * That is what makes this structural rather than a sweep. Delivery stops depending on the
 * process that started the work being the one that finishes it.
 *
 * Append-only, and read by replaying: a close is a record rather than an edit, so a
 * process that dies mid-write leaves a torn last line and nothing else, which every reader
 * here already skips. Compacted when the file grows, because it is a queue and not a
 * history — what has been delivered is of no further interest.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appendLine } from "./jsonl.ts";

/** Rewrite the file once the settled entries outnumber this. */
const COMPACT_AT = 200;

export interface Delivery {
  id: string;
  /** Where the answer goes. */
  /** The chat *or thread* the answer belongs to: a thread key when the request came from a topic. */
  chatKey: string;
  /**
   * The channel incarnation the chatKey was observed under (docs/22 §4). Records
   * from before the stamp existed were all written under the grandfathered
   * incarnation, which is 1 by definition; `pending` reads them that way.
   */
  incarnation?: number;
  /** Which conversation's transcript holds it. */
  conversation: string;
  agentId: string;
  /**
   * How far the transcript had got when the request arrived.
   *
   * The whole trick: everything the agent says after this index is the answer to this
   * request, so nothing about the reply itself needs storing.
   */
  before: number;
  /** The board entry to close when it lands, when the request made one. */
  taskId?: string;
  /** Who asked, for attribution when it is finally delivered. */
  identity?: string;
  at: string;
}

export function deliveriesPath(home: string): string {
  return join(home, "deliveries.jsonl");
}

/** Answers owed, and the record of them being paid. */
export class Deliveries {
  private settled = 0;
  private readonly incarnationOf: (chatKey: string) => number;
  private readonly warn: (line: string) => void;

  constructor(
    private readonly path: string,
    options: {
      /** Current incarnation of a chatKey's channel. Defaults to 1 for everything. */
      incarnationOf?: (chatKey: string) => number;
      warn?: (line: string) => void;
    } = {}
  ) {
    this.incarnationOf = options.incarnationOf ?? (() => 1);
    this.warn = options.warn ?? (line => console.error(`[deliveries] ${line}`));
    mkdirSync(dirname(path), { recursive: true });
  }

  /** Notes that an answer is owed. Called when the request is accepted, not when it ends. */
  open(delivery: Delivery): void {
    appendLine(this.path, JSON.stringify({ event: "open", delivery }));
  }

  /** Notes that it was handed over, so nobody hands it over twice. */
  close(id: string): void {
    appendLine(this.path, JSON.stringify({ event: "close", id }));
    this.settled += 1;
    if (this.settled >= COMPACT_AT) this.compact();
  }

  /**
   * What is still owed.
   *
   * On a healthy process this is the requests currently in flight. Just after a restart it
   * is exactly the set whose promises died — which is the only time anybody asks.
   */
  pending(): Delivery[] {
    if (!existsSync(this.path)) return [];
    const open = new Map<string, Delivery>();
    let settled = 0;
    for (const line of readFileSync(this.path, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      let record: { event?: string; delivery?: Delivery; id?: string };
      try {
        record = JSON.parse(line);
      } catch {
        // A torn last line is what a crash leaves, and a crash is the reason this file
        // exists. Skipping it is the whole of the recovery.
        continue;
      }
      if (record.event === "open" && record.delivery !== undefined) {
        open.set(record.delivery.id, record.delivery);
      } else if (record.event === "close" && record.id !== undefined) {
        open.delete(record.id);
        settled += 1;
      }
    }
    this.settled = settled;
    // The fail-closed check from docs/22 §4: an answer owed to a chat whose channel
    // has since been replaced is a **dead letter, reported** — never a delivery to
    // whoever holds the door now. Closed so recovery does not retry it forever;
    // the transcript still holds the answer if a person goes looking.
    const current: Delivery[] = [];
    for (const delivery of open.values()) {
      if ((delivery.incarnation ?? 1) === this.incarnationOf(delivery.chatKey)) {
        current.push(delivery);
        continue;
      }
      this.warn(
        `dead letter: the answer owed to ${delivery.chatKey} (agent ${delivery.agentId}, ` +
          `conversation ${delivery.conversation}) was earned under a replaced channel and ` +
          `will not be delivered. It remains in the transcript.`
      );
      this.close(delivery.id);
    }
    return current;
  }

  /** Rewrites the file as just what is still owed. */
  private compact(): void {
    const owed = this.pending();
    const temporary = `${this.path}.tmp`;
    writeFileSync(
      temporary,
      owed.map(delivery => `${JSON.stringify({ event: "open", delivery })}\n`).join(""),
      { mode: 0o600 }
    );
    // Renamed rather than written in place: a reader during a rewrite would otherwise see
    // a file with half its queue in it.
    renameSync(temporary, this.path);
    this.settled = 0;
  }
}
