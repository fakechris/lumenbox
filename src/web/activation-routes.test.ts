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
    const response = await fetch(`${base}/auth/ding/callback?state=${state}&code=union-${userid}`, { redirect: "manual", headers: { "accept-language": "en" } });
    const cookie = response.headers.getSetCookie()[0]?.split(";")[0];
    return { status: response.status, cookie, page: cookie === undefined ? await response.text() : "" };
  };
  const me = async (cookie: string) => (await api("/api/me", undefined, cookie));
  const waiting = /Your request to join is with the Admins/;
  const stateOf = async (department: string, subject: string) =>
    (await api(`/api/activations/people?channelId=ding&department=${department}`)).data.people.find((person: { subject: string }) => person.subject === subject)?.state;

  const ana = await scan("ana"), ivy = await scan("ivy");
  assert.equal((await me(ana.cookie!)).data.role, "admin");

  assert.deepEqual((await api("/api/directories/sync", { channelId: "ding" })).data, { ok: true, left: 0 });
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
    ] as const) assert.equal((await api(path, body, cookie)).status, 403, `${path} as ${(await me(cookie)).data.role}`);
  }
  assert.equal(await stateOf("1", "fay"), "listed", "and nothing they sent was done");

  // Somebody who joins the department after it was activated is listed, and asks like anybody else.
  org.people.set("hal", ["11"]);
  assert.deepEqual((await api("/api/directories/sync", { channelId: "ding" })).data, { ok: true, left: 0 });
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
  assert.deepEqual((await api("/api/directories/sync", { channelId: "ding" })).data, { ok: true, left: 1 });
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
  assert.deepEqual((await api("/api/directories/sync", { channelId: "ding" })).data, { ok: true, left: 1 }, "Gus left; Dan stays");
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
