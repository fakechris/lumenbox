/**
 * `agentbox supervision` (INV-1527, docs/91): the one process the desktop app runs beside the web,
 * holding the watchdog loop and the supervisor's run queue. Still outside the web, so a web that
 * hangs or dies is seen — the point of an outside control loop — but started, stopped and restarted
 * by the app, so a person never installs a service.
 *
 * It keeps its own side-door token (token.ts) and renews it once if the door refuses it. What a
 * person should hear goes out as `@@notify {json}` lines on stdout, which the app turns into its
 * own notifications; everything else is the log.
 */

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { appendLine } from "../host/jsonl.ts";
import { type Door, doorClient } from "../watchdog/client.ts";
import { Watchdog, type ProgressJudge } from "../watchdog/main.ts";
import { Supervisor, summaryOf } from "../supervisor/loop.ts";
import { type ModelAsk, openaiResponses } from "../supervisor/openai.ts";
import { writeFileSync } from "node:fs";
import type { SupervisionConfig } from "./config.ts";
import { runDir, stopRequested, takeNext, writeStatus } from "./queue.ts";
import { ensureToken } from "./token.ts";

export interface SupervisionDeps {
  home: string;
  url: string;
  uiToken: () => string;
  fetch: typeof fetch;
  config: () => SupervisionConfig;
  /** The model a run uses; undefined when no key is configured, which a run reports as failed. */
  askFor: (model: string) => ModelAsk | undefined;
  judge?: ProgressJudge;
  emit: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  queuePollMs?: number;
  watchSeconds?: number;
}

export const notifyLine = (title: string, body: string) => `@@notify ${JSON.stringify({ title, body })}`;

export class Supervision {
  private inner: Door | undefined;
  private renewed = false;
  /** A door whose client can be replaced when the token is renewed, under everyone holding it. */
  readonly door: Door = {
    call: (name, args, options) => this.client().call(name, args, options),
    capabilities: () => this.client().capabilities?.() ?? Promise.resolve({}),
    tools: () => this.client().tools?.() ?? Promise.resolve([]),
  };

  constructor(private readonly deps: SupervisionDeps) {}

  private client(): Door {
    if (this.inner === undefined) throw new Error("supervision has no token yet");
    return this.inner;
  }

  private sleep(ms: number): Promise<void> {
    return this.deps.sleep?.(ms) ?? new Promise(resolve => setTimeout(resolve, ms));
  }

  private log(line: string): void {
    this.deps.emit(`supervision: ${line}`);
  }

  private notify(title: string, body: string): void {
    this.deps.emit(notifyLine(title, body));
  }

  /** The token, retried while the web is still starting. */
  async connect(signal: AbortSignal, renew = false): Promise<void> {
    for (let attempt = 0; !signal.aborted; attempt++) {
      try {
        this.inner = doorClient(this.deps.url, await ensureToken({ home: this.deps.home, url: this.deps.url, uiToken: this.deps.uiToken, fetch: this.deps.fetch }, { renew }));
        return;
      } catch (error) {
        if (attempt % 12 === 0) this.log(`waiting for the web to issue a token (${error instanceof Error ? error.message : String(error)})`);
        await this.sleep(5_000);
      }
    }
  }

  async watchLoop(signal: AbortSignal): Promise<void> {
    const config = this.deps.config().watchdog;
    if (!config.enabled) {
      this.log("watchdog off in settings");
      return;
    }
    const watchdog = new Watchdog({
      door: this.door,
      limits: { stallMinutes: config.stallMinutes, pausedMinutes: config.pausedMinutes, rejections: 2, pauseOwnMinutes: 120 },
      waitSeconds: this.deps.watchSeconds ?? 25,
      log: line => this.deps.emit(line),
      alert: (title, body) => this.notify(title, body),
      onDown: async () => this.notify("LumenBox is not answering", "The supervision process cannot reach the LumenBox server."),
      ...(config.judge && this.deps.judge !== undefined ? { judge: this.deps.judge } : {}),
    });
    while (!signal.aborted && !(await watchdog.ready())) await this.sleep(10 * 60_000);
    while (!signal.aborted) {
      const did = await watchdog.tick().catch(error => { this.log(error instanceof Error ? error.message : String(error)); return ["error"]; });
      if (watchdog.tokenRefused && !this.renewed) {
        this.renewed = true;
        this.log("the door refused the supervision token; issuing a new one");
        await this.connect(signal, true);
        continue;
      }
      if (did.includes("down") || did.includes("error") || did.includes("refused")) await this.sleep((this.deps.watchSeconds ?? 25) * 1000);
    }
  }

  /** One queued run, start to end, its status and record under runs/<id>/. */
  async runOne(): Promise<boolean> {
    const request = takeNext(this.deps.home);
    if (request === undefined) return false;
    const config = this.deps.config().supervisor;
    const dir = runDir(this.deps.home, request.id);
    const base = { id: request.id, objective: request.objective, requestedAt: request.requestedAt, model: config.model };
    const ask = this.deps.askFor(config.model);
    if (ask === undefined) {
      writeStatus(this.deps.home, { ...base, state: "failed", error: "no key for the supervisor's model is configured", endedAt: new Date().toISOString() });
      this.notify("A supervisor run could not start", "No key for the supervisor's model is configured.");
      return true;
    }
    const startedAt = new Date().toISOString();
    writeStatus(this.deps.home, { ...base, state: "running", startedAt });
    const supervisor = new Supervisor({
      door: this.door,
      ask,
      record: entry => appendLine(join(dir, "transcript.jsonl"), JSON.stringify(entry)),
      log: line => this.log(line),
      runId: request.id,
      limits: { maxMinutes: config.maxMinutes, maxModelCalls: config.maxModelCalls },
      shouldStop: () => stopRequested(this.deps.home, request.id),
      ...(this.deps.watchSeconds !== undefined ? { watchSeconds: this.deps.watchSeconds } : {}),
    });
    try {
      const agent = request.agent ?? config.agent;
      const budget = request.budget ?? config.budget;
      const result = await supervisor.run(request.objective, { ...(agent !== undefined ? { agent } : {}), ...(budget !== undefined ? { budget } : {}) });
      writeFileSync(join(dir, "summary.md"), `${summaryOf(request.objective, result)}Model: ${config.model}\n`);
      writeStatus(this.deps.home, { ...base, state: result.outcome === "stopped" ? "stopped" : "done", startedAt, endedAt: result.endedAt, outcome: result.outcome, ...(result.goalId !== undefined ? { goalId: result.goalId } : {}), modelCalls: result.modelCalls, tokens: { input: result.usage.input, output: result.usage.output } });
      if (result.outcome !== "completed" && result.outcome !== "stopped") this.notify("A supervisor run ended", `${result.goalId ?? "No goal"}: ${result.outcome.replace(/_/g, " ")}`);
    } catch (error) {
      writeStatus(this.deps.home, { ...base, state: "failed", startedAt, endedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  async queueLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const ran = await this.runOne().catch(error => { this.log(`run failed: ${error instanceof Error ? error.message : String(error)}`); return true; });
      if (!ran) await this.sleep(this.deps.queuePollMs ?? 3_000);
    }
  }

  async run(signal: AbortSignal): Promise<void> {
    await this.connect(signal);
    this.log("started");
    await Promise.all([this.watchLoop(signal), this.queueLoop(signal)]);
  }
}

/** The process the app starts. Keys and the UI token arrive from the CLI, which alone reads the environment. */
export async function cmdSupervision(argv: string[], env: { uiToken?: string; openaiToken: () => string | undefined }, out: (line: string) => void = line => console.log(line)): Promise<number> {
  const value = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
  const { agentboxHome, applyConfigEnv, configPath, loadConfig } = await import("../config.ts");
  applyConfigEnv(loadConfig());
  const { uiToken } = await import("../box/docker.ts");
  const { readSupervisionConfig } = await import("./config.ts");
  const { decisionModelJudge } = await import("../watchdog/main.ts");
  const config = () => readSupervisionConfig(configPath());
  const judge = config().watchdog.judge ? await decisionModelJudge(out) : undefined;
  const supervision = new Supervision({
    home: agentboxHome(),
    url: value("--url") ?? "http://127.0.0.1:7777",
    uiToken: () => env.uiToken ?? uiToken(),
    fetch,
    config,
    askFor: model => { const key = env.openaiToken(); return key === undefined || key === "" ? undefined : openaiResponses({ token: key, model }); },
    ...(judge !== undefined ? { judge } : {}),
    emit: out,
  });
  const stop = new AbortController();
  const stopNow = () => { stop.abort(); out("supervision: stopping"); setTimeout(() => process.exit(0), 1000).unref(); };
  process.once("SIGINT", stopNow);
  process.once("SIGTERM", stopNow);
  await supervision.run(stop.signal);
  return 0;
}

export const newRunId = () => `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
