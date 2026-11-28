/**
 * Saving model settings applies them to the running server (INV-1268).
 *
 * The restart used to be the only way a saved provider reached the orchestrator, and a
 * restart drops every channel for half a minute. Now the save route re-applies the file,
 * resolves the provider and swaps the default runtime; a file it cannot apply leaves the
 * old runtime in place and says so.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetConfigEnvForTests } from "../config.ts";
import { resolveProvider } from "../host/provider.ts";
import { startWebServer } from "./server.ts";

const PORT = 7989;
/** Whatever variable the MiniMax preset reads: the test needs it absent, whatever this machine exports. */
const MINIMAX_KEY = resolveProvider("minimax").keyEnv;
const BASE = `http://127.0.0.1:${PORT}`;

test("a saved model is in force without a restart; a file that cannot be applied leaves the old one", async () => {
  const home = mkdtempSync(join(tmpdir(), "agentbox-switch-"));
  const saved = {
    home: process.env.AGENTBOX_HOME,
    model: process.env.AGENTBOX_MODEL,
    vision: process.env.AGENTBOX_VISION,
    summary: process.env.AGENTBOX_SUMMARY_MODEL,
    key: process.env.ANTHROPIC_API_KEY,
    minimax: process.env[MINIMAX_KEY],
    openai: process.env.OPENAI_API_KEY,
  };
  process.env.AGENTBOX_HOME = home;
  delete process.env.AGENTBOX_MODEL;
  delete process.env.AGENTBOX_VISION;
  delete process.env.AGENTBOX_SUMMARY_MODEL;
  delete process.env[MINIMAX_KEY];
  delete process.env.OPENAI_API_KEY;
  // A credential the client constructor accepts; nothing here makes a request.
  process.env.ANTHROPIC_API_KEY = "test-key-not-real";
  resetConfigEnvForTests();
  let stop: (() => void) | undefined;
  try {
    stop = await startWebServer({
      port: PORT,
      host: "127.0.0.1",
      token: "t0k",
      useBox: false,
      provider: { ...resolveProvider("anthropic"), model: "model-old" },
      onLog: () => {},
    });
    const headers = { "content-type": "application/json", authorization: "Bearer t0k" };
    const post = async (body: unknown) => {
      const response = await fetch(`${BASE}/api/config`, { method: "POST", headers, body: JSON.stringify(body) });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };
    const state = async () => ((await (await fetch(`${BASE}/api/state`, { headers })).json()) as { provider: string }).provider;
    const config = async () => (await (await fetch(`${BASE}/api/config`, { headers })).json()) as {
      current: string; effective: { provider: string; configured: boolean; model: string; vision: boolean; summaryModel: string | null; locked: string[] };
      settings: { vision: string; summaryModel: string | null; userAgent: string | null; userAgentDefault: string };
      presets: { name: string; model: string; keyPresent: boolean; keySource: string | null }[];
    };

    assert.match(await state(), /model-old/);

    // The ordinary save: a new model, vision forced on, a summary model named.
    const first = await post({ provider: "anthropic", model: "model-new", vision: "on", summaryModel: "model-small" });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.applied, true);
    assert.equal(first.body.restartNeeded, false);
    assert.match(await state(), /model-new/, "the state endpoint reports the live provider, not the one the server started with");
    const shown = await config();
    assert.equal(shown.effective.model, "model-new");
    assert.equal(shown.effective.vision, true);
    assert.equal(shown.effective.summaryModel, "model-small");
    assert.deepEqual(shown.effective.locked, []);
    assert.deepEqual(shown.settings, { vision: "on", summaryModel: "model-small", userAgent: null, userAgentDefault: shown.settings.userAgentDefault });
    assert.match(shown.settings.userAgentDefault, /^LumenBox\/\d+\.\d+\.\d+/);
    const file = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as { model?: string; env?: Record<string, string> };
    assert.equal(file.model, "model-new");
    assert.equal(file.env?.AGENTBOX_VISION, "1");
    assert.equal(file.env?.AGENTBOX_SUMMARY_MODEL, "model-small");
    assert.equal(statSync(join(home, "config.json")).mode & 0o777, 0o600);

    // Back to "follow the model" for vision, and no summary model: the variables leave the file and the process.
    const second = await post({ vision: "auto", summaryModel: null });
    assert.equal(second.status, 200);
    assert.equal((await config()).effective.summaryModel, null);
    assert.equal(process.env.AGENTBOX_VISION, undefined);

    // The User-Agent every model request sends (INV-2325): saved into the file and the process, refused when it is
    // not one line of printable ASCII (and nothing changes), and cleared back to LumenBox's own by an empty value.
    assert.equal((await post({ userAgent: "acme-agent/2.1" })).status, 200);
    assert.equal((await config()).settings.userAgent, "acme-agent/2.1");
    assert.equal(process.env.AGENTBOX_USER_AGENT, "acme-agent/2.1");
    const refused = await post({ userAgent: "两个字" });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.code, "user-agent-not-ascii");
    assert.equal((await post({ userAgent: "x".repeat(201) })).body.code, "user-agent-too-long");
    assert.equal((JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as { env?: Record<string, string> }).env?.AGENTBOX_USER_AGENT, "acme-agent/2.1");
    assert.equal((await post({ userAgent: "" })).status, 200);
    assert.equal((await config()).settings.userAgent, null);
    assert.equal(process.env.AGENTBOX_USER_AGENT, undefined);

    // A provider with no credential: saved, not applied, the old runtime stays.
    const third = await post({ provider: "minimax" });
    assert.equal(third.status, 400, JSON.stringify(third.body));
    assert.equal(third.body.applied, false);
    assert.match(String(third.body.error), new RegExp(MINIMAX_KEY));
    assert.match(await state(), /model-new/, "the previous model is still in use");

    // A shell-exported variable is not overridden by the file, and the reply says which. The
    // shell sets its variables before the process starts, which is what forgetting the
    // config-applied set and then exporting stands in for here.
    resetConfigEnvForTests();
    process.env.AGENTBOX_MODEL = "model-shell";
    const fourth = await post({ provider: "anthropic", model: "model-file" });
    assert.equal(fourth.status, 200);
    assert.deepEqual(fourth.body.locked, ["AGENTBOX_MODEL"]);
    assert.match(await state(), /model-shell/);
    assert.deepEqual((await config()).effective.locked, ["AGENTBOX_MODEL"]);
    delete process.env.AGENTBOX_MODEL;

    // Only the restart-bound settings ask for one.
    const fifth = await post({ startupItem: true });
    assert.equal(fifth.body.restartNeeded, true);

    // Only the selected provider owns a saved model; sources are independent of model names.
    process.env[MINIMAX_KEY] = "fixture-china";
    const openai = await post({ provider: "openai", model: "gpt-4.1", key: "fixture-openai" });
    assert.equal(openai.status, 200);
    const { effective, presets } = await config();
    assert.equal(effective.provider, "openai");
    assert.equal(effective.configured, true);
    const setup = await (await fetch(`${BASE}/api/setup`, { headers })).json();
    assert.equal(setup.key, effective.configured);
    const primary = presets.find(p => p.name === "openai")!;
    assert.equal(primary.model, "gpt-4.1");
    assert.equal(primary.keySource, "saved");
    const china = presets.find(p => p.name === "minimax")!;
    assert.equal(china.model, "MiniMax-M3");
    assert.equal(china.keySource, "environment");
    const global = presets.find(p => p.name === "minimax-global")!;
    assert.equal(global.keySource, null);
    assert.equal(global.keyPresent, false);
    assert.notEqual(presets.find(p => p.name === "custom")!.model, "gpt-4.1");
    const fallbacks = await (await fetch(`${BASE}/api/provider/fallbacks`, { headers })).json();
    assert.equal(fallbacks.presets.find((p: { name: string }) => p.name === "anthropic").model, "claude-opus-5");
    assert.equal(fallbacks.presets.find((p: { name: string }) => p.name === "minimax-global").hasKey, false);
  } finally {
    stop?.();
    for (const [key, value] of [
      ["AGENTBOX_HOME", saved.home], ["AGENTBOX_MODEL", saved.model], ["AGENTBOX_VISION", saved.vision],
      ["AGENTBOX_SUMMARY_MODEL", saved.summary], ["ANTHROPIC_API_KEY", saved.key], [MINIMAX_KEY, saved.minimax],
      ["OPENAI_API_KEY", saved.openai],
    ] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    resetConfigEnvForTests();
    rmSync(home, { recursive: true, force: true });
  }
});

test("a search key is saved under its provider's variable, applied live, and clearable", async () => {
  const home = mkdtempSync(join(tmpdir(), "agentbox-search-"));
  const saved = {
    home: process.env.AGENTBOX_HOME,
    key: process.env.ANTHROPIC_API_KEY,
    keenable: process.env.KEENABLE_API_KEY,
    brave: process.env.BRAVE_SEARCH_API_KEY,
    tavily: process.env.TAVILY_API_KEY,
  };
  process.env.AGENTBOX_HOME = home;
  delete process.env.KEENABLE_API_KEY;
  delete process.env.BRAVE_SEARCH_API_KEY;
  delete process.env.TAVILY_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key-not-real";
  resetConfigEnvForTests();
  let stop: (() => void) | undefined;
  try {
    stop = await startWebServer({
      port: PORT + 1,
      host: "127.0.0.1",
      token: "t0k",
      useBox: false,
      provider: resolveProvider("anthropic"),
      onLog: () => {},
    });
    const headers = { "content-type": "application/json", authorization: "Bearer t0k" };
    const post = async (body: unknown) => {
      const response = await fetch(`http://127.0.0.1:${PORT + 1}/api/config`, { method: "POST", headers, body: JSON.stringify(body) });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };
    const config = async () => (await (await fetch(`http://127.0.0.1:${PORT + 1}/api/config`, { headers })).json()) as {
      search: { providers: { name: string; keyEnv: string; keyPresent: boolean }[] };
    };
    const setup = async () => (await (await fetch(`http://127.0.0.1:${PORT + 1}/api/setup`, { headers })).json()) as { search: boolean };

    // Nothing configured: the page can say which key each provider reads, and the setup
    // card can say the capability is absent — the fact the CLI prints to stdout nobody
    // in the desktop app reads.
    assert.equal((await config()).search.providers.length, 3);
    assert.equal((await setup()).search, false);

    // A key for one provider lands under that provider's variable and is live at once.
    const first = await post({ searchProvider: "keenable", searchKey: "sk-search-test" });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(process.env.KEENABLE_API_KEY, "sk-search-test");
    const file = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as { env?: Record<string, string> };
    assert.equal(file.env?.KEENABLE_API_KEY, "sk-search-test");
    const shown = (await config()).search.providers;
    assert.equal(shown.find(p => p.name === "keenable")?.keyPresent, true);
    assert.equal((await setup()).search, true);

    // "none" clears whichever of the three is set — a key nobody wanted is worse than none.
    const second = await post({ searchProvider: "" });
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.equal(process.env.KEENABLE_API_KEY, undefined);
    assert.equal((await setup()).search, false);

    // A key with no provider, or a provider that does not exist, is refused rather than guessed.
    assert.equal((await post({ searchKey: "orphan" })).status, 400);
    assert.equal((await post({ searchProvider: "bogus", searchKey: "x" })).status, 400);
  } finally {
    stop?.();
    for (const [key, value] of [
      ["AGENTBOX_HOME", saved.home], ["ANTHROPIC_API_KEY", saved.key],
      ["KEENABLE_API_KEY", saved.keenable], ["BRAVE_SEARCH_API_KEY", saved.brave], ["TAVILY_API_KEY", saved.tavily],
    ] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    resetConfigEnvForTests();
    rmSync(home, { recursive: true, force: true });
  }
});
