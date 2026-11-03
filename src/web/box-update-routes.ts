/**
 * Settings → Boxes → Apply update (INV-1538, docs/12 §6): the box's image, whether this app expects
 * another one, and the update itself — the same `applyUpdate` the CLI runs, started from the page.
 *
 * The server checks every ten minutes and on request. An update waits for turns and background jobs
 * by default ("update when idle"), keeps its progress for the page to read, and reconnects the
 * server to the box that came back. Reset is a separate act: it removes the volumes, and the request
 * has to name the box.
 */

import { type ImageState, applyUpdate, dockerUpdateDeps, imageState, resetBox } from "../box/box-update.ts";
import { BoxManager, defaultBoxConfig } from "../box/docker.ts";
import { preflight, verifyBox } from "../box/preflight.ts";

export interface BoxUpdateDeps {
  /** Turns in flight now. */
  activeTurns: () => number;
  /** Reconnect the server to the box after it was recreated. */
  reconnect: () => Promise<void>;
  broadcast: (line: string, done?: { ok: boolean }) => void;
  log: (line: string) => void;
  manager?: () => BoxManager;
}

export class BoxUpdateService {
  private state: ImageState | undefined;
  private checkedAt: string | undefined;
  private running = false;
  private progress: string[] = [];
  private last: { outcome: string; detail: string; at: string } | undefined;

  constructor(private readonly deps: BoxUpdateDeps) {}

  private manager(): BoxManager {
    return this.deps.manager?.() ?? new BoxManager(defaultBoxConfig());
  }

  async check(): Promise<ImageState | undefined> {
    try {
      this.state = await imageState(this.manager());
      this.checkedAt = new Date().toISOString();
    } catch (error) {
      this.deps.log(`box update: could not read the box's image (${error instanceof Error ? error.message : String(error)})`);
    }
    return this.state;
  }

  /** Cached, for the attention page; refreshed by check(). */
  available(): ImageState | undefined {
    return this.state?.available === true && !this.running ? this.state : undefined;
  }

  view(): Record<string, unknown> {
    return { state: this.state ?? null, checkedAt: this.checkedAt ?? null, running: this.running, progress: this.progress.slice(-40), last: this.last ?? null };
  }

  private say(line: string): void {
    this.progress.push(line);
    if (this.progress.length > 200) this.progress.shift();
    this.deps.broadcast(line);
  }

  private async busy(manager: BoxManager): Promise<string[]> {
    const busy: string[] = [];
    const turns = this.deps.activeTurns();
    if (turns > 0) busy.push(`${turns} turn(s) in progress`);
    const box = await manager.connect().catch(() => undefined);
    if (box !== undefined) for (const job of (await preflight(box)).runningJobs) busy.push(`job ${job.id}: ${job.command}`);
    return busy;
  }

  /** Starts an update in the background; false when one is already running. */
  start(options: { whenIdle: boolean; backup: boolean }): boolean {
    if (this.running) return false;
    this.running = true;
    this.progress = [];
    const manager = this.manager();
    void (async () => {
      try {
        const result = await applyUpdate(dockerUpdateDeps(manager, {
          busy: () => this.busy(manager),
          verify: async () => verifyBox(await manager.connect()),
          onOutput: line => this.say(line),
        }), { whenIdle: options.whenIdle, backup: options.backup });
        this.last = { outcome: result.outcome, detail: result.busy?.length ? `${result.detail} ${result.busy.join("; ")}` : result.detail, at: new Date().toISOString() };
        this.say(this.last.detail);
        if (result.outcome === "updated" || result.outcome === "rolled_back") await this.deps.reconnect();
        this.deps.log(`box update: ${result.outcome} — ${result.detail}`);
      } catch (error) {
        this.last = { outcome: "failed", detail: error instanceof Error ? error.message : String(error), at: new Date().toISOString() };
        this.say(`failed — ${this.last.detail}`);
      } finally {
        this.running = false;
        await this.check();
        this.deps.broadcast("", { ok: this.last?.outcome === "updated" || this.last?.outcome === "current" });
      }
    })();
    return true;
  }

  /** Reset: the box and its volumes made new. Only when the request names the box. */
  reset(confirm: string): { started: boolean; error?: string } {
    const manager = this.manager();
    if (confirm !== manager.config.containerName) return { started: false, error: `To reset, type the box's name: ${manager.config.containerName}.` };
    if (this.running) return { started: false, error: "An update or reset is already running." };
    this.running = true;
    this.progress = [];
    void (async () => {
      try {
        await resetBox(manager, line => this.say(line));
        await this.deps.reconnect();
        this.last = { outcome: "reset", detail: "The box was reset: new container, empty work and config volumes.", at: new Date().toISOString() };
        this.say(this.last.detail);
      } catch (error) {
        this.last = { outcome: "failed", detail: error instanceof Error ? error.message : String(error), at: new Date().toISOString() };
        this.say(`failed — ${this.last.detail}`);
      } finally {
        this.running = false;
        await this.check();
        this.deps.broadcast("", { ok: this.last?.outcome === "reset" });
      }
    })();
    return { started: true };
  }
}

/** The routes; undefined when the route is not one of them. `refusedAdmin` answers itself and returns true. */
export async function boxUpdateRoute(route: string, service: BoxUpdateService, deps: { readJson: () => Promise<Record<string, unknown>>; refusedAdmin: () => boolean }): Promise<{ status: number; body: unknown } | undefined> {
  if (route === "GET /api/box/image") {
    if (deps.refusedAdmin()) return { status: 0, body: null };
    if (service.view().checkedAt === null) await service.check();
    return { status: 200, body: service.view() };
  }
  if (route === "POST /api/box/image/check") {
    if (deps.refusedAdmin()) return { status: 0, body: null };
    await service.check();
    return { status: 200, body: service.view() };
  }
  if (route === "POST /api/box/image/update") {
    if (deps.refusedAdmin()) return { status: 0, body: null };
    const body = await deps.readJson();
    const started = service.start({ whenIdle: body.whenIdle !== false, backup: body.backup === true });
    return started ? { status: 202, body: { started: true } } : { status: 409, body: { error: "An update is already running." } };
  }
  if (route === "POST /api/box/reset") {
    if (deps.refusedAdmin()) return { status: 0, body: null };
    const answer = service.reset(String((await deps.readJson()).confirm ?? ""));
    return answer.started ? { status: 202, body: answer } : { status: 400, body: { error: answer.error } };
  }
  return undefined;
}
