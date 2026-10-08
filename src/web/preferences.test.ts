/**
 * Per-person UI preferences (INV-121): kept with the person, not the browser.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPERATOR_KEY, PreferenceStore } from "./preferences.ts";

test("a preference follows the person across browsers, and the operator has a seat of their own", () => {
  const home = mkdtempSync(join(tmpdir(), "agentbox-prefs-"));
  const path = join(home, "preferences.json");
  try {
    const store = new PreferenceStore(path);
    assert.deepEqual(store.get("feishu:ou_1"), {}, "nothing chosen yet is the default");
    assert.deepEqual(store.set("feishu:ou_1", { groupBy: "az", team: "media" }), { groupBy: "az", team: "media" });
    // Another browser: a fresh store on the same file sees the same choice.
    assert.deepEqual(new PreferenceStore(path).get("feishu:ou_1"), { groupBy: "az", team: "media" });
    // Another person is not this person.
    assert.deepEqual(store.get("feishu:ou_2"), {});
    // The operator with no identity.
    store.set(undefined, { groupBy: "teams" });
    assert.deepEqual(new PreferenceStore(path).get(undefined), { groupBy: "teams" });
    assert.deepEqual(new PreferenceStore(path).get(OPERATOR_KEY), { groupBy: "teams" });
    // Clearing one field, junk dropped, a long team name clamped.
    assert.deepEqual(store.set("feishu:ou_1", { team: null, groupBy: "sideways", colour: "red" }), { groupBy: "az" });
    assert.equal(store.set("feishu:ou_3", { team: "x".repeat(60) }).team?.length, 24);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the routes: /api/me carries the preferences, a post changes them, and a rename reaches the registry", async () => {
  const home = mkdtempSync(join(tmpdir(), "agentbox-prefs-http-"));
  const previous = process.env.AGENTBOX_HOME;
  process.env.AGENTBOX_HOME = home;
  const port = 7937;
  let stop: (() => void) | undefined;
  try {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(home, "agents"), { recursive: true });
    const { startWebServer } = await import("./server.ts");
    stop = await startWebServer({ port, host: "127.0.0.1", token: "t0k", useBox: false, onLog: () => {} });
    const base = `http://127.0.0.1:${port}`;
    const headers = { authorization: "Bearer t0k", "content-type": "application/json" };

    const me = (await (await fetch(`${base}/api/me`, { headers })).json()) as { preferences: Record<string, unknown> };
    assert.deepEqual(me.preferences, {});
    const set = await fetch(`${base}/api/me/preferences`, { method: "POST", headers, body: JSON.stringify({ groupBy: "az", team: "media" }) });
    assert.equal(set.status, 200);
    const again = (await (await fetch(`${base}/api/me`, { headers })).json()) as { preferences: Record<string, unknown> };
    assert.deepEqual(again.preferences, { groupBy: "az", team: "media" });

    // A rename with nobody in the team is refused with the reason, not a 500.
    const rename = await fetch(`${base}/api/teams/rename`, { method: "POST", headers, body: JSON.stringify({ from: "media", to: "content" }) });
    assert.equal(rename.status, 400);
    assert.match(((await rename.json()) as { error: string }).error, /No agent is in a team called "media"/);
  } finally {
    stop?.();
    if (previous === undefined) delete process.env.AGENTBOX_HOME;
    else process.env.AGENTBOX_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
