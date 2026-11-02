/**
 * The watchdog (INV-1509, docs/91): a control loop outside the orchestrator, holding its own token.
 *
 * It is a principal on the side door and nothing more. It reads the record — `task_status` for
 * the board, `watch` for what moves — and judges it by the rules in rules.ts. It has three things
 * it may do: flag a task for a person (`raise_attention`), pause a goal its own principal started
 * (`goal_control`), and, when the door stops answering, run the command its operator gave it.
 * It never marks anything done, never resumes what the gate stopped, never touches a budget or a
 * box. Before it acts on a finding it reads that task again: a note the feed does not carry may
 * have moved it in the meantime.
 */

import { type Door, DoorRefused, DoorUnreachable, doorClient } from "./client.ts";
import { DEFAULT_LIMITS, type Finding, findingsFor, type WatchdogLimits } from "./rules.ts";
import type { TaskRecord } from "../web/mcp-record.ts";

/** A second opinion on a goal that is moving but maybe not toward its checklist; off unless given. */
export type ProgressJudge = (record: TaskRecord) => Promise<string | undefined>;

export interface WatchdogDeps {
  door: Door;
  limits?: WatchdogLimits;
  /** Run when the door has not answered `downAfter` times in a row; once per outage. */
  onDown?: (reason: string) => Promise<void>;
  /** Tell a person, once per occurrence: a token refused, a door too old (INV-1527 routes this to the app). */
  alert?: (title: string, body: string) => void;
  downAfter?: number;
  judge?: ProgressJudge;
  /** Seconds a watch waits for a change; the loop's pace when nothing moves. */
  waitSeconds?: number;
  log: (line: string) => void;
  now?: () => Date;
}

/** The local memory of what it already said, so a quiet board is not a flag every minute. */
const RAISE_COOLDOWN_MS = 6 * 60 * 60_000;
const JUDGE_EVERY_MS = 60 * 60_000;

export class Watchdog {
  private readonly records = new Map<string, TaskRecord>();
  private mine = new Set<string>();
  private cursor: string | undefined;
  private failures = 0;
  private down = false;
  private readonly raised = new Map<string, number>();
  private readonly judged = new Map<string, number>();
  private refused = false;

  constructor(private readonly deps: WatchdogDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private async tasks(args: Record<string, unknown>): Promise<TaskRecord[]> {
    const reply = await this.deps.door.call("task_status", args);
    if (reply.isError) throw new Error(`task_status: ${reply.text}`);
    return ((reply.structured?.tasks ?? []) as TaskRecord[]);
  }

  private async relist(): Promise<void> {
    const all = await this.tasks({ scope: "all" });
    this.records.clear();
    for (const record of all) this.records.set(record.id, record);
    this.mine = new Set((await this.tasks({})).map(record => record.id));
  }

  /** One pass: catch up on the board, judge it, act. Returns what it did, for the tests and the log. */
  /** Whether the last tick found the door refusing this token; the supervision process renews it once. */
  get tokenRefused(): boolean {
    return this.refused;
  }

  async tick(): Promise<string[]> {
    const did: string[] = [];
    try {
      if (this.cursor === undefined) {
        await this.relist();
        this.cursor = String((await this.deps.door.call("watch", { scope: "all" })).structured?.cursor ?? "");
      } else {
        const reply = await this.deps.door.call("watch", { since: this.cursor, wait_seconds: this.deps.waitSeconds ?? 25, scope: "all" }, { timeoutMs: ((this.deps.waitSeconds ?? 25) + 15) * 1000 });
        const result = reply.structured as { events?: { taskId: string }[]; cursor?: string; reset?: boolean } | undefined;
        if (result?.reset === true) await this.relist();
        else for (const id of new Set((result?.events ?? []).map(event => event.taskId))) await this.refresh(id);
        if (result?.cursor !== undefined) this.cursor = result.cursor;
      }
      if (this.down) { this.deps.log("watchdog: the door answers again"); this.down = false; }
      this.failures = 0;
      this.refused = false;
    } catch (error) {
      if (error instanceof DoorRefused) {
        if (!this.refused) {
          this.deps.log("watchdog: the door does not accept this token any more (revoked, or issued before tokens were kept across restarts). Run agentbox watchdog uninstall, then install.");
          this.deps.alert?.("LumenBox supervision", "The door no longer accepts the supervision token.");
        }
        this.refused = true;
        this.cursor = undefined;
        return ["refused"];
      }
      if (!(error instanceof DoorUnreachable)) throw error;
      this.refused = false;
      this.failures++;
      this.cursor = undefined; // whatever it held is a reading of a process that may be gone
      if (this.failures >= (this.deps.downAfter ?? 2) && !this.down) {
        this.down = true;
        this.deps.log(`watchdog: the door is not answering (${error.message})`);
        await this.deps.onDown?.(error.message);
        did.push("down");
      }
      return did;
    }
    for (const record of [...this.records.values()]) did.push(...(await this.judge(record)));
    return did;
  }

  private async refresh(id: string): Promise<TaskRecord | undefined> {
    const [record] = await this.tasks({ task_id: id });
    if (record === undefined || record.outcome.status === "completed" || record.outcome.status === "cancelled") {
      this.records.delete(id);
      return undefined;
    }
    this.records.set(id, record);
    return record;
  }

  private async judge(record: TaskRecord): Promise<string[]> {
    const did: string[] = [];
    const now = this.now();
    const limits = this.deps.limits ?? DEFAULT_LIMITS;
    let findings = findingsFor(record, this.mine.has(record.id), now, limits).filter(finding => this.fresh(finding, now));
    if (findings.length === 0 && this.deps.judge !== undefined && record.pursuit?.status === "active" && now.getTime() - (this.judged.get(record.id) ?? 0) >= JUDGE_EVERY_MS) {
      this.judged.set(record.id, now.getTime());
      const note = await this.deps.judge(record).catch(error => { this.deps.log(`watchdog: judge failed on ${record.id} (${error instanceof Error ? error.message : String(error)})`); return undefined; });
      if (note !== undefined) findings = [{ taskId: record.id, rule: "stalled", note }];
    }
    if (findings.length === 0) return did;
    // Read it again before acting: a note the feed does not carry may have moved it.
    const current = await this.refresh(record.id);
    if (current === undefined) return did;
    const confirmed = findings.filter(finding => finding.note.startsWith("the decision model") || findingsFor(current, this.mine.has(current.id), now, limits).some(again => again.rule === finding.rule));
    for (const finding of confirmed) did.push(...(await this.act(finding, current, now)));
    return did;
  }

  private fresh(finding: Finding, now: Date): boolean {
    return now.getTime() - (this.raised.get(`${finding.taskId}:${finding.rule}`) ?? 0) >= RAISE_COOLDOWN_MS;
  }

  private async act(finding: Finding, record: TaskRecord, now: Date): Promise<string[]> {
    const did: string[] = [];
    const day = now.toISOString().slice(0, 10);
    if (finding.pause === true) {
      const paused = await this.deps.door.call("goal_control", { task_id: record.id, action: "pause" }, { idempotencyKey: `watchdog-pause-${record.id}-${record.updatedAt}` });
      this.deps.log(`watchdog: pause ${record.id}: ${paused.text.split("\n")[0]}`);
      if (!paused.isError) did.push(`paused ${record.id}`);
    }
    const flagged = await this.deps.door.call("raise_attention", { task_id: record.id, note: finding.note }, { idempotencyKey: `watchdog-flag-${record.id}-${finding.rule}-${day}` });
    this.raised.set(`${finding.taskId}:${finding.rule}`, now.getTime());
    this.deps.log(`watchdog: ${finding.rule} ${record.id}: ${flagged.text.split("\n")[0]}`);
    if (!flagged.isError) did.push(`flagged ${record.id} ${finding.rule}`);
    return did;
  }

  /**
   * Whether the door has what the watchdog reads (INV-1517): the structured record and the change
   * feed, which LumenBox's side door gained after 0.3.9. An older door is said once, then asked again.
   */
  async ready(): Promise<boolean> {
    if (this.deps.door.capabilities === undefined) return true;
    try {
      const caps = await this.deps.door.capabilities();
      const missing = ["structured", "watch"].filter(name => caps[name] !== true);
      if (missing.length === 0) return true;
      if (!this.tooOld) {
        this.deps.log(`watchdog: the door is too old for the watchdog (it lacks ${missing.join(" and ")}); upgrade LumenBox. Asking again every ten minutes.`);
        this.deps.alert?.("LumenBox supervision", "This LumenBox is too old for supervision; update it.");
      }
      this.tooOld = true;
      return false;
    } catch (error) {
      if (!(error instanceof DoorUnreachable)) throw error;
      return true; // a door that does not answer is the tick's to report
    }
  }

  private tooOld = false;

  /** Until the signal: a tick, then another; a door that is down is retried at the wait's pace. */
  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted && !(await this.ready())) await new Promise(resolve => setTimeout(resolve, 10 * 60_000));
    while (!signal.aborted) {
      const did = await this.tick().catch(error => { this.deps.log(`watchdog: ${error instanceof Error ? error.message : String(error)}`); return ["error"]; });
      if (did.includes("down") || did.includes("error") || did.includes("refused") || this.down) await new Promise(resolve => setTimeout(resolve, (this.deps.waitSeconds ?? 25) * 1000));
    }
  }
}

/** `agentbox watchdog`: the flags are the whole configuration; the token may come from the environment the CLI read. */
export async function cmdWatchdog(argv: string[], env: { token?: string; processEnv: Record<string, string | undefined> }, out: (line: string) => void = line => console.error(line)): Promise<number> {
  const value = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
  const url = value("--url") ?? "http://127.0.0.1:7777";
  if (argv[0] === "install" || argv[0] === "uninstall" || argv[0] === "status") return manage(argv, value, url, env, out);
  const tokenFile = value("--token-file");
  const { readFileSync } = await import("node:fs");
  const token = value("--token") ?? (tokenFile !== undefined ? readFileSync(tokenFile, "utf8").trim() : env.token);
  if (token === undefined || token === "") {
    out("Usage: agentbox watchdog --token <side-door token> | --token-file <path> [--url http://127.0.0.1:7777] [--wait 25] [--on-down '<command>'] [--stall-minutes 60] [--paused-minutes 30] [--judge]\n       agentbox watchdog install [--principal <name>] [--no-judge] [--stall-minutes N] [--paused-minutes N] [--on-down '<command>'] | uninstall | status\n(or AGENTBOX_WATCHDOG_TOKEN). The token is a person's, and every flag is in their name.");
    return 1;
  }
  const number = (name: string, fallback: number) => { const raw = value(name); const parsed = raw === undefined ? NaN : Number(raw); return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback; };
  const limits: WatchdogLimits = { ...DEFAULT_LIMITS, stallMinutes: number("--stall-minutes", DEFAULT_LIMITS.stallMinutes), pausedMinutes: number("--paused-minutes", DEFAULT_LIMITS.pausedMinutes) };
  const onDownCommand = value("--on-down");
  const { spawn } = await import("node:child_process");
  const judge = argv.includes("--judge") ? await decisionModelJudge(out) : undefined;
  const watchdog = new Watchdog({
    door: doorClient(url, token),
    limits,
    waitSeconds: Math.min(30, number("--wait", 25)),
    log: out,
    ...(judge !== undefined ? { judge } : {}),
    ...(onDownCommand !== undefined
      ? { onDown: reason => new Promise<void>(resolve => { const child = spawn(onDownCommand, { shell: true, stdio: "inherit", env: { ...env.processEnv, WATCHDOG_REASON: reason } }); child.on("exit", () => resolve()); child.on("error", error => { out(`watchdog: --on-down failed (${error.message})`); resolve(); }); }) }
      : {}),
  });
  out(`watchdog: watching ${url}${judge !== undefined ? " with the decision model as a second opinion" : ""}`);
  const stop = new AbortController();
  // A stop is prompt: a watch in flight can wait 30 s, and launchd's bootout waits for the exit.
  const stopNow = () => { stop.abort(); out("watchdog: stopping"); setTimeout(() => process.exit(0), 1000).unref(); };
  process.once("SIGINT", stopNow);
  process.once("SIGTERM", stopNow);
  await watchdog.run(stop.signal);
  return 0;
}

/** `--judge`: one yes/no to the decision model about the last moves of an active goal; a no is a note for a person. */
export async function decisionModelJudge(out: (line: string) => void): Promise<ProgressJudge | undefined> {
  const { applyConfigEnv, loadConfig } = await import("../config.ts");
  applyConfigEnv(loadConfig());
  const { jevClient, noulOf } = await import("../host/jev.ts");
  const ask = jevClient();
  if (ask === undefined) {
    out("watchdog: --judge needs the decision model's credential; running without a second opinion");
    return undefined;
  }
  return async record => {
    const result = await ask({
      state: { checklist: record.pursuit?.checklist, experiments: record.pursuit?.experiments, history: record.history.slice(-8).map(change => change.note ?? change.status ?? "") },
      questions: { moving: { type: "noul", instructions: "Do the latest moves of this goal advance its checklist, rather than repeating or wandering?", criteria: { true: "they advance it", false: "they repeat or wander" } } },
    });
    return noulOf(result, "moving") < 0.3 ? "the decision model reads its latest moves as not advancing the checklist" : undefined;
  };
}

/** install / uninstall / status (INV-1517): the resident service, through install.ts. */
async function manage(argv: string[], value: (name: string) => string | undefined, url: string, env: { processEnv: Record<string, string | undefined> }, out: (line: string) => void): Promise<number> {
  const { spawnSync } = await import("node:child_process");
  const { homedir } = await import("node:os");
  const { join, resolve } = await import("node:path");
  const { agentboxHome } = await import("../config.ts");
  const { uiToken } = await import("../box/docker.ts");
  const install = await import("./install.ts");
  const keep = Object.fromEntries(["ELECTRON_RUN_AS_NODE", "AGENTBOX_HOME"].flatMap(name => (env.processEnv[name] !== undefined ? [[name, env.processEnv[name]!]] : [])));
  const deps = {
    home: agentboxHome(),
    launchAgentsDir: join(homedir(), "Library", "LaunchAgents"),
    uid: process.getuid?.() ?? 0,
    platform: process.platform,
    uiToken,
    fetch,
    run: (command: string, args: string[]) => { const ran = spawnSync(command, args, { encoding: "utf8" }); return { code: ran.status ?? 1, stdout: `${ran.stdout ?? ""}${ran.stderr ?? ""}` }; },
    program: { execPath: process.execPath, execArgv: process.execArgv, script: resolve(process.argv[1] ?? ""), env: keep },
  };
  const number = (name: string) => { const raw = value(name); return raw === undefined ? undefined : Number(raw); };
  try {
    const lines = argv[0] === "install"
      ? await install.installWatchdog({ url, judge: !argv.includes("--no-judge"), ...(value("--principal") !== undefined ? { principal: value("--principal")! } : {}), ...(number("--stall-minutes") !== undefined ? { stallMinutes: number("--stall-minutes")! } : {}), ...(number("--paused-minutes") !== undefined ? { pausedMinutes: number("--paused-minutes")! } : {}), ...(value("--on-down") !== undefined ? { onDown: value("--on-down")! } : {}), ...(value("--label") !== undefined ? { label: value("--label")! } : {}) }, deps)
      : argv[0] === "uninstall" ? await install.uninstallWatchdog(deps) : install.watchdogStatus(deps);
    for (const line of lines) out(line);
    return 0;
  } catch (error) {
    out(`watchdog ${argv[0]}: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
