/** The unattended ceiling from the page (INV-1823): anybody reads it, an admin sets it, and what is set is what continuation uses. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { longRequestLimits } from "../host/long-request.ts";
import { longWorkRoute } from "./long-work-routes.ts";

test("the ceiling reads as the standard level, refuses a non-admin and a value out of range, saves for the installation, and a level chosen clears numbers written by hand", async () => {
  const home = mkdtempSync(join(tmpdir(), "agentbox-long-work-"));
  const previous = process.env.AGENTBOX_HOME;
  process.env.AGENTBOX_HOME = home;
  try {
    let admin = false;
    let body: Record<string, unknown> = {};
    const call = (route: string) => longWorkRoute(route, { readJson: async () => body, refusedAdmin: () => !admin });
    assert.equal(await call("GET /api/config"), undefined, "other routes are not this module's");
    assert.deepEqual((await call("GET /api/long-work"))!.body, { effort: "standard", custom: false, continuations: 30, activeHours: 12, defaults: { continuations: 30, activeHours: 12 } });
    body = { continuations: 60, activeHours: 24 };
    assert.deepEqual(await call("POST /api/long-work"), { status: 0, body: null }, "a non-admin is refused");
    admin = true;
    for (const bad of [{ continuations: -1, activeHours: 12 }, { continuations: 1.5, activeHours: 12 }, { continuations: 30, activeHours: 0 }, { continuations: "30", activeHours: 12 }]) {
      body = bad;
      assert.equal((await call("POST /api/long-work"))!.status, 400, JSON.stringify(bad));
    }
    assert.equal(loadConfig().longWork, undefined, "a refused value changed nothing");
    body = { continuations: 60, activeHours: 24 };
    assert.deepEqual((await call("POST /api/long-work"))!.body, { effort: "standard", custom: true, continuations: 60, activeHours: 24, defaults: { continuations: 30, activeHours: 12 } });
    assert.deepEqual(longRequestLimits(loadConfig().longWork), { continuations: 60, activeMs: 24 * 3_600_000 }, "and it is what continuation reads");
    body = { continuations: 0, activeHours: 12 };
    assert.equal(((await call("POST /api/long-work"))!.body as { continuations: number }).continuations, 0, "zero turns continuation off");
    body = { effort: "lean" };
    assert.deepEqual((await call("POST /api/long-work"))!.body, { effort: "lean", custom: false, continuations: 8, activeHours: 4, defaults: { continuations: 8, activeHours: 4 } }, "one choice is the whole setting");
  } finally {
    if (previous === undefined) delete process.env.AGENTBOX_HOME; else process.env.AGENTBOX_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
