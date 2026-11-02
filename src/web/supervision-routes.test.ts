/** Settings → Supervision routes (INV-1528): settings saved without touching the rest of config.json, runs queued, read and stopped, nothing secret returned. */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_SUPERVISION, supervisionFromBody } from "../supervision/config.ts";
import { appendLine } from "../host/jsonl.ts";
import { runDir } from "../supervision/queue.ts";
import { redact, supervisionRoute } from "./supervision-routes.ts";

function setup() {
  const home = mkdtempSync(join(tmpdir(), "sup-routes-"));
  const configPath = join(home, "config.json");
  writeFileSync(configPath, JSON.stringify({ provider: "minimax", env: { OPENAI_API_KEY: "sk-secret-value-123456789" } }));
  let body: Record<string, unknown> = {};
  let refusedRole: string | undefined;
  const deps = { home, configPath, agents: () => ["Ada", "Ops"], readJson: async () => body, refused: (role: "driver" | "admin") => role === refusedRole, logFile: join(home, "supervision.log") };
  return { home, configPath, deps, setBody: (next: Record<string, unknown>) => { body = next; }, refuse: (role?: string) => { refusedRole = role; }, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

test("settings: read with defaults, saved validated and whole, the rest of the file untouched, admins only", async () => {
  const h = setup();
  try {
    const read = (await supervisionRoute("GET /api/supervision", h.deps))!;
    const body = read.body as { settings: unknown; providers: { name: string; hasKey: boolean }[]; agents: string[] };
    assert.deepEqual(body.settings, DEFAULT_SUPERVISION);
    assert.deepEqual(body.agents, ["Ada", "Ops"]);
    assert.ok(body.providers.some(p => p.name === "openai") && body.providers.every(p => typeof p.hasKey === "boolean"));
    assert.ok(!JSON.stringify(read.body).includes("sk-secret"), "no key value leaves");
    h.setBody({ watchdog: { enabled: false, stallMinutes: 20 }, supervisor: { provider: "anthropic", model: "claude-x", agent: "Ops", budget: "5000" } });
    const saved = (await supervisionRoute("POST /api/supervision/settings", h.deps))!;
    assert.equal(saved.status, 200);
    const file = JSON.parse(readFileSync(h.configPath, "utf8"));
    assert.equal(file.provider, "minimax", "the rest of config.json is kept");
    assert.equal(file.env.OPENAI_API_KEY, "sk-secret-value-123456789");
    assert.deepEqual([file.supervision.watchdog.enabled, file.supervision.watchdog.stallMinutes, file.supervision.supervisor.provider, file.supervision.supervisor.agent, file.supervision.supervisor.budget], [false, 20, "anthropic", "Ops", 5000]);
    h.setBody({ watchdog: { stallMinutes: 0 } });
    assert.equal((await supervisionRoute("POST /api/supervision/settings", h.deps))!.status, 400);
    h.refuse("admin");
    assert.deepEqual(await supervisionRoute("POST /api/supervision/settings", h.deps), { status: 0, body: null }, "refused: the server has answered");
    assert.deepEqual(supervisionFromBody({ supervisor: { maxModelCalls: 1.5 } }, DEFAULT_SUPERVISION), { error: "model calls is a whole number between 1 and 500" });
  } finally {
    h.cleanup();
  }
});

test("runs: queued, listed, read back without secrets, stopped; a run needs an objective", async () => {
  const h = setup();
  try {
    h.setBody({ objective: "  " });
    assert.equal((await supervisionRoute("POST /api/supervision/runs", h.deps))!.status, 400);
    h.setBody({ objective: "Ship the digest", agent: "Ops", budget: 3000 });
    const queued = (await supervisionRoute("POST /api/supervision/runs", h.deps))!.body as { run: { id: string; state: string } };
    assert.equal(queued.run.state, "queued");
    const listed = (await supervisionRoute("GET /api/supervision/runs", h.deps))!.body as { runs: { id: string }[] };
    assert.deepEqual(listed.runs.map(run => run.id), [queued.run.id]);
    appendLine(join(runDir(h.home, queued.run.id), "transcript.jsonl"), JSON.stringify({ kind: "tool", name: "x", reply: "token lmbx_0123456789abcdef0123456789 and Bearer abcdefghijklmnopqrstuvwxyz" }));
    const one = (await supervisionRoute(`GET /api/supervision/runs/${queued.run.id}`, h.deps))!.body as { transcript: unknown[] };
    assert.ok(!JSON.stringify(one).includes("0123456789abcdef0123456789") && !JSON.stringify(one).includes("abcdefghijklmnopqrstuvwxyz"), "redacted before anyone reads it");
    assert.deepEqual((await supervisionRoute(`POST /api/supervision/runs/${queued.run.id}/stop`, h.deps))!.body, { stopping: true });
    assert.equal((await supervisionRoute("GET /api/supervision/runs/nope", h.deps))!.status, 404);
    assert.equal(await supervisionRoute("GET /api/other", h.deps), undefined, "not ours: untouched");
    assert.equal(redact("sk-abcdefghijklmnopqrstu"), "sk-…");
  } finally {
    h.cleanup();
  }
});

test("the wizard's routes: a model test says whether tools work, a key is saved for one provider only, and the place is kept outside config.json", async () => {
  const h = setup();
  try {
    const saved: [string, string][] = [];
    const deps = { ...h.deps, saveKey: (name: string, value: string) => { saved.push([name, value]); }, testAsk: (choice: { provider: string; model: string }) => choice.model === "toolless"
      ? { ask: async () => ({ id: "r", calls: [], text: "pong", usage: { input: 1, output: 1, reasoning: 0 } }) }
      : choice.model === "broken" ? { error: "no key for OpenAI (OPENAI_API_KEY); set it in Settings → Model" }
      : { ask: async () => ({ id: "r", calls: [{ callId: "c", name: "ping", arguments: {} }], text: "", usage: { input: 1, output: 1, reasoning: 0 } }) } };
    h.setBody({ provider: "openai", model: "gpt-6.1-sol" });
    const ok = (await supervisionRoute("POST /api/supervision/test", deps))!.body as { ok: boolean; tools: boolean; ms: number };
    assert.deepEqual([ok.ok, ok.tools, typeof ok.ms], [true, true, "number"]);
    h.setBody({ provider: "openai", model: "toolless" });
    assert.match(((await supervisionRoute("POST /api/supervision/test", deps))!.body as { error: string }).error, /did not call a tool/);
    h.setBody({ provider: "openai", model: "broken" });
    assert.deepEqual((await supervisionRoute("POST /api/supervision/test", deps))!.body, { ok: false, error: "no key for OpenAI (OPENAI_API_KEY); set it in Settings → Model" });
    h.setBody({ provider: "openai", key: "sk-new-key-123" });
    assert.deepEqual((await supervisionRoute("POST /api/supervision/key", deps))!.body, { saved: "OPENAI_API_KEY" });
    assert.deepEqual(saved, [["OPENAI_API_KEY", "sk-new-key-123"]], "only that provider's key");
    h.setBody({ provider: "openai", key: "two words" });
    assert.equal((await supervisionRoute("POST /api/supervision/key", deps))!.status, 400);
    h.setBody({ provider: "custom", key: "k" });
    assert.equal((await supervisionRoute("POST /api/supervision/key", deps))!.status, 400);
    assert.deepEqual((await supervisionRoute("GET /api/supervision/onboarding", deps))!.body, { step: 1, choices: {}, done: false });
    h.setBody({ step: 3, choices: { provider: "openai", agent: "Ops" } });
    await supervisionRoute("POST /api/supervision/onboarding", deps);
    const kept = (await supervisionRoute("GET /api/supervision/onboarding", deps))!.body as { step: number; choices: { agent: string } };
    assert.deepEqual([kept.step, kept.choices.agent], [3, "Ops"]);
    assert.ok(!readFileSync(h.configPath, "utf8").includes("onboarding"), "stepping through does not touch config.json, so supervision does not restart");
  } finally {
    h.cleanup();
  }
});
