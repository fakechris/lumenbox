/**
 * Managing people from the Team settings (INV-2053, INV-2054, INV-2056, INV-2057): the roster always
 * keeps an admin, the People list says how each person signs in and when they were last active, a code
 * says who it is for and lasts as long as it says, and a person's own code brings back the same person.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWebServer } from "./server.ts";
import { inviteMinutes, leavesNoAdmin } from "./people-routes.ts";

const PORT = 7964;
const BASE = `http://127.0.0.1:${PORT}`;
const ui = { "content-type": "application/json", authorization: "Bearer t0k" };

interface Row { id: string; name: string; role: string; identities: string[]; doors: { door: string }[]; lastActive?: string; boxes: { quota: number | null; held: number }; lastAdmin: boolean }
interface Code { code: string; role: string; expiresAt: number; note?: string; principalId?: string; name?: string }

const post = (path: string, body: unknown, headers: Record<string, string> = ui) => fetch(`${BASE}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
const people = async () => (await (await fetch(`${BASE}/api/people`, { headers: ui })).json()) as { people: Row[]; invites: Code[] };
const login = async (code: string, name: string) => {
  const response = await post("/api/login", { code, name }, { "content-type": "application/json" });
  assert.equal(response.status, 200, await response.clone().text());
  return response.headers.getSetCookie().map(cookie => cookie.split(";")[0]).join("; ");
};

test("the roster keeps an admin; a code says who it is for; a person's own code brings back the same person", async () => {
  const home = mkdtempSync(join(tmpdir(), "agentbox-people-"));
  const previous = process.env.AGENTBOX_HOME;
  process.env.AGENTBOX_HOME = home;
  let stop: (() => void) | undefined;
  try {
    stop = await startWebServer({ port: PORT, host: "127.0.0.1", token: "t0k", useBox: false, onLog: () => {} });

    // INV-2056: the note and the chosen lifetime travel with the code, and the live list shows both.
    const before = Date.now();
    const forAda = (await (await post("/api/channels/invite", { role: "admin", note: "Ada, finance", minutes: 60 })).json()) as Code;
    assert.equal(forAda.role, "admin");
    assert.equal(forAda.note, "Ada, finance");
    assert.ok(forAda.expiresAt >= before + 60 * 60_000 && forAda.expiresAt <= Date.now() + 60 * 60_000);
    const listed = (await people()).invites.find(invite => invite.code === forAda.code);
    assert.equal(listed?.note, "Ada, finance");
    assert.equal(listed?.role, "admin");
    const forBob = (await (await post("/api/channels/invite", { role: "viewer" })).json()) as Code;
    assert.ok(forBob.expiresAt <= Date.now() + 15 * 60_000, "no lifetime asked for is the fifteen minutes it always was");

    await login(forAda.code, "Ada");
    const bobCookie = await login(forBob.code, "Bob");
    const bobHeaders = { "content-type": "application/json", cookie: bobCookie };
    assert.equal((await fetch(`${BASE}/api/me`, { headers: bobHeaders })).status, 200);

    // INV-2054: each row says how the person signs in, when they last did something, and their boxes.
    let rows = (await people()).people;
    const ada = rows.find(row => row.name === "Ada")!, bob = rows.find(row => row.name === "Bob")!;
    assert.deepEqual(bob.doors.map(door => door.door), ["web"]);
    assert.equal(bob.lastActive, undefined);
    assert.deepEqual(Object.keys(bob.boxes).sort(), ["held", "quota"]);
    assert.equal(ada.lastAdmin, true, "Ada is the one admin");
    appendFileSync(join(home, "messages.jsonl"), `${JSON.stringify({ identity: bob.identities[0], receivedAt: "2026-11-23T10:00:00.000Z" })}\n`);
    assert.equal((await people()).people.find(row => row.id === bob.id)?.lastActive, "2026-11-23T10:00:00.000Z");

    // INV-2053: neither removing nor demoting the last admin is taken, whichever way it is sent.
    const removeAda = await post("/api/principals/remove", { principalId: ada.id });
    assert.equal(removeAda.status, 409);
    const demoted = rows.map(row => ({ ...row, role: row.id === ada.id ? "viewer" : row.role }));
    assert.equal((await post("/api/principals", { principals: demoted })).status, 409);
    assert.equal((await post("/api/principals", { principals: rows.filter(row => row.id !== ada.id) })).status, 409);
    assert.equal((await people()).people.find(row => row.id === ada.id)?.role, "admin");

    // INV-2057: Bob's own code links a second sign-in to the same Bob; it creates nobody.
    const bobAgain = (await (await post("/api/channels/invite", { principalId: bob.id })).json()) as Code;
    assert.equal(bobAgain.principalId, bob.id);
    assert.equal(bobAgain.name, "Bob");
    assert.equal(bobAgain.role, "viewer", "a person's code carries their role, not the form's");
    await login(bobAgain.code, "Bob on the laptop");
    rows = (await people()).people;
    assert.equal(rows.length, 2);
    assert.equal(rows.find(row => row.id === bob.id)?.identities.length, 2);
    assert.equal((await post("/api/channels/invite", { principalId: "nobody" })).status, 404);

    // Removing Bob takes him off the roster and signs him out of every browser at once.
    const pending = (await (await post("/api/channels/invite", { principalId: bob.id })).json()) as Code;
    assert.equal((await post("/api/principals/remove", { principalId: bob.id })).status, 200);
    rows = (await people()).people;
    assert.deepEqual(rows.map(row => row.name), ["Ada"]);
    assert.ok(!(await people()).invites.some(invite => invite.code === pending.code), "his own codes go with him");
    assert.equal((await fetch(`${BASE}/api/me`, { headers: bobHeaders })).status, 401);
  } finally {
    stop?.();
    if (previous === undefined) delete process.env.AGENTBOX_HOME;
    else process.env.AGENTBOX_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test("a lifetime is one of the offered ones, and only a roster that loses its every admin is refused", () => {
  assert.equal(inviteMinutes(60), 60);
  assert.equal(inviteMinutes(7 * 24 * 60), 7 * 24 * 60);
  assert.equal(inviteMinutes(5), 15);
  assert.equal(inviteMinutes("60"), 15);
  assert.equal(leavesNoAdmin([{ role: "admin" }, { role: "driver" }], [{ role: "driver" }]), true);
  assert.equal(leavesNoAdmin([{ role: "admin" }, { role: "admin" }], [{ role: "admin" }]), false);
  assert.equal(leavesNoAdmin([{ role: "driver" }], []), false, "a roster with no admin yet is the operator's to build");
});
