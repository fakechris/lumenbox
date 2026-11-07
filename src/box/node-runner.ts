/**
 * An organisation's node at work (INV-1697, docs/96 §4): starts the machine's boxes — its Docker
 * box and its native environment — and registers each with the organisation under the node
 * credential, then says so again every half minute (the node's heartbeat; the organisation's Boxes
 * list shows when it last heard). Nothing else runs here: no roster, no channels, no records. The
 * organisation's server drives the boxes, as it drives a pod.
 *
 * Revoked is final: when the organisation answers that the node was revoked, every box here is
 * stopped and the runner ends with `revoked`, so a machine that was cut off is not left serving a
 * daemon to anybody. An organisation that cannot be reached is not a revocation: the runner keeps
 * its boxes up and tries again on the next beat.
 */

import type { Repository } from "../host/bundles.ts";

/** One box on the node, started by its driver (Docker, or the headless box daemon). */
export interface NodeBox {
  name: string;
  /** `host` is the machine's native environment; `docker` is the same image a personal machine runs. */
  kind: "docker" | "host";
  /** `screen`: the native environment's own screen is open to the computer tool (INV-1707). */
  start(): Promise<{ baseUrl: string; token: string; workDir?: string; repositories?: Repository[]; screen?: true }>;
  stop(): Promise<void>;
}

export interface NodeRunnerOptions {
  /** The organisation's address. */
  control: string;
  credential: string;
  boxes: NodeBox[];
  version: string;
  heartbeatMs?: number;
  fetchImpl?: typeof fetch;
  log: (line: string) => void;
}

export type NodeEnd = "revoked" | "stopped";

/** What the organisation answered, by its stable code (never its words). */
type Answer = { ok: true; state?: string } | { ok: false; status: number; code?: string };

export class NodeRunner {
  private timer: ReturnType<typeof setInterval> | undefined;
  private started: { box: NodeBox; endpoint: Awaited<ReturnType<NodeBox["start"]>> }[] = [];
  private ending: ((end: NodeEnd) => void) | undefined;
  /** Set by stop(): a box that finishes starting afterwards is stopped at once, and no beat registers anything. */
  private stopping = false;
  readonly done: Promise<NodeEnd>;

  constructor(private readonly options: NodeRunnerOptions) {
    this.done = new Promise(resolve => { this.ending = resolve; });
  }

  private async register(box: NodeBox, endpoint: Awaited<ReturnType<NodeBox["start"]>>): Promise<Answer> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    try {
      const response = await fetchImpl(`${this.options.control.replace(/\/+$/, "")}/api/boxes/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ node: this.options.credential, name: box.name, kind: box.kind, baseUrl: endpoint.baseUrl, token: endpoint.token, version: this.options.version, ...(endpoint.workDir !== undefined ? { workDir: endpoint.workDir } : {}), ...(endpoint.repositories !== undefined ? { repositories: endpoint.repositories } : {}), ...(endpoint.screen === true ? { screen: true } : {}) }),
        signal: AbortSignal.timeout(20_000),
      });
      const reply = (await response.json().catch(() => ({}))) as { code?: string; state?: string };
      return response.ok ? { ok: true, ...(reply.state !== undefined ? { state: reply.state } : {}) } : { ok: false, status: response.status, ...(reply.code !== undefined ? { code: reply.code } : {}) };
    } catch (error) {
      return { ok: false, status: 0, code: `unreachable: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /** One pass: every box registered (or re-registered); a revocation ends the node. */
  async beat(): Promise<void> {
    for (const { box, endpoint } of [...this.started]) {
      if (this.stopping) return;
      const answer = await this.register(box, endpoint);
      if (answer.ok) continue;
      if (answer.code === "node-revoked" || answer.code === "node-unknown") {
        this.options.log(`node: the organisation ${answer.code === "node-revoked" ? "revoked this node" : "no longer knows this node's credential"}; stopping its boxes`);
        await this.stop(answer.code === "node-revoked" ? "revoked" : "stopped");
        return;
      }
      this.options.log(`node: ${box.name} was not registered (${answer.status}${answer.code !== undefined ? ` ${answer.code}` : ""}); trying again`);
    }
  }

  /** Starts every box, registers them, and keeps the heartbeat. A box that does not start is reported and skipped. */
  async start(): Promise<void> {
    for (const box of this.options.boxes) {
      try {
        const endpoint = await box.start();
        if (this.stopping) { await box.stop().catch(() => {}); return; }
        this.started.push({ box, endpoint });
        this.options.log(`node: ${box.name} (${box.kind === "host" ? "native environment" : "docker"}) up at ${endpoint.baseUrl}`);
      } catch (error) {
        this.options.log(`node: ${box.name} did not start: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (this.started.length === 0) {
      this.options.log("node: no box started; nothing to register");
      await this.stop("stopped");
      return;
    }
    await this.beat();
    if (this.stopping) return;
    this.timer = setInterval(() => { void this.beat(); }, this.options.heartbeatMs ?? 30_000);
  }

  async stop(end: NodeEnd = "stopped"): Promise<void> {
    this.stopping = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    const boxes = this.started;
    this.started = [];
    for (const { box } of boxes) await box.stop().catch(error => this.options.log(`node: ${box.name} did not stop cleanly: ${error instanceof Error ? error.message : String(error)}`));
    const ending = this.ending;
    this.ending = undefined;
    ending?.(end);
  }
}
