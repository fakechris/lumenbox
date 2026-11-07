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
  assert.equal((refused!.body as { code: string }).code, "guests-personal");
  assert.equal(desk.modeOf("ada"), "members");
});

test("an organisation's Admin sets who an agent answers, the cap and the public knowledge; a non-admin gets nothing", async () => {
  const desk = new GuestDesk();
  assert.equal((await guestRoute("GET /api/guests", desk, deps("organisation", {}, false)))?.status, 0);
  assert.equal((await guestRoute("POST /api/guests/answers", desk, deps("organisation", { id: "ada", mode: "guests" })))?.status, 200);
  assert.equal(desk.modeOf("ada"), "guests");
  assert.equal(((await guestRoute("POST /api/guests/answers", desk, deps("organisation", { id: "ada", mode: "all" })))!.body as { code: string }).code, "guests-mode-unknown");
  assert.equal(((await guestRoute("POST /api/guests/answers", desk, deps("organisation", { id: "zed", mode: "guests" })))!.body as { code: string }).code, "agent-unknown");
  assert.equal((await guestRoute("POST /api/guests/cap", desk, deps("organisation", { perGroupPerDay: 5 })))?.status, 200);
  assert.equal(((await guestRoute("POST /api/guests/cap", desk, deps("organisation", { perGroupPerDay: 0 })))!.body as { code: string }).code, "guests-cap-invalid");
  const added = await guestRoute("POST /api/guests/knowledge", desk, deps("organisation", { title: "Hours", text: "9-18" }));
  const id = (added!.body as { knowledge: { id: string }[] }).knowledge[0]!.id;
  assert.equal(((await guestRoute("POST /api/guests/knowledge", desk, deps("organisation", { title: "", text: "x" })))!.body as { code: string }).code, "guests-entry-invalid");
  const state = (await guestRoute("GET /api/guests", desk, deps("organisation")))!.body as { perGroupPerDay: number; agents: Record<string, string> };
  assert.equal(state.perGroupPerDay, 5);
  assert.deepEqual(state.agents, { ada: "guests" });
  assert.equal((await guestRoute("POST /api/guests/knowledge/remove", desk, deps("organisation", { id })))?.status, 200);
  assert.equal(((await guestRoute("POST /api/guests/knowledge/remove", desk, deps("organisation", { id })))!.body as { code: string }).code, "guests-entry-unknown");
  assert.equal(await guestRoute("GET /api/agents", desk, deps("organisation")), undefined);
});

test("collections, ticks, the window and holds are an Admin's; the audit list filters; an approved answer is sent before it is settled (INV-1713)", async () => {
  const desk = new GuestDesk();
  const code = (r: { body: unknown } | undefined) => (r!.body as { code: string }).code;
  const at = (route: string, body: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => guestRoute(route, desk, { ...deps("organisation", body), ...extra });
  assert.equal(code(await guestRoute("POST /api/guests/collections", desk, deps("single-machine", { name: "Sales" }))), "guests-personal");
  assert.equal(code(await at("POST /api/guests/collections", { name: " " })), "guests-collection-invalid");
  const added = (await at("POST /api/guests/collections", { name: "Sales" }))!.body as { collections: { id: string; name: string }[] };
  const sales = added.collections.find(c => c.name === "Sales")!.id;
  assert.equal(code(await at("POST /api/guests/ticks", { id: "ada", collections: ["nope"] })), "guests-collection-unknown");
  assert.deepEqual(((await at("POST /api/guests/ticks", { id: "ada", collections: [sales] }))!.body as { ticks: Record<string, string[]> }).ticks, { ada: [sales] });
  assert.equal(code(await at("POST /api/guests/knowledge", { title: "t", text: "x", collection: "nope" })), "guests-collection-unknown");
  assert.equal((await at("POST /api/guests/knowledge", { title: "Price", text: "99", collection: sales }))?.status, 200);
  assert.equal(code(await at("POST /api/guests/collections/remove", { id: "general" })), "guests-collection-default");
  assert.equal(code(await at("POST /api/guests/window", { exchanges: 21, minutes: 30 })), "guests-window-invalid");
  assert.deepEqual(((await at("POST /api/guests/window", { exchanges: 0, minutes: 30 }))!.body as { window: unknown }).window, { exchanges: 0, minutes: 30 });
  assert.equal(code(await at("POST /api/guests/hold", { door: "", chatKey: "x" })), "guests-group-invalid");
  assert.equal((await at("POST /api/guests/hold", { door: "feishu", chatKey: "feishu:oc_g", hold: true }))?.status, 200);
  assert.ok(desk.holdsIn("feishu", "feishu:oc_g"));

  desk.recordTurn({ turnId: "t1", agentId: "ada", agentName: "Ada", door: "feishu", chatKey: "feishu:oc_g", identity: "feishu:ou_x", senderLabel: "x", question: "refund?", answer: "I can refund you.", offered: [], calls: [], rounds: 1, inputTokens: 1, outputTokens: 1, outcome: "answered" });
  desk.recordReview({ turnId: "t1", category: "PROMISE", confidence: 0.9, reason: "", status: "held", answer: "I can refund you." });
  const audit = await at("GET /api/guests/audit", {}, { query: () => new URLSearchParams("flagged=1&chat=feishu:oc_g&agent=ada&days=1") });
  assert.deepEqual((audit!.body as { rows: { turnId: string }[] }).rows.map(r => r.turnId), ["t1"]);
  assert.deepEqual(((await at("GET /api/guests/audit", {}, { query: () => new URLSearchParams("agent=bob") }))!.body as { rows: unknown[] }).rows, []);
  const sent: string[] = [];
  const failed = await at("POST /api/guests/audit/approve", { turnId: "t1" }, { send: async () => ({ delivered: false, why: "channel down" }) });
  assert.equal(code(failed), "guests-send-failed");
  assert.equal(desk.reviewOf("t1")?.status, "held", "not sent, so still held");
  assert.equal((await at("POST /api/guests/audit/approve", { turnId: "t1" }, { send: async (chatKey: string, text: string) => { sent.push(`${chatKey} ${text}`); return { delivered: true }; } }))?.status, 200);
  assert.deepEqual(sent, ["feishu:oc_g I can refund you."]);
  assert.equal(code(await at("POST /api/guests/audit/discard", { turnId: "t1" })), "guests-held-unknown");
});
