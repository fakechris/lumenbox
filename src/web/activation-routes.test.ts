import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startWebServer } from "./server.ts";
import { admission } from "./activation-routes.ts";
import { Activations } from "../host/activations.ts";
import { Directories, directorySource } from "../host/directory.ts";
import { Principals } from "../host/principals.ts";
import { AgentRegistry } from "../agents/registry.ts";
import { directoryProviders } from "../channels/directory.ts";
import { activationRoute } from "./activation-routes.ts";
import { holdReason } from "../host/activations.ts";
import { McpTokenStore } from "./mcp-tokens.ts";
import { SessionEpochs } from "./session-epochs.ts";
import type { DirectorySnapshot } from "../host/directory.ts";

/** The admission on real stores in a temporary home, with a directory the test rewrites: what a sync finds is `org.listed`. */
function organisation(home: string, subjects: string[]) {
  const person = (subject: string) => ({ vendorSubject: subject, name: subject.toUpperCase(), departmentVendorIds: ["1"] });
  const org = { listed: subjects };
  const principals = new Principals(join(home, "principals.json")), directories = new Directories(join(home, "directory.json"));
  const activations = new Activations(join(home, "activations.jsonl")), tokens = new McpTokenStore(), epochs = new SessionEpochs(join(home, "session-epochs.json"));
  const provider = { type: "dingtalk" as const, fetchDirectory: async (): Promise<DirectorySnapshot> => ({ departments: [{ vendorId: "1", name: "Acme", parentVendorId: null }], people: org.listed.map(person) }) };
  const source = directorySource("ding", 1, "ding-app", "dingtalk");
  const deps = {
    activations, directories, principals, credentials: () => ({ source, clientId: "ding-app", clientSecret: "secret", provider }), fetch,
    signOut: (id: string) => { epochs.bump(id); }, revokeTokens: (ids: readonly string[], signInOnly?: boolean) => { tokens.revokeFor(ids, signInOnly); }, log: () => {},
  };
  const door = admission(deps);
  /** A route as an Admin (`p-ana`) calls it. */
  const call = async (route: string, body: Record<string, unknown> = {}) => (await activationRoute(route, new URLSearchParams({ channelId: "ding" }), {
    ...deps, admission: door, refusedAdmin: () => false, readJson: async () => ({ channelId: "ding", ...body }), callerId: () => "p-ana",
    doors: () => [{ id: "ding", name: "DingTalk", type: "dingtalk" }], boxesHeld: () => 0,
  }))!;
  const signedIn = () => subjects.filter(subject => principals.isKnown(`ding:${subject}`));
  return { org, principals, directories, activations, tokens, epochs, source, door, call, signedIn };
}

/** A DingTalk organisation, faked on both sides: the directory the app reads and the sign-in the person makes. */
function dingtalkOrganisation() {
  const departments: Record<string, { name: string; parent: string | null }> = {
    1: { name: "Acme", parent: null }, 10: { name: "Engineering", parent: "1" }, 11: { name: "Platform", parent: "10" }, 20: { name: "Sales", parent: "1" },
  };
  /** userid → the departments that list them. The sign-in's unionId is `union-<userid>`. */
  const people = new Map<string, string[]>([["fay", ["1"]], ["gus", ["10"]], ["cat", ["11"]], ["dan", ["11"]], ["bob", ["20"]]]);
  /** Everybody the organisation employs, listed in the directory or not: Ana and Ivy are outside the app's visible range. */
  const employees = new Set(["ana", "ivy"]);
  const call = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)), body = init?.body === undefined ? {} : JSON.parse(String(init.body));
    const path = url.origin + url.pathname;
    if (path === "https://api.dingtalk.com/v1.0/oauth2/accessToken") return Response.json({ accessToken: "app-token", expireIn: 7200 });
    if (path === "https://api.dingtalk.com/v1.0/oauth2/userAccessToken") return Response.json({ accessToken: body.code });
    if (path === "https://api.dingtalk.com/v1.0/contact/users/me") { const unionId = new Headers(init?.headers).get("x-acs-dingtalk-access-token")!; return Response.json({ unionId, nick: unionId.slice(6) }); }
    if (path === "https://oapi.dingtalk.com/topapi/user/getbyunionid") {
      const userid = String(body.unionid).slice(6);
      return Response.json(people.has(userid) || employees.has(userid) ? { errcode: 0, result: { userid, contact_type: 0 } } : { errcode: 60121, errmsg: "none" });
    }
    if (path === "https://oapi.dingtalk.com/topapi/v2/department/get") return Response.json({ errcode: 0, result: { name: departments[body.dept_id]!.name } });
    if (path === "https://oapi.dingtalk.com/topapi/v2/department/listsub") {
      return Response.json({ errcode: 0, result: Object.entries(departments).filter(([, row]) => row.parent === String(body.dept_id)).map(([id, row]) => ({ dept_id: Number(id), name: row.name })) });
    }
    if (path === "https://oapi.dingtalk.com/topapi/v2/user/list") {
      const list = [...people].filter(([, ids]) => ids.includes(String(body.dept_id))).map(([userid, ids]) => ({ userid, name: userid[0]!.toUpperCase() + userid.slice(1), dept_id_list: ids.map(Number) }));
      return Response.json({ errcode: 0, result: { list, has_more: false } });
    }
    throw new Error(`unexpected vendor call ${url.href}`);
  }) as typeof fetch;
  return { people, employees, call };
}

test("an Admin activates a person or a department and they sign in at that role; anybody else has asked to join, once; a sync ends the sign-in of whoever the directory stopped listing and deletes nothing (INV-2202)", async t => {
  const home = mkdtempSync(join(tmpdir(), "inv2202-activation-"));
  const previousHome = process.env.AGENTBOX_HOME, previousUrl = process.env.AGENTBOX_PUBLIC_URL;
  process.env.AGENTBOX_HOME = home; process.env.AGENTBOX_PUBLIC_URL = "https://org.example";
  let stop: (() => void) | undefined;
  t.after(() => {
    stop?.();
    if (previousHome === undefined) delete process.env.AGENTBOX_HOME; else process.env.AGENTBOX_HOME = previousHome;
    if (previousUrl === undefined) delete process.env.AGENTBOX_PUBLIC_URL; else process.env.AGENTBOX_PUBLIC_URL = previousUrl;
    rmSync(home, { recursive: true, force: true });
  });
  writeFileSync(join(home, "channels.json"), JSON.stringify({ channels: [{ id: "ding", name: "DingTalk", type: "dingtalk", incarnation: 1, boxId: "default", createdAt: new Date().toISOString() }] }));
  writeFileSync(join(home, "config.json"), JSON.stringify({ env: { DING_CLIENT_ID: "ding-app", DING_CLIENT_SECRET: "secret" } }));
  // Admitted another way, and not in the directory: Ana by the bootstrap code, Ivy by an invite.
  writeFileSync(join(home, "principals.json"), JSON.stringify({
    principals: [{ id: "p-ana", name: "Ana", role: "admin", identities: ["ding:ana"] }, { id: "p-ivy", name: "Ivy", role: "driver", identities: ["ding:ivy"] }],
    installation: { mode: "organisation" },
  }));
  // Cat's personal computer, as it will be once she is on the roster: hers alone.
  const boxes = new AgentRegistry(join(home, "agents"));
  boxes.attachBox({ id: "cat-box", name: "Cat's computer", kind: "attached", members: ["ding:cat"], displayFloor: 1, workDir: "/work", createdAt: new Date().toISOString() });
  const org = dingtalkOrganisation();
  let base = "";
  stop = await startWebServer({ port: 0, host: "127.0.0.1", token: "fixture", useBox: false, loginFetch: org.call, directoryFetch: org.call, onLog: () => {}, onReady: url => { base = url; } });

  const api = async (path: string, body?: unknown, cookie?: string) => {
    const response = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", ...(cookie !== undefined ? { cookie } : { authorization: "Bearer fixture" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: (await response.json()) as any };
  };
  /** Scan: through the door as `userid`. The session cookie when let in, the page when not. */
  const scan = async (userid: string) => {
    const begin = await fetch(`${base}/auth/ding`, { redirect: "manual" });
    const state = new URL(begin.headers.get("location")!).searchParams.get("state")!;
    const response = await fetch(`${base}/auth/ding/callback?state=${state}&code=union-${userid}`, { redirect: "manual", headers: { "accept-language": "en", cookie: begin.headers.getSetCookie()[0]!.split(";")[0]! } }); // the browser that started it
    const cookie = response.headers.getSetCookie()[0]?.split(";")[0];
    return { status: response.status, cookie, page: cookie === undefined ? await response.text() : "" };
  };
  const me = async (cookie: string) => (await api("/api/me", undefined, cookie));
  const waiting = /Your request to join is with the Admins/;
  const stateOf = async (department: string, subject: string) =>
    (await api(`/api/activations/people?channelId=ding&department=${department}`)).data.people.find((person: { subject: string }) => person.subject === subject)?.state;

  const ana = await scan("ana"), ivy = await scan("ivy");
  assert.equal((await me(ana.cookie!)).data.role, "admin");

  assert.deepEqual((await api("/api/directories/sync", { channelId: "ding" })).data, { ok: true, left: 0, held: 0 });
  const tree = (await api("/api/activations")).data;
  assert.deepEqual(
    tree.departments.map((node: { name: string; direct: number; total: number; parentVendorId: string | null }) => [node.name, node.parentVendorId, node.direct, node.total]),
    [["Acme", null, 1, 5], ["Engineering", "1", 1, 3], ["Sales", "1", 1, 1], ["Platform", "10", 2, 2]],
    "the tree is departments and head counts; nobody's row is sent until a department is opened",
  );
  assert.equal(JSON.stringify(tree).includes("Gus"), false);

  // Scanning proves who Bob is and lets him in nowhere: one request, however often he scans.
  for (let scans = 0; scans < 3; scans++) {
    const refused = await scan("bob");
    assert.equal(refused.status, 403);
    assert.equal(refused.cookie, undefined, "no session");
    assert.match(refused.page, waiting);
  }
  const asked = (await api("/api/activations")).data;
  assert.deepEqual(asked.requests.map((request: { subject: string; listed: boolean }) => [request.subject, request.listed]), [["bob", true]]);
  assert.equal(await stateOf("20", "bob"), "asked");
  assert.equal(new Principals().list().length, 2, "a request is not a person on the roster, and neither is a directory row");

  // The Admin activates that request: the next sign-in is let through, at the role chosen.
  assert.equal((await api("/api/activations/person", { channelId: "ding", subject: "bob", role: "viewer" })).status, 200);
  assert.equal(new Principals().list().length, 2, "still nobody new: the activation is a record until Bob signs in");
  const bob = await scan("bob");
  assert.equal(bob.status, 302);
  assert.deepEqual((({ identity, name, role }) => ({ identity, name, role }))((await me(bob.cookie!)).data), { identity: "ding:bob", name: "Bob", role: "viewer" }, "the identity the DingTalk chat mints, named as the directory names him");
  assert.equal((await api("/api/activations")).data.requests.length, 0);
  assert.equal((await api("/api/activations/person", { channelId: "ding", subject: "nobody", role: "driver" })).status, 404, "never a subject typed from nowhere");
  assert.equal((await api("/api/activations/person", { channelId: "ding", subject: "gus", role: "owner" })).status, 400);

  // A department without its sub-departments: Gus is in Engineering, Cat in Platform under it.
  assert.deepEqual((await api("/api/activations/department", { channelId: "ding", department: "10", includeSub: false, role: "driver" })).data, { activated: 1, alreadyActive: 0 });
  const gus = await scan("gus");
  assert.equal((await me(gus.cookie!)).data.role, "driver");
  assert.match((await scan("cat")).page, waiting, "a sub-department was not asked for");
  // With them: Cat and Dan now; Gus was already active and is counted, not rewritten.
  assert.deepEqual((await api("/api/activations/department", { channelId: "ding", department: "10", includeSub: true, role: "driver" })).data, { activated: 2, alreadyActive: 1 });
  const cat = await scan("cat");
  assert.equal((await me(cat.cookie!)).data.role, "driver");
  assert.equal((await api("/api/activations/department", { channelId: "ding", department: "99", role: "driver" })).status, 404);
  const asAdmins = await api("/api/activations/department", { channelId: "ding", department: "20", role: "admin" });
  assert.deepEqual([asAdmins.status, asAdmins.data.code], [400, "activation-department-admin"], "a department is never made Admins in one press");

  // The audit says the bulk act as one act: who, which department, how many, which role.
  const acts = (await api("/api/activations/audit")).data.acts as Array<Record<string, unknown>>;
  const bulk = acts.filter(act => act.type === "activate-department").at(-1)!;
  assert.deepEqual(
    { by: bulk.by, department: bulk.department, includeSub: bulk.includeSub, count: bulk.count, role: bulk.role },
    { by: "operator", department: { vendorId: "10", name: "Engineering" }, includeSub: true, count: 2, role: "driver" },
  );
  assert.equal(acts.filter(act => act.type === "request").length, 2, "Bob's three scans and Cat's one: a request each");

  // Admin only, in the route: a driver and a viewer are refused by every one of them.
  for (const cookie of [gus.cookie!, bob.cookie!]) {
    for (const [path, body] of [
      ["/api/activations", undefined], ["/api/activations/people?channelId=ding&department=10", undefined], ["/api/activations/audit", undefined],
      ["/api/activations/person", { channelId: "ding", subject: "fay", role: "admin" }], ["/api/activations/department", { channelId: "ding", department: "1", includeSub: true, role: "admin" }],
      ["/api/activations/dismiss", { channelId: "ding", subject: "fay" }], ["/api/directories/sync", { channelId: "ding" }],
      ["/api/activations/held/confirm", { channelId: "ding" }], ["/api/activations/held/dismiss", { channelId: "ding" }],
    ] as const) assert.equal((await api(path, body, cookie)).status, 403, `${path} as ${(await me(cookie)).data.role}`);
  }
  assert.equal(await stateOf("1", "fay"), "listed", "and nothing they sent was done");

  // Somebody who joins the department after it was activated is listed, and asks like anybody else.
  org.people.set("hal", ["11"]);
  assert.deepEqual((await api("/api/directories/sync", { channelId: "ding" })).data, { ok: true, left: 0, held: 0 });
  assert.equal(await stateOf("11", "hal"), "listed");
  assert.match((await scan("hal")).page, waiting);
  assert.equal(await stateOf("11", "hal"), "asked");

  // Cat leaves the organisation. She holds a session, a token she made and one made for her, and a computer.
  assert.equal((await api("/api/mcp/tokens", { label: "hers" }, cat.cookie!)).status, 200);
  assert.equal((await api("/api/mcp/tokens", { label: "for her", principalId: "ding:cat" })).status, 200);
  const tokensOf = async (id: string) => (await api("/api/mcp")).data.tokens.filter((token: { principalId: string }) => token.principalId === id).length;
  assert.equal(await tokensOf("ding:cat"), 2);
  // No longer listed, and still able to prove who she is (moved out of what the app may see): the harder case than DingTalk refusing her itself.
  org.people.delete("cat"); org.employees.add("cat");
  assert.deepEqual((await api("/api/directories/sync", { channelId: "ding" })).data, { ok: true, left: 1, held: 0 });
  assert.equal((await me(cat.cookie!)).status, 401, "her session stops");
  assert.equal(await tokensOf("ding:cat"), 0, "and her tokens");
  const after = (await api("/api/activations")).data;
  assert.deepEqual(after.left.map((person: { subject: string; principalId: string; boxes: number }) => [person.subject, person.principalId, person.boxes]), [["cat", "ding:cat", 1]], "left, with what she holds shown to the Admins");
  assert.deepEqual(new AgentRegistry(join(home, "agents")).boxById("cat-box")?.members, ["ding:cat"], "her computer's record is untouched");
  assert.deepEqual(new Principals().byId("ding:cat")?.identities, [], "she is still its owner on the roster, with no way in");
  const back = await scan("cat");
  assert.equal(back.cookie, undefined, "the activation she used admits nobody now");
  assert.match(back.page, waiting);
  // Ana and Ivy were never in the directory and were not let in by it: three syncs later they are still signed in.
  assert.equal((await me(ana.cookie!)).data.role, "admin");
  assert.equal((await me(ivy.cookie!)).data.role, "driver");
  assert.equal((await me(gus.cookie!)).data.role, "driver", "and whoever is still listed");

  // The last Admin is never taken by a sync: Dan, activated as Admin, is the only one once Ana is removed.
  assert.equal((await api("/api/activations/person", { channelId: "ding", subject: "dan", role: "admin" })).data.already, true, "Dan was activated with his department; a second press changes nothing");
  const dan = await scan("dan");
  assert.equal((await api("/api/principals", { principals: new Principals().list().map(person => person.id === "ding:dan" ? { ...person, role: "admin" } : person) })).status, 200);
  assert.equal((await api("/api/principals/remove", { principalId: "p-ana" })).status, 200);
  org.people.delete("dan"); org.people.delete("gus");
  assert.deepEqual((await api("/api/directories/sync", { channelId: "ding" })).data, { ok: true, left: 1, held: 0 }, "Gus left; Dan stays");
  assert.equal((await me(dan.cookie!)).data.role, "admin");
  assert.equal((await me(gus.cookie!)).status, 401);
  assert.deepEqual((await api("/api/activations")).data.unlisted, [{ subject: "dan", name: "Dan" }], "and the page says he is no longer listed");
  assert.match(readFileSync(join(home, "activations.jsonl"), "utf8"), /"type":"left"[^\n]*"subject":"gus"/);
});

test("an activation belongs to the door it was made against, and a request outlives a restart (INV-2202)", async () => {
  const home = mkdtempSync(join(tmpdir(), "inv2202-source-"));
  try {
    const path = join(home, "activations.jsonl");
    const principals = new Principals(join(home, "principals.json"));
    principals.save([{ id: "p-ana", name: "Ana", role: "admin", identities: ["web:ana"] }]);
    const directories = new Directories(join(home, "directory.json"));
    let incarnation = 1;
    const credentials = (channelId: string) => ({ source: directorySource(channelId, incarnation, "ding-app", "dingtalk"), clientId: "ding-app", clientSecret: "secret", provider: directoryProviders.dingtalk! });
    const door = () => admission({ activations: new Activations(path), directories, principals, credentials, fetch, signOut: () => {}, revokeTokens: () => {}, log: () => {} });
    const snapshot = { departments: [{ vendorId: "1", name: "Acme", parentVendorId: null }], people: [{ vendorSubject: "bob", name: "Bob", departmentVendorIds: ["1"] }, { vendorSubject: "cat", name: "Cat", departmentVendorIds: ["1"] }] };
    await directories.sync(credentials("ding").source, async () => snapshot);

    assert.equal(door().admit("ding", "cat", "Cat"), "asked");
    assert.equal(door().admit("ding", "cat", "Cat"), "asked", "a server started again still holds the one request");
    const kept = new Activations(path);
    assert.deepEqual(kept.requests(credentials("ding").source).map(request => request.subject), ["cat"]);
    assert.equal(readFileSync(path, "utf8").trim().split("\n").length, 1);

    kept.activateDepartment(credentials("ding").source, snapshot, "1", false, "driver", "p-ana", () => false);
    // The door's app is replaced: a new incarnation is a different source, and its subjects are not presumed to be the old ones.
    incarnation = 2;
    assert.equal(door().admit("ding", "bob", "Bob"), "asked", "an activation made against the old door admits nobody through the new one");
    assert.equal(principals.list().length, 1);
    assert.equal(door().stateOf(credentials("ding").source, "bob"), "asked");
    incarnation = 1;
    assert.equal(door().admit("ding", "bob", "Bob"), "admitted", "and it still stands for the door it was made against");
    assert.equal(principals.resolve("ding:bob").role, "driver");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("a sync that would sign many people out at once is held: nothing changes until an Admin confirms it, and the hourly refresh is held the same way (INV-2202)", async () => {
  // The rule itself, in the one place it is decided.
  assert.equal(holdReason({ leaving: 1, standing: 30, listedNow: 59, listedBefore: 60 }), undefined, "one of thirty is believed");
  assert.equal(holdReason({ leaving: 5, standing: 6, listedNow: 55, listedBefore: 60 }), undefined, "five people are few, whatever share they are");
  assert.equal(holdReason({ leaving: 6, standing: 100, listedNow: 94, listedBefore: 100 }), undefined, "six of a hundred are a small share");
  assert.equal(holdReason({ leaving: 20, standing: 30, listedNow: 40, listedBefore: 60 }), "many");
  assert.equal(holdReason({ leaving: 2, standing: 30, listedNow: 20, listedBefore: 60 }), "halved");
  assert.equal(holdReason({ leaving: 1, standing: 30, listedNow: 0, listedBefore: 60 }), "empty");
  assert.equal(holdReason({ leaving: 0, standing: 30, listedNow: 0, listedBefore: 60 }), undefined, "nobody to sign out: nothing to hold");

  const home = mkdtempSync(join(tmpdir(), "inv2202-brake-"));
  try {
    // Thirty people let in by activation, thirty more the directory only lists.
    const active = Array.from({ length: 30 }, (_, index) => `a${String(index + 1).padStart(2, "0")}`), others = Array.from({ length: 30 }, (_, index) => `o${index}`);
    const { org, principals, directories, activations, epochs, source, door, call, signedIn } = organisation(home, active);
    principals.save([{ id: "p-ana", name: "Ana", role: "admin", identities: ["web:ana"] }]);
    org.listed = [...active, ...others];
    assert.deepEqual(await door.sync("ding"), { left: 0, held: 0 });
    for (const subject of active) { activations.activatePerson(source, { subject, name: subject }, "driver", "p-ana", true); assert.equal(door.admit("ding", subject, subject), "admitted"); }
    assert.equal(signedIn().length, 30);

    // One of thirty leaves: believed, applied.
    org.listed = [...active.slice(0, 29), ...others];
    assert.deepEqual(await door.sync("ding"), { left: 1, held: 0 });
    assert.equal(principals.isKnown("ding:a30"), false);
    assert.equal(epochs.of("ding:a30"), 1);

    // A day later the hourly refresh reads a list without twenty of them: held, and nobody is touched.
    const stored = JSON.parse(readFileSync(join(home, "directory.json"), "utf8"));
    stored.ding.syncedAt = new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString();
    writeFileSync(join(home, "directory.json"), JSON.stringify(stored));
    org.listed = [...active.slice(0, 9), ...others];
    await door.refreshStale(["ding"]);
    assert.equal(directories.status(source), "ready", "the refresh did sync");
    assert.equal(signedIn().length, 29, "every sign-in still stands");
    assert.deepEqual(active.slice(9, 29).map(subject => [principals.resolve(`ding:${subject}`).role, epochs.of(`ding:${subject}`)]), Array(20).fill(["driver", 0]), "role and sessions too");
    const held = (await call("GET /api/activations")).body as { held: { reason: string; people: { subject: string }[] } | null; left: unknown[]; unlisted: unknown[] };
    assert.deepEqual(held.unlisted, [], "people waiting in a hold are not reported as an Admin the sync kept");
    assert.equal(held.held?.reason, "many");
    assert.deepEqual(held.held?.people.map(person => person.subject), active.slice(9, 29), "the page is given who would leave");
    assert.equal(held.left.length, 1, "and only a30 has left");
    const lines = () => readFileSync(join(home, "activations.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line) as { type: string; by?: string; count?: number });
    const holds = () => lines().filter(line => line.type === "hold").length;
    assert.deepEqual(await door.sync("ding"), { left: 0, held: 20 }, "pressing the button is held the same way");
    assert.equal(holds(), 1, "the same hold is not written again by every sync");

    // Put away: the next sync is judged afresh, and is held again.
    assert.equal((await call("POST /api/activations/held/dismiss")).status, 200);
    assert.equal(activations.held(source), undefined);
    assert.equal((await call("POST /api/activations/held/confirm")).status, 404, "nothing held, nothing to confirm");
    assert.deepEqual(await door.sync("ding"), { left: 0, held: 20 });
    assert.equal(signedIn().length, 29);

    // Confirmed: exactly those twenty leave, as one act naming who confirmed.
    assert.deepEqual((await call("POST /api/activations/held/confirm")).body, { left: 20 });
    assert.deepEqual(signedIn(), active.slice(0, 9));
    assert.equal(activations.held(source), undefined);
    assert.deepEqual(lines().filter(line => line.type === "left-confirmed").map(line => [line.by, line.count]), [["p-ana", 20]]);
    assert.equal(lines().filter(line => line.type === "left").length, 1, "one bulk line, not twenty");

    // A sync that lists nobody never signs anybody out by itself, however few are left to lose.
    org.listed = [];
    assert.deepEqual(await door.sync("ding"), { left: 0, held: 9 });
    assert.equal(activations.held(source)?.reason, "empty");
    assert.equal(signedIn().length, 9);
    // The directory comes back whole: that sync is believed, and the hold it replaces is gone.
    org.listed = [...active.slice(0, 9), ...others];
    assert.deepEqual(await door.sync("ding"), { left: 0, held: 0 });
    assert.equal(activations.held(source), undefined);
    assert.equal(signedIn().length, 9);

    // A fetch that fails is not a sync: the snapshot before it stands and nothing follows.
    org.listed = [{ broken: true } as unknown as string];
    await assert.rejects(door.sync("ding"), /Previous complete snapshot retained/);
    assert.equal(directories.of("ding")?.snapshot?.people.length, 39);
    assert.equal(signedIn().length, 9);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("leaving ends the sign-in the directory gave and what was made from it; a person with another way in keeps their role and it (INV-2202)", async () => {
  const home = mkdtempSync(join(tmpdir(), "inv2202-leave-"));
  try {
    const { org, principals, activations, tokens, epochs, source, door } = organisation(home, ["bob", "cat", "dan", "eve"]);
    principals.save([{ id: "p-ana", name: "Ana", role: "admin", identities: ["web:ana"] }]);
    const others = ["o1", "o2", "o3", "o4", "o5", "o6"]; // three of ten leaving is a sync that is believed
    org.listed = ["bob", "cat", "dan", "eve", ...others];
    await door.sync("ding");
    for (const [subject, role] of [["bob", "driver"], ["cat", "admin"], ["dan", "driver"], ["eve", "driver"]] as const) {
      activations.activatePerson(source, { subject, name: subject }, role, "p-ana", true);
      door.admit("ding", subject, subject);
    }
    // Bob and Cat have since linked another sign-in (an invite code in a browser); Ana is gone, so Cat is the only Admin.
    principals.save(principals.list().filter(person => person.id !== "p-ana").map(person => ["ding:bob", "ding:cat"].includes(person.id) ? { ...person, identities: [...person.identities, `web:${person.name}`] } : person));
    const fromSignIn = tokens.mint("ding:bob", "made while signed in through DingTalk").token, forBob = tokens.mint("ding:bob", "made for Bob by an Admin", new Date(), "person").token;
    const dans = tokens.mint("ding:dan", "Dan's", new Date(), "person").token;

    org.listed = ["eve", ...others];
    assert.deepEqual(await door.sync("ding"), { left: 3, held: 0 });
    const bob = principals.byId("ding:bob")!, cat = principals.byId("ding:cat")!, dan = principals.byId("ding:dan")!;
    // Bob: the DingTalk sign-in is gone and what was made from it; he is still a driver through his other one.
    assert.deepEqual([bob.role, bob.identities], ["driver", ["web:bob"]]);
    assert.equal(epochs.of("ding:bob"), 0, "his other sessions are not this sync's to end; one made through DingTalk stops because nobody holds that identity");
    assert.equal(tokens.personFor(fromSignIn, principals), undefined);
    assert.equal(tokens.personFor(forBob, principals), "ding:bob", "a token given to the person stands while he has a way in");
    // Cat, the only Admin, keeps another way in: she loses the DingTalk one like anybody, and stays Admin.
    assert.deepEqual([cat.role, cat.identities], ["admin", ["web:cat"]]);
    // Dan had nothing else: no sign-in, no say, every session and token ended; still on the roster as the owner of what he has.
    assert.deepEqual([dan.role, dan.identities], ["viewer", []]);
    assert.equal(epochs.of("ding:dan"), 1);
    assert.equal(tokens.personFor(dans, principals), undefined);
    assert.equal(tokens.list().length, 1);
    assert.equal(principals.resolve("ding:eve").role, "driver", "and whoever is still listed is untouched");
  } finally { rmSync(home, { recursive: true, force: true }); }
});
