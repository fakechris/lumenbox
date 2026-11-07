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
import { cpuLimitOf, defaultCpusFor, engineCpus, setCpuLimit } from "../box/box-cpus.ts";
import { boxCpusFromEnvironment, loadConfig, saveConfig, validCpus } from "../config.ts";
import { verifyBox } from "../box/preflight.ts";
import { apiError, type ApiError } from "./api-error.ts";

export interface BoxUpdateDeps {
  /** Turns in flight now on this box's agents: turns on another box are not this update's to wait for. */
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
    // A box that is stopped or does not answer has nothing on it to interrupt: turns that need it can only fail
    // and retry, and waiting for them waited out two hours while recreating was the fix (INV-1551).
    const box = await manager.connect().catch(() => undefined);
    if (box === undefined || !(await box.health().then(() => true, () => false))) return [];
    const busy: string[] = [];
    const turns = this.deps.activeTurns();
    if (turns > 0) busy.push(`${turns} turn(s) in progress`);
    // A box that answers but whose jobs cannot be read throws: the update stops rather than guess idle.
    for (const job of (await box.jobs()).jobs) if (job.running) busy.push(`job ${job.job_id}: ${job.command}`);
    return busy;
  }

  /** Starts an update in the background; false when one is already running. */
  start(options: { whenIdle: boolean; backup: boolean; interrupt?: boolean }): boolean {
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
        }), { whenIdle: options.whenIdle, backup: options.backup, ...(options.interrupt === true ? { interrupt: true } : {}) });
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
  reset(confirm: string): { started: true } | ({ started: false } & ApiError) {
    const manager = this.manager();
    if (confirm !== manager.config.containerName) return { started: false, ...apiError("reset-needs-name", { name: manager.config.containerName }) };
    if (this.running) return { started: false, ...apiError("reset-busy") };
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
    const started = service.start({ whenIdle: body.whenIdle !== false, backup: body.backup === true, interrupt: body.interrupt === true });
    return started ? { status: 202, body: { started: true } } : { status: 409, body: apiError("update-running") };
  }
  // The box's CPU ceiling (INV-1552): what it is, what the engine has, and a change applied in place.
  if (route === "GET /api/box/limits" || route === "POST /api/box/limits") {
    if (deps.refusedAdmin()) return { status: 0, body: null };
    const container = defaultBoxConfig().containerName;
    const engine = await engineCpus();
    const fromEnv = boxCpusFromEnvironment();
    let notApplied: string | undefined;
    if (route === "POST /api/box/limits") {
      if (fromEnv !== undefined) return { status: 409, body: apiError("cpus-from-env", { cpus: fromEnv }) };
      const raw = (await deps.readJson()).cpus;
      const cleared = raw === null || raw === "" || raw === undefined;
      const wanted = cleared ? undefined : validCpus(raw) === undefined ? Number.NaN : Number(validCpus(raw));
      if (wanted !== undefined && (!Number.isFinite(wanted) || (engine !== undefined && wanted > engine))) {
        return { status: 400, body: apiError("cpus-out-of-range", { max: engine ?? "the engine's" }) };
      }
      saveConfig({ boxCpus: wanted === undefined ? null : String(wanted) });
      const apply = wanted !== undefined ? String(wanted) : engine !== undefined ? defaultCpusFor(engine) : undefined;
      if (apply !== undefined) await setCpuLimit(container, apply).catch((error: unknown) => { notApplied = `Saved; the running box did not take it (${error instanceof Error ? error.message : String(error)}). It applies when the box is next created.`; });
    }
    const live = await cpuLimitOf(container).catch(() => undefined);
    return { status: 200, body: { engine: engine ?? null, limit: live ?? null, chosen: fromEnv ?? loadConfig().boxCpus ?? null, fromEnvironment: fromEnv !== undefined, default: engine !== undefined ? defaultCpusFor(engine) : null, ...(notApplied !== undefined ? { notApplied } : {}) } };
  }
  if (route === "POST /api/box/reset") {
    if (deps.refusedAdmin()) return { status: 0, body: null };
    const answer = service.reset(String((await deps.readJson()).confirm ?? ""));
    return { status: answer.started ? 202 : 400, body: answer };
  }
  return undefined;
}
