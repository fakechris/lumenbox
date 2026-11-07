/**
 * Keeps this installation's own box up (INV-1550): the local half of the server's box watch.
 *
 * 2026-11-03 the box was stopped from outside (a `docker stop` sweep before another project's
 * compose came up). Nothing started it again, the notice reached only an open page, and four
 * agents' turns retried against it for forty minutes. Each tick, now:
 *
 *   1. healthy: nothing to do;
 *   2. not answering: reconnect, which also finds a new published port;
 *   3. still not: on the first tick of an episode, say so to admins, and stop the turns of the
 *      box's agents — they can only fail against it — remembering whose they were;
 *   4. the container stopped and nobody meant it (no `box down` marker): start it, at most once
 *      every few minutes and three times an episode, then reconnect;
 *   5. back: say so, and tell each agent whose turn was stopped that it can go on.
 *
 * It stands aside while an update or reset recreates the box, which is downtime somebody chose.
 */

import type { BoxClient } from "../box/client.ts";
import type { BoxStatus } from "../box/docker.ts";

export interface KeeperDeps {
  client: () => BoxClient | undefined;
  connect: () => Promise<{ connected: boolean; detail: string }>;
  /** The local container, when this installation's box is one; undefined otherwise. */
  container?: { status: () => Promise<BoxStatus>; start: () => Promise<void>; name: string };
  heldDown: () => { by: string; at: string } | undefined;
  /** An update or reset is recreating the box right now. */
  recreating: () => boolean;
  agentsOnBox: () => string[];
  /** Stops these agents' turns in flight; returns whose it stopped. */
  interrupt: (agentIds: string[], reason: string) => string[];
  /** Tells an agent, as the host, that its box is back. */
  wake: (agentId: string, text: string) => void;
  /** To admins: chats, and the page. */
  notify: (text: string) => void;
  log: (line: string) => void;
  /** The episode's edges (INV-1741): the exception list counts the box going down and resolves when it is back. */
  observe?: (state: "down" | "back", detail: string) => void;
  now?: () => number;
}

const START_COOLDOWN_MS = 3 * 60_000;
const MAX_STARTS = 3;
const STOPPED: ReadonlySet<string> = new Set(["exited", "created", "dead"]);

export class BoxKeeper {
  private healthy = false;
  private downSince: number | undefined;
  private stopped = new Set<string>();
  private starts = 0;
  private lastStart = Number.NEGATIVE_INFINITY; // never started yet
  private saidHeld = false;

  constructor(private readonly deps: KeeperDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** One watch tick; resolves to what the server should now believe about its box. */
  async tick(): Promise<{ connected: boolean; detail: string }> {
    const client = this.deps.client();
    if (client !== undefined) {
      try {
        await client.health();
        if (this.downSince !== undefined) this.back("answering again");
        this.healthy = true;
        return { connected: true, detail: "answering" };
      } catch (error) {
        if (!this.deps.recreating()) this.down(error instanceof Error ? error.message : String(error));
      }
    } else if (this.healthy && !this.deps.recreating()) this.down("no client");

    // Re-resolving rather than retrying the address we had: a recreated or restarted box comes back on another port.
    const attempt = await this.deps.connect();
    if (attempt.connected) {
      this.healthy = true;
      if (this.downSince !== undefined) this.back(attempt.detail);
      return attempt;
    }
    if (this.deps.recreating() || this.deps.container === undefined) return attempt;
    // While it stays down, turns that started since are stopped too: the cost of this tick, not of forty minutes.
    if (this.downSince !== undefined) for (const id of this.deps.interrupt(this.deps.agentsOnBox(), "box_down")) this.stopped.add(id);

    const status = await this.deps.container.status().catch(() => undefined);
    if (status === undefined || !STOPPED.has(status.state)) return attempt;
    const held = this.deps.heldDown();
    if (held !== undefined) {
      if (!this.saidHeld) this.deps.log(`box ${this.deps.container.name} is ${status.state}; ${held.by} stopped it${held.at ? ` at ${held.at}` : ""}, so it is left stopped`);
      this.saidHeld = true;
      return attempt;
    }
    if (this.starts >= MAX_STARTS || this.now() - this.lastStart < START_COOLDOWN_MS) return attempt;
    this.starts += 1;
    this.lastStart = this.now();
    this.deps.log(`box ${this.deps.container.name} is ${status.state} and nobody stopped it on purpose; starting it (attempt ${this.starts} of ${MAX_STARTS})`);
    try {
      await this.deps.container.start();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.deps.log(`box start failed: ${detail}`);
      if (this.starts >= MAX_STARTS) this.deps.notify(`The box ${this.deps.container.name} is stopped and could not be started (${detail}). Start it in Settings → Boxes, or run agentbox box up.`);
      return attempt;
    }
    const after = await this.deps.connect();
    if (after.connected) {
      this.healthy = true;
      this.back(`started again: ${after.detail}`);
    }
    return after;
  }

  private down(detail: string): void {
    if (this.downSince !== undefined || !this.healthy) return;
    this.healthy = false;
    this.downSince = this.now();
    this.saidHeld = false;
    for (const id of this.deps.interrupt(this.deps.agentsOnBox(), "box_down")) this.stopped.add(id);
    this.deps.log(`box stopped answering: ${detail}`);
    this.deps.observe?.("down", detail);
    this.deps.notify(`The box stopped answering (${detail}). Turns using it were stopped; LumenBox is trying to bring it back.`);
  }

  private back(detail: string): void {
    const minutes = this.downSince === undefined ? 0 : Math.max(1, Math.round((this.now() - this.downSince) / 60_000));
    this.downSince = undefined;
    // A new episode starts its own count and its own cooldown: the last start was for the last outage.
    this.starts = 0;
    this.lastStart = Number.NEGATIVE_INFINITY;
    this.deps.log(`box reachable again: ${detail}`);
    this.deps.observe?.("back", detail);
    this.deps.notify(`The box is back (${detail}) after about ${minutes} minute${minutes === 1 ? "" : "s"}.`);
    for (const id of this.stopped) {
      this.deps.wake(id, `<host_notification source="box">The box stopped answering for about ${minutes} minute${minutes === 1 ? "" : "s"} and is running again. Your turn was stopped while it was down, so tool calls from that time failed. Check where your work stands and go on.</host_notification>`);
    }
    this.stopped = new Set();
  }
}
