/**
 * Managing people from the Team settings (INV-2053, INV-2054, INV-2056, INV-2057): the roster always
 * keeps an admin, the People list says how each person signs in and when they were last active, a code
 * says who it is for and lasts as long as it says, and a person's own code brings back the same person.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWebServer } from "./server.ts";
import { Principals } from "../host/principals.ts";
import { inviteMinutes, leavesNoAdmin, peopleRoute } from "./people-routes.ts";
import { InviteStore } from "./invite-store.ts";
import { SESSION_MAX_AGE_SECONDS } from "./session.ts";

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

test("the roster keeps an admin; a code says who it is for; a person's own code brings back the same person", async t => {
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

    const beforeAdaLogin = Date.now();
    const adaCookie = await login(forAda.code, "Ada");
    const bobCookie = await login(forBob.code, "Bob");
    const bobHeaders = { "content-type": "application/json", cookie: bobCookie };
    assert.equal((await fetch(`${BASE}/api/me`, { headers: bobHeaders })).status, 200);

    // INV-2054: each row says how the person signs in, when they last did something, and their boxes.
    let rows = (await people()).people;
    const ada = rows.find(row => row.name === "Ada")!, bob = rows.find(row => row.name === "Bob")!;
    const adaIdentity = ada.identities[0]!;
    const adaExpiry = new Principals().browserSignInExpiresAt(ada.id, adaIdentity);
    const sessionLifetime = SESSION_MAX_AGE_SECONDS * 1_000;
    assert.ok(adaExpiry !== undefined && adaExpiry >= beforeAdaLogin + sessionLifetime && adaExpiry <= Date.now() + sessionLifetime);
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
    assert.equal((await post("/api/principals/logout", { principalId: ada.id })).status, 409, "nor signing her out everywhere: nobody could let her back in (INV-2082)");
    assert.equal((await people()).people.find(row => row.id === ada.id)?.role, "admin");

    // INV-2057: Bob's own code links a second sign-in to the same Bob; it creates nobody.
    const bobAgain = (await (await post("/api/channels/invite", { principalId: bob.id })).json()) as Code;
    assert.equal(bobAgain.principalId, bob.id);
    assert.equal(bobAgain.name, "Bob");
    assert.equal(bobAgain.role, "viewer", "a person's code carries their role, not the form's");
    const laptop = await login(bobAgain.code, "Bob on the laptop");
    rows = (await people()).people;
    assert.equal(rows.length, 2);
    assert.equal(rows.find(row => row.id === bob.id)?.identities.length, 2);
    assert.equal((await post("/api/channels/invite", { principalId: "nobody" })).status, 404);
    const revoke = "/api/principals/revoke-sign-in";
    const laptopIdentity = rows.find(row => row.id === bob.id)!.identities.find(identity => !bob.identities.includes(identity))!;
    const revocation = { principalId: bob.id, identity: laptopIdentity };
    const roster = new Principals();
    const originalRoster = roster.list();
    let authorityChecks = 0;
    const pendingRevocation = await peopleRoute("POST /api/principals/revoke-sign-in", {
      principals: roster, invites: new InviteStore(), newCode: () => "", publicUrl: undefined,
      callerId: () => ada.identities[0], refusedAdmin: () => { authorityChecks++; return roster.roleOf(ada.identities[0]!) !== "admin"; },
      readJson: async () => {
        new Principals().save(originalRoster.map(person => person.id === ada.id ? { ...person, role: "viewer" } : person));
        return revocation;
      },
      signOut: () => 0, usableSignIns: person => person.identities, retiredSignIn: () => false,
      planRemoval: () => async () => {}, boxesOf: () => ({ held: 0, quota: null }),
      lastActive: () => new Map(), doorType: () => undefined, log() {},
    });
    assert.equal(authorityChecks, 2);
    assert.equal(pendingRevocation?.status, 0);
    assert.equal(new Principals().byId(bob.id)?.identities.length, 2, "a request pending across the demotion cannot revoke a sign-in");
    roster.save(originalRoster);
    assert.equal((await post(revoke, revocation, bobHeaders)).status, 403);
    assert.equal((await post(revoke, { ...revocation, principalId: ada.id })).status, 404);
    assert.equal((await post(revoke, revocation)).status, 200);
    assert.equal((await post(revoke, { principalId: bob.id, identity: bob.identities[0] })).status, 409, "a stale row click cannot revoke the last sign-in");
    assert.equal((await fetch(`${BASE}/api/me`, { headers: { cookie: laptop } })).status, 401);
    assert.equal((await fetch(`${BASE}/api/me`, { headers: bobHeaders })).status, 200);
    const adaAgain = (await (await post("/api/channels/invite", { principalId: ada.id })).json()) as Code;
    await login(adaAgain.code, "Ada on the laptop");
    const adaLaptop = (await people()).people.find(row => row.id === ada.id)!.identities.find(identity => !ada.identities.includes(identity))!;
    assert.equal((await post(revoke, { principalId: ada.id, identity: adaLaptop }, { ...ui, authorization: "", cookie: adaCookie })).status, 200);
    assert.equal((await people()).people.find(row => row.id === ada.id)?.lastAdmin, true);
    const oldFeishu = "removed-feishu:ou_ada";
    assert.equal((await post("/api/channels/records", { id: "removed-feishu", type: "feishu" })).status, 200);
    roster.reload();
    roster.save(roster.list().map(person => person.id === ada.id ? { ...person, identities: [...person.identities, oldFeishu] } : person));
    assert.equal((await post("/api/channels/records/remove", { id: "removed-feishu" })).status, 200);
    assert.equal((await fetch(`${BASE}/auth/removed-feishu`)).status, 404);
    const classicRoster = await (await fetch(`${BASE}/api/channels`, { headers: ui })).json() as {
      principals: (Row & { usableSignIns: string[]; retiredSignIns: string[] })[];
    };
    const classicAda = classicRoster.principals.find(person => person.id === ada.id)!;
    assert.deepEqual(classicAda.identities, [ada.identities[0], oldFeishu]);
    assert.deepEqual(classicAda.usableSignIns, ada.identities);
    assert.deepEqual(classicAda.retiredSignIns, [oldFeishu]);
    const lastUsable = await post(revoke, { principalId: ada.id, identity: ada.identities[0] }, { ...ui, authorization: "", cookie: adaCookie });
    assert.equal(lastUsable.status, 409);
    assert.equal((await lastUsable.json()).code, "sign-in-last-admin");
    assert.equal((await post(revoke, { principalId: ada.id, identity: oldFeishu }, { ...ui, authorization: "", cookie: adaCookie })).status, 200);

    // Removing Bob takes him off the roster and signs him out of every browser at once.
    const pending = (await (await post("/api/channels/invite", { principalId: bob.id })).json()) as Code;
    const sideDoor = (await (await post("/api/mcp/tokens", { principalId: bob.id, label: "Bob's IDE" })).json()) as { token: string };
    const mcp = () => post("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" }, { "content-type": "application/json", authorization: `Bearer ${sideDoor.token}` });
    assert.equal((await mcp()).status, 200);
    const adaDoor = (await (await post("/api/mcp/tokens", { label: "Ada's IDE" }, { "content-type": "application/json", cookie: adaCookie })).json()) as { token: string };
    assert.equal((await post("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" }, { "content-type": "application/json", authorization: `Bearer ${adaDoor.token}` })).status, 200, "a token issued to a sign-in works");
    assert.equal((await post("/api/principals/remove", { principalId: bob.id })).status, 200);
    rows = (await people()).people;
    assert.deepEqual(rows.map(row => row.name), ["Ada"]);
    assert.ok(!(await people()).invites.some(invite => invite.code === pending.code), "his own codes go with him");
    assert.equal((await fetch(`${BASE}/api/me`, { headers: bobHeaders })).status, 401);
    assert.equal((await mcp()).status, 401, "and out of the side door");

    t.mock.timers.enable({ apis: ["Date"], now: adaExpiry });
    const legacyIdentity = "web:legacy-browser";
    roster.reload();
    roster.save(roster.list().map(person => person.id === ada.id ? { ...person, identities: [...person.identities, legacyIdentity] } : person));
    const renewedAda = (await (await post("/api/channels/invite", { principalId: ada.id })).json()) as Code;
    const freshCookie = await login(renewedAda.code, "Ada after expiry");
    const afterExpiry = await (await fetch(`${BASE}/api/channels`, { headers: ui })).json() as typeof classicRoster;
    const renewed = afterExpiry.principals.find(person => person.id === ada.id)!;
    const [freshIdentity] = renewed.usableSignIns;
    assert.ok(freshIdentity && freshIdentity !== adaIdentity && freshIdentity !== legacyIdentity);
    assert.deepEqual(renewed.usableSignIns, [freshIdentity], "neither expired nor undated browser links are usable backups (INV-2090)");
    assert.deepEqual(renewed.retiredSignIns, [adaIdentity]);
    const freshHeaders = { ...ui, authorization: "", cookie: freshCookie };
    const revokeFresh = await post(revoke, { principalId: ada.id, identity: freshIdentity }, freshHeaders);
    assert.equal(revokeFresh.status, 409);
    assert.equal((await revokeFresh.json()).code, "sign-in-last-admin");
    assert.equal((await post(revoke, { principalId: ada.id, identity: adaIdentity }, freshHeaders)).status, 200);

    roster.reload();
    roster.save(roster.list().map(person => person.id === ada.id ? { ...person, identities: [oldFeishu] } : person));
    assert.equal((await post(revoke, { principalId: ada.id, identity: oldFeishu })).status, 200);
    const remainingAdmin = (await people()).people.find(row => row.id === ada.id)!;
    assert.deepEqual(remainingAdmin.identities, []);
    assert.equal(remainingAdmin.lastAdmin, true, "revoking the only recorded identity does not remove the admin");
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

test("a week-long code outlives a restart, works once after it, and is never written or logged (INV-2082)", async () => {
  const home = mkdtempSync(join(tmpdir(), "agentbox-people-restart-"));
  const previous = process.env.AGENTBOX_HOME;
  process.env.AGENTBOX_HOME = home;
  const logs: string[] = [];
  let stop: (() => void) | undefined, base = "";
  const start = () => startWebServer({ port: 0, host: "127.0.0.1", token: "t0k", useBox: false, onLog: line => logs.push(line), onReady: url => { base = url; } });
  try {
    stop = await start();
    const made = await fetch(`${base}/api/channels/invite`, { method: "POST", headers: ui, body: JSON.stringify({ role: "driver", minutes: 7 * 24 * 60 }) });
    const { code } = (await made.json()) as Code;
    stop(); stop = await start(); // Save & restart, a door change, an upgrade
    const listed = ((await (await fetch(`${base}/api/people`, { headers: ui })).json()) as { invites: Code[] }).invites;
    assert.equal(listed.length, 1, "still pending");
    assert.equal(listed[0]!.code, undefined, "and not shown again: only its hash was kept");
    const redeem = () => fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name: "Cleo" }) });
    assert.equal((await redeem()).status, 200);
    assert.equal((await redeem()).status, 400, "once");
    assert.ok(!readFileSync(join(home, "invites.json"), "utf8").includes(code));
    assert.ok(logs.every(line => !line.includes(code)), "never logged");
  } finally {
    stop?.();
    if (previous === undefined) delete process.env.AGENTBOX_HOME;
    else process.env.AGENTBOX_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
