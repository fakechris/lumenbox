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
  };
  process.env.AGENTBOX_HOME = home;
  delete process.env.AGENTBOX_MODEL;
  delete process.env.AGENTBOX_VISION;
  delete process.env.AGENTBOX_SUMMARY_MODEL;
  delete process.env[MINIMAX_KEY];
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
      current: string; effective: { model: string; vision: boolean; summaryModel: string | null; locked: string[] };
      settings: { vision: string; summaryModel: string | null };
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
    assert.deepEqual(shown.settings, { vision: "on", summaryModel: "model-small" });
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
  } finally {
    stop?.();
    for (const [key, value] of [
      ["AGENTBOX_HOME", saved.home], ["AGENTBOX_MODEL", saved.model], ["AGENTBOX_VISION", saved.vision],
      ["AGENTBOX_SUMMARY_MODEL", saved.summary], ["ANTHROPIC_API_KEY", saved.key], [MINIMAX_KEY, saved.minimax],
    ] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    resetConfigEnvForTests();
    rmSync(home, { recursive: true, force: true });
  }
});
