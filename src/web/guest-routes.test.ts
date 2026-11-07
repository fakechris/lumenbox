/** Settings → Team → Guests (INV-1708): absent on a personal installation, admin-only, and the words of a refusal from the bundle. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { GuestDesk } from "../host/guests.ts";
import { guestRoute } from "./guest-routes.ts";

function deps(mode: "single-machine" | "organisation", body: Record<string, unknown> = {}, admin = true) {
  return { readJson: async () => body, refusedAdmin: () => !admin, agentIds: () => ["ada"], installationMode: () => mode, by: () => "Chris" };
}

test("a personal installation has no guest setting: it reads unavailable and every write is refused", async () => {
  const desk = new GuestDesk();
  assert.deepEqual(await guestRoute("GET /api/guests", desk, deps("single-machine")), { status: 200, body: { available: false } });
  const refused = await guestRoute("POST /api/guests/answers", desk, deps("single-machine", { id: "ada", mode: "guests" }));
  assert.equal(refused?.status, 409);
  assert.equal((refused?.body as { code: string }).code, "guests-personal");
  assert.equal(desk.modeOf("ada"), "members");
});

test("an organisation's Admin sets who an agent answers, the cap and the public knowledge; a non-admin gets nothing", async () => {
  const desk = new GuestDesk();
  assert.equal((await guestRoute("GET /api/guests", desk, deps("organisation", {}, false)))?.status, 0);
  assert.equal((await guestRoute("POST /api/guests/answers", desk, deps("organisation", { id: "ada", mode: "guests" })))?.status, 200);
  assert.equal(desk.modeOf("ada"), "guests");
  assert.equal(((await guestRoute("POST /api/guests/answers", desk, deps("organisation", { id: "ada", mode: "all" })))?.body as { code: string }).code, "guests-mode-unknown");
  assert.equal(((await guestRoute("POST /api/guests/answers", desk, deps("organisation", { id: "zed", mode: "guests" })))?.body as { code: string }).code, "agent-unknown");
  assert.equal((await guestRoute("POST /api/guests/cap", desk, deps("organisation", { perGroupPerDay: 5 })))?.status, 200);
  assert.equal(((await guestRoute("POST /api/guests/cap", desk, deps("organisation", { perGroupPerDay: 0 })))?.body as { code: string }).code, "guests-cap-invalid");
  const added = await guestRoute("POST /api/guests/knowledge", desk, deps("organisation", { title: "Hours", text: "9-18" }));
  const id = (added?.body as { knowledge: { id: string }[] }).knowledge[0]!.id;
  assert.equal(((await guestRoute("POST /api/guests/knowledge", desk, deps("organisation", { title: "", text: "x" })))?.body as { code: string }).code, "guests-entry-invalid");
  const state = (await guestRoute("GET /api/guests", desk, deps("organisation")))?.body as { perGroupPerDay: number; agents: Record<string, string> };
  assert.equal(state.perGroupPerDay, 5);
  assert.deepEqual(state.agents, { ada: "guests" });
  assert.equal((await guestRoute("POST /api/guests/knowledge/remove", desk, deps("organisation", { id })))?.status, 200);
  assert.equal(((await guestRoute("POST /api/guests/knowledge/remove", desk, deps("organisation", { id })))?.body as { code: string }).code, "guests-entry-unknown");
  assert.equal(await guestRoute("GET /api/agents", desk, deps("organisation")), undefined);
});
