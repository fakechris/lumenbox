/**
 * Settings → Supervision and its runs (INV-1528): the routes, kept out of server.ts.
 *
 * The settings are the `supervision` section of config.json, validated here and written whole; the
 * supervision process notices and starts again. Runs are files the supervision process takes from a
 * queue (supervision/queue.ts); this side only writes requests, reads status, transcript and summary,
 * and drops a stop file. Nothing here returns a key, a token, or a key's value.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { credentialFor, credentialSet, providerNames, resolveProvider } from "../host/provider.ts";
import { applyConfigEnv, loadConfig, saveConfig } from "../config.ts";
import { readSupervisionConfig, supervisionFromBody } from "../supervision/config.ts";
import { newRunId } from "../supervision/main.ts";
import { enqueue, listRuns, readStatus, requestStop, runDir } from "../supervision/queue.ts";
import { supervisorModel, supervisorProviders } from "../supervisor/models.ts";
import { apiError } from "./api-error.ts";

export interface SupervisionRouteDeps {
  home: string;
  configPath: string;
  agents: () => string[];
  readJson: () => Promise<Record<string, unknown>>;
  /** Refuses (and answers) when the caller lacks the role; true means stop here. */
  refused: (role: "driver" | "admin") => boolean;
  logFile?: string;
  /** Tests stand in for the model and the config file. */
  testAsk?: typeof supervisorModel;
  saveKey?: (keyEnv: string, key: string) => void;
}

/** One small tool call, to say whether a choice works before a run depends on it. */
export async function testModel(choice: { provider: string; model: string }, choose: typeof supervisorModel = supervisorModel): Promise<{ ok: boolean; ms?: number; tools?: boolean; error?: string }> {
  const chosen = choose(choice, credentialFor);
  if ("error" in chosen) return { ok: false, error: chosen.error };
  const started = Date.now();
  try {
    const turn = await chosen.ask({ instructions: "You are being tested. Call the ping tool once, with no arguments.", input: [{ role: "user", content: "ping" }], tools: [{ name: "ping", description: "Answers pong.", parameters: { type: "object", properties: {} } }] });
    const tools = turn.calls.some(call => call.name === "ping");
    return { ok: tools, ms: Date.now() - started, tools, ...(tools ? {} : { error: "the model answered but did not call a tool; a supervisor needs tool calls" }) };
  } catch (error) {
    return { ok: false, ms: Date.now() - started, error: redact(error instanceof Error ? error.message : String(error)).slice(0, 300) };
  }
}

export type RouteAnswer = { status: number; body: unknown } | undefined;

/** Secrets that could only have got into a transcript by mistake, blanked before anyone reads it. */
export function redact(text: string): string {
  return text.replace(/lmbx_[0-9a-f]{16,}/g, "lmbx_…").replace(/\b(sk|ts)-[A-Za-z0-9_-]{16,}/g, "$1-…").replace(/Bearer [A-Za-z0-9._-]{16,}/g, "Bearer …");
}

function lastFlag(logFile: string | undefined): string | undefined {
  if (logFile === undefined || !existsSync(logFile)) return undefined;
  const lines = readFileSync(logFile, "utf8").trim().split("\n");
  return [...lines].reverse().find(line => /watchdog: (stalled|stopped-unattended|verification-failing) /.test(line));
}

export const defaultSupervisionLog = () => join(homedir(), "Library", "Logs", "LumenBox", "supervision.log");

export async function supervisionRoute(route: string, deps: SupervisionRouteDeps): Promise<RouteAnswer> {
  if (!route.includes(" /api/supervision")) return undefined;
  if (route === "GET /api/supervision") {
    if (deps.refused("driver")) return { status: 0, body: null };
    return {
      status: 200,
      body: {
        settings: readSupervisionConfig(deps.configPath),
        providers: supervisorProviders(name => (credentialSet(name) ? "set" : undefined)),
        agents: deps.agents(),
        lastFlag: lastFlag(deps.logFile) ?? null,
      },
    };
  }
  if (route === "POST /api/supervision/settings") {
    if (deps.refused("admin")) return { status: 0, body: null };
    const next = supervisionFromBody(await deps.readJson(), readSupervisionConfig(deps.configPath));
    if ("error" in next) return { status: 400, body: next };
    const raw = existsSync(deps.configPath) ? (JSON.parse(readFileSync(deps.configPath, "utf8")) as Record<string, unknown>) : {};
    writeFileSync(`${deps.configPath}.partial`, `${JSON.stringify({ ...raw, supervision: next }, null, 2)}\n`, { mode: 0o600 });
    renameSync(`${deps.configPath}.partial`, deps.configPath);
    return { status: 200, body: { settings: next, note: "Saved; supervision starts again with these settings within a few seconds." } };
  }
  // The setup wizard (INV-1529): try a model, save a key for one provider, keep the wizard's place.
  if (route === "POST /api/supervision/test") {
    if (deps.refused("admin")) return { status: 0, body: null };
    const body = await deps.readJson();
    return { status: 200, body: await testModel({ provider: String(body.provider ?? ""), model: String(body.model ?? "") }, deps.testAsk) };
  }
  if (route === "POST /api/supervision/key") {
    if (deps.refused("admin")) return { status: 0, body: null };
    const body = await deps.readJson();
    const provider = String(body.provider ?? "");
    const key = typeof body.key === "string" ? body.key.trim() : "";
    if (!providerNames().includes(provider) || provider === "custom") return { status: 400, body: apiError("supervision-provider-unknown", { provider }) };
    if (key === "" || /\s/.test(key)) return { status: 400, body: apiError("key-one-line") };
    const keyEnv = resolveProvider(provider).keyEnv;
    // The key alone: the default provider the agents use is not changed by setting up the supervisor.
    (deps.saveKey ?? ((name: string, value: string) => { saveConfig({ env: { [name]: value } }); applyConfigEnv(loadConfig()); }))(keyEnv, key);
    return { status: 200, body: { saved: keyEnv } };
  }
  if (route === "GET /api/supervision/onboarding" || route === "POST /api/supervision/onboarding") {
    if (deps.refused("driver")) return { status: 0, body: null };
    const path = join(deps.home, "supervisor", "onboarding.json");
    if (route === "POST /api/supervision/onboarding") {
      const body = await deps.readJson();
      const state = { step: Math.max(1, Math.min(6, Number(body.step) || 1)), choices: typeof body.choices === "object" && body.choices !== null ? body.choices : {}, done: body.done === true, at: new Date().toISOString() };
      mkdirSync(join(deps.home, "supervisor"), { recursive: true });
      writeFileSync(path, JSON.stringify(state));
      return { status: 200, body: state };
    }
    return { status: 200, body: existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { step: 1, choices: {}, done: false } };
  }
  if (route === "GET /api/supervision/runs") {
    if (deps.refused("driver")) return { status: 0, body: null };
    return { status: 200, body: { runs: listRuns(deps.home) } };
  }
  if (route === "POST /api/supervision/runs") {
    if (deps.refused("driver")) return { status: 0, body: null };
    const body = await deps.readJson();
    const objective = typeof body.objective === "string" ? body.objective.trim() : "";
    if (objective === "") return { status: 400, body: apiError("supervision-needs-objective") };
    const budget = body.budget === undefined || body.budget === "" || body.budget === null ? undefined : Number(body.budget);
    if (budget !== undefined && (!Number.isFinite(budget) || budget <= 0)) return { status: 400, body: apiError("supervision-budget") };
    const agent = typeof body.agent === "string" && body.agent.trim() !== "" ? body.agent.trim() : undefined;
    const request = enqueue(deps.home, { id: newRunId(), objective: objective.slice(0, 2_000), ...(agent !== undefined ? { agent } : {}), ...(budget !== undefined ? { budget } : {}) });
    return { status: 200, body: { run: readStatus(deps.home, request.id) } };
  }
  const one = /^(GET|POST) \/api\/supervision\/runs\/([A-Za-z0-9_-]{1,80})(\/stop)?$/.exec(route);
  if (one !== null) {
    if (deps.refused("driver")) return { status: 0, body: null };
    const [, method, id, stop] = one;
    const status = readStatus(deps.home, id!);
    if (status === undefined) return { status: 404, body: apiError("supervision-run-unknown", { run: id! }) };
    if (method === "POST" && stop !== undefined) {
      requestStop(deps.home, id!);
      return { status: 200, body: { stopping: true } };
    }
    if (method !== "GET" || stop !== undefined) return undefined;
    const dir = runDir(deps.home, id!);
    const summary = existsSync(join(dir, "summary.md")) ? redact(readFileSync(join(dir, "summary.md"), "utf8")) : null;
    const transcript = existsSync(join(dir, "transcript.jsonl"))
      ? readFileSync(join(dir, "transcript.jsonl"), "utf8").trim().split("\n").filter(Boolean).slice(-200).map(line => JSON.parse(redact(line)) as unknown)
      : [];
    return { status: 200, body: { run: status, summary, transcript } };
  }
  return undefined;
}
