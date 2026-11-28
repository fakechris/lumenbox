import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWebServer } from "./server.ts";
import { Principals } from "../host/principals.ts";
import { PersonalBoxStartError, type PersonalBoxDriver } from "../host/personal-boxes.ts";
import { AgentRegistry } from "../agents/registry.ts";
import { STARTING_AT_ONCE, personalBoxAt } from "../host/auto-personal-box.ts";
import { deprecationsInUse } from "../deprecations.ts";
import { STARTER_TEAM } from "../host/orchestrator.ts";
import { directorySource } from "../host/directory.ts";
import { Activations } from "../host/activations.ts";
import { enrolStandingActivations } from "../host/enrolment.ts";

// These requests carry identity the way the hosted gateway sends it (INV-1543).
process.env.AGENTBOX_TRUST_GATEWAY_IDENTITY = "1";

const roster = [
  { id: "alice", name: "Alice", role: "driver" as const, identities: ["web:alice"] },
  { id: "carol", name: "Carol", role: "viewer" as const, identities: ["web:carol"] },
  { id: "operator", name: "Operator", role: "admin" as const, identities: ["web:operator"] },
];

/** The DingTalk door `withDoor` gives an organisation: its directory lists `p01`…`p30` in Engineering and `v01` in Sales. */
const staff = Array.from({ length: 30 }, (_, index) => `p${String(index + 1).padStart(2, "0")}`);

/** An organisation server on a temporary home, with a fake box backend that counts what it was asked to start. */
async function organisation(t: { after(fn: () => void): void }, options: { config?: Record<string, unknown>; start?: (name: string) => Promise<string>; withDoor?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), "auto-personal-box-"));
  const previous = process.env.AGENTBOX_HOME;
  process.env.AGENTBOX_HOME = home;
  const stops: Array<() => void> = [];
  t.after(() => {
    for (const stop of stops) stop();
    if (previous === undefined) delete process.env.AGENTBOX_HOME; else process.env.AGENTBOX_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  });
  new Principals().save(roster);
  if (options.withDoor) {
    // A door with an app behind it and a directory synced a moment ago, as an Admin's "sync now" leaves them.
    writeFileSync(join(home, "channels.json"), JSON.stringify({ channels: [{ id: "ding", name: "DingTalk", type: "dingtalk", incarnation: 1, boxId: "default", createdAt: new Date().toISOString() }] }));
    const people = [...staff.map(subject => ({ vendorSubject: subject, name: subject.toUpperCase(), departmentVendorIds: ["10"] })), { vendorSubject: "v01", name: "V01", departmentVendorIds: ["20"] }];
    writeFileSync(join(home, "directory.json"), JSON.stringify({ ding: {
      source: directorySource("ding", 1, "ding-app", "dingtalk"), syncedAt: new Date().toISOString(),
      snapshot: { departments: [{ vendorId: "10", name: "Engineering", parentVendorId: null }, { vendorId: "20", name: "Sales", parentVendorId: null }], people },
    } }));
  }
  const config = { ...(options.withDoor ? { env: { DING_CLIENT_ID: "ding-app", DING_CLIENT_SECRET: "secret" } } : {}), ...options.config };
  if (Object.keys(config).length > 0) writeFileSync(join(home, "config.json"), JSON.stringify(config));
  const started: string[] = [];
  const driver: PersonalBoxDriver = {
    start: async record => { const name = record.displayName ?? record.name; started.push(name); return (options.start ?? (async () => "http://127.0.0.1:1"))(name); },
    remove: async () => {},
    memoryRequest: "2Gi", // what the allocator would place each box with: what an estimate multiplies
  };
  const dial = async () => { throw new Error("unexpected Docker lookup"); };
  async function boot() {
    let base = "";
    const stop = await startWebServer({
      port: 0, host: "127.0.0.1", token: "auto-test", onReady: url => { base = url; }, onLog: () => {},
      boxProvisioner: { kind: "docker", boxName: "agentbox-box", label: "Docker", connect: dial, endpoint: dial },
      personalBoxDriver: driver,
    });
    stops.push(stop);
    return async (path: string, identity: string, body?: unknown) => {
      const response = await fetch(base + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: "Bearer auto-test", "x-agentbox-user": identity, "x-agentbox-role": identity === "web:operator" ? "owner" : "member",
          "content-type": "application/json", "accept-language": "en" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, data: await response.json() };
    };
  }
  return { home, started, boot, stopAll: () => { for (const stop of stops.splice(0)) stop(); } };
}

async function settled(request: Awaited<ReturnType<Awaited<ReturnType<typeof organisation>>["boot"]>>, identity: string) {
  for (let i = 0; i < 100; i++) {
    const mine = (await request("/api/personal-boxes", identity)).data;
    if (!mine.boxes.some((box: { status: string }) => box.status === "provisioning" || box.status === "deleting")) return mine;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail("the personal box never left provisioning");
}

test("INV-2203: a driver's first sign-in makes one personal box, once, across tabs, restarts and a deliberate delete", async (t) => {
  let release: (url: string) => void = () => {};
  const org = await organisation(t, { start: () => new Promise(resolve => { release = resolve; }) });
  let request = await org.boot();
  // Two tabs and a second device arrive at once.
  const arrivals = await Promise.all([request("/api/me", "web:alice"), request("/api/me", "web:alice"), request("/api/me", "web:alice")]);
  assert.ok(arrivals.every(reply => reply.status === 200));
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(org.started, ["Alice’s sandbox"], "one box, named as the create dialog suggests");
  const preparing = await request("/api/setup", "web:alice");
  assert.equal(preparing.data.hasPersonalBox, false);
  assert.deepEqual(preparing.data.autoBox, { state: "preparing" });
  assert.deepEqual((await request("/api/personal-boxes/panel", "web:alice")).data.mine.auto, { state: "preparing" });
  release("http://127.0.0.1:1");
  const mine = await settled(request, "web:alice");
  assert.equal(mine.boxes.length, 1);
  assert.equal(mine.auto, undefined, "nothing more to say once it is up");

  await request("/api/me", "web:carol");
  assert.equal(org.started.length, 1, "a viewer gets none");
  assert.deepEqual((await request("/api/personal-boxes", "web:carol")).data.boxes, []);

  org.stopAll();
  request = await org.boot();
  await request("/api/me", "web:alice");
  assert.equal(org.started.length, 1, "a restarted server makes none again");

  // Her box has her agent in it now (INV-2220), so deleting it names that agent; another agent lives elsewhere on the installation.
  assert.equal(mine.boxes[0].agents.length, 1);
  new AgentRegistry(join(org.home, "agents")).create({ name: "Shared" });
  const removed = await request("/api/personal-boxes/remove", "web:alice", { id: mine.boxes[0].id, deleteData: true, deleteAgents: true, agentIds: mine.boxes[0].agentIds });
  assert.equal(removed.status, 200);
  assert.equal(removed.data.boxes.length, 0);
  org.stopAll();
  request = await org.boot();
  await request("/api/me", "web:alice");
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(org.started.length, 1, "a person who deleted their box does not get another on the next page load");
  assert.equal((await request("/api/setup", "web:alice")).data.autoBox, undefined);
});

test("INV-2203: a start that fails says the platform's reason, and is not tried again", async (t) => {
  const org = await organisation(t, { start: async () => { throw new PersonalBoxStartError("pull failed", "ImagePullBackOff", "Check the image."); } });
  const request = await org.boot();
  await request("/api/me", "web:alice");
  await settled(request, "web:alice");
  const setup = await request("/api/setup", "web:alice");
  assert.deepEqual(setup.data.autoBox, { state: "failed", reason: "ImagePullBackOff", id: setup.data.autoBox.id });
  assert.ok(setup.data.autoBox.id, "and the box its owner's Try again starts again (INV-2311)");
  await request("/api/me", "web:alice");
  assert.equal(org.started.length, 1);
});

test("INV-2203: out of quota makes none, says why, shows the Admins, and is not retried", async (t) => {
  const org = await organisation(t, { config: { personalBoxQuota: 0 } });
  const request = await org.boot();
  for (let i = 0; i < 3; i++) await request("/api/me", "web:alice");
  assert.equal(org.started.length, 0);
  assert.deepEqual((await request("/api/setup", "web:alice")).data.autoBox, { state: "quota" });
  const panel = (await request("/api/personal-boxes/panel", "web:operator")).data;
  assert.equal(panel.inventory.people.find((person: { id: string }) => person.id === "alice").waitingForQuota, true);
  assert.equal(panel.inventory.people.find((person: { id: string }) => person.id === "carol").waitingForQuota, undefined);
  // An Admin raises the quota and Alice makes her box by hand: she is no longer out of quota anywhere.
  assert.equal((await request("/api/quotas", "web:operator", { personalBoxQuota: 1 })).status, 200);
  assert.equal((await request("/api/personal-boxes/create", "web:alice", { requestId: "by-hand", name: "Mine" })).status, 200);
  assert.equal((await request("/api/setup", "web:alice")).data.autoBox, undefined);
  assert.equal((await request("/api/personal-boxes/panel", "web:alice")).data.mine.auto, undefined);
  const after = (await request("/api/personal-boxes/panel", "web:operator")).data;
  assert.equal(after.inventory.people.find((person: { id: string }) => person.id === "alice").waitingForQuota, undefined);
});

test("INV-2203: the switch off makes none; a personal installation is untouched", async (t) => {
  // The old switch is read as what it meant, the new setting wins over it, and with neither a cluster makes the box at activation.
  assert.deepEqual([personalBoxAt({ autoPersonalBox: true }, true), personalBoxAt({ autoPersonalBox: false }, true), personalBoxAt({ autoPersonalBox: false, personalBoxAt: "activation" }, false), personalBoxAt({}, true), personalBoxAt({}, false)],
    ["first-use", "never", "activation", "activation", "never"]);
  assert.match(deprecationsInUse({ configKeys: ["autoPersonalBox"], envNames: [] })[0] ?? "", /"autoPersonalBox".*Use instead: config\.json "personalBoxAt"/);
  const off = await organisation(t, { config: { autoPersonalBox: false } });
  const request = await off.boot();
  await request("/api/me", "web:alice");
  assert.equal(off.started.length, 0);
  assert.equal((await request("/api/setup", "web:alice")).data.autoBox, undefined);
  off.stopAll();

  const personal = await organisation(t);
  writeFileSync(join(personal.home, "principals.json"), JSON.stringify({
    principals: [{ id: "local:owner", name: "Owner", role: "admin", identities: ["web:owner"] }], installation: { mode: "single-machine", ownerId: "local:owner" },
  }));
  const owner = await personal.boot();
  assert.equal((await owner("/api/me", "web:owner")).status, 200);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(personal.started.length, 0);
});

/** Waits until no personal box of the installation is being started or cleaned up, and nothing more is on its way. */
async function allSettled(request: Awaited<ReturnType<Awaited<ReturnType<typeof organisation>>["boot"]>>, boxes: number) {
  for (let i = 0; i < 400; i++) {
    const rows = (await request("/api/personal-boxes/admin", "web:operator")).data.boxes as Array<{ owner: string; status: string; stateReason?: string; agents: string[]; agentIds: string[]; id: string; name: string }>;
    if (rows.length >= boxes && !rows.some(box => box.status === "provisioning" || box.status === "deleting")) return rows;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail("the personal boxes never settled");
}

test("INV-2220: activating a person makes their box and one agent in it, written down as their home agent; a viewer and a person out of quota get neither", async (t) => {
  let open: () => void = () => {};
  const gate = new Promise<void>(resolve => { open = resolve; });
  const org = await organisation(t, { withDoor: true, config: { personBoxQuotas: { "ding:p03": 0 } }, start: async () => { await gate; return "http://127.0.0.1:1"; } });
  const request = await org.boot();
  assert.equal((await request("/api/activations/person", "web:operator", { channelId: "ding", subject: "p01", role: "driver" })).status, 200);
  assert.deepEqual(new Principals().byId("ding:p01"), { id: "ding:p01", name: "P01", role: "driver", identities: ["ding:p01"] }, "on the roster at once, while her box is still starting");
  open();
  const [box] = await allSettled(request, 1);
  assert.deepEqual([box!.owner, box!.status, box!.name], ["ding:p01", "ready", "P01 的沙盒"], "her own, made through the member's path, named in the door's language");
  for (let i = 0; i < 100 && new Principals().byId("ding:p01")?.homeAgentId === undefined; i++) await new Promise(resolve => setTimeout(resolve, 20));
  const home = new Principals().byId("ding:p01")!.homeAgentId!;
  const registry = new AgentRegistry(join(org.home, "agents"));
  assert.deepEqual(registry.agentsIn(box!.id).map(agent => agent.id), [home], "one agent in it, and it is the one the roster names");
  const assistant = registry.get(home).profile;
  assert.deepEqual([assistant.name, assistant.title, assistant.tools, assistant.ownerUserId], ["助手", STARTER_TEAM[0]!.title, [...STARTER_TEAM[0]!.tools!], "ding:p01"], "the starter team's first agent, alone, under the assistant's name");
  // Their first page load finds the box and makes nothing more.
  assert.equal((await request("/api/me", "ding:p01")).data.role, "driver");
  assert.deepEqual((await request("/api/personal-boxes", "ding:p01")).data.boxes.map((row: { id: string }) => row.id), [box!.id]);
  assert.equal(org.started.length, 1);

  // A viewer is on the roster and gets no box and no agent; so is a person whose quota is 0, and the Admins are shown why.
  assert.equal((await request("/api/activations/person", "web:operator", { channelId: "ding", subject: "v01", role: "viewer" })).status, 200);
  assert.equal((await request("/api/activations/person", "web:operator", { channelId: "ding", subject: "p03", role: "driver" })).status, 200);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(org.started.length, 1);
  const roster = new Principals();
  assert.deepEqual(["ding:v01", "ding:p03"].map(id => [roster.byId(id)?.role, roster.byId(id)?.homeAgentId]), [["viewer", undefined], ["driver", undefined]]);
  const people = (await request("/api/personal-boxes/panel", "web:operator")).data.inventory.people as Array<{ id: string; waitingForQuota?: boolean }>;
  assert.deepEqual(["ding:v01", "ding:p03"].map(id => people.find(person => person.id === id)?.waitingForQuota), [undefined, true]);
  assert.deepEqual((await request("/api/setup", "ding:p03")).data.autoBox, { state: "quota" }, "and her own page says so");
  const quota = (await request("/api/activations/progress?channelId=ding&state=quota", "web:operator")).data;
  assert.deepEqual([quota.counts.quota, quota.people.map((row: { subject: string }) => row.subject)], [1, ["p03"]], "the activations page counts and names who needs a raise; the viewer is not counted");
  // The ledger says who asked for a box on whose behalf.
  const acts = (await request("/api/activations/audit", "web:operator")).data.acts as Array<{ type: string; by?: string; people?: unknown }>;
  assert.deepEqual(acts.filter(act => act.type === "boxes").map(act => [act.by, act.people]), [["web:operator", ["ding:p01"]]]);
});

test("INV-2220: a department of thirty is confirmed against its estimate, is on the roster at once; their boxes start a few at a time, progress is counted, one that fails says why, stops nobody and is retried on request", async (t) => {
  let inFlight = 0, most = 0, open: () => void = () => {}, pulled = false;
  const gate = new Promise<void>(resolve => { open = resolve; });
  const org = await organisation(t, { withDoor: true, start: async name => {
    inFlight += 1; most = Math.max(most, inFlight);
    await gate; await new Promise(resolve => setTimeout(resolve, 5));
    inFlight -= 1;
    if (name.startsWith("P07") && !pulled) { pulled = true; throw new PersonalBoxStartError("pull failed", "ImagePullBackOff", "Check the image."); } // fixed before the retry
    return "http://127.0.0.1:1";
  } });
  const request = await org.boot();
  const press = { channelId: "ding", department: "10", includeSub: false, role: "driver" };
  // Before the press: what it asks of the cluster, from the allocator's own request per box.
  const estimate = (await request("/api/activations/estimate?channelId=ding&department=10&includeSub=false&role=driver", "web:operator")).data;
  assert.deepEqual(estimate, { people: 30, boxes: 30, outOfQuota: 0, memoryRequest: "2Gi", memoryBytes: 30 * 2 * 2 ** 30, alreadyActive: 0 });
  assert.equal((await request("/api/activations/estimate?channelId=ding&department=10&includeSub=false&role=viewer", "web:operator")).data.boxes, 0, "viewers get no box");
  // Not confirmed (the Admin cancelled, or confirmed another number): nothing happens at all.
  for (const unconfirmed of [press, { ...press, confirm: { boxes: 29 } }]) {
    const refused = await request("/api/activations/department", "web:operator", unconfirmed);
    assert.deepEqual([refused.status, refused.data.code, refused.data.estimate?.boxes], [409, "activation-confirm-needed", 30]);
  }
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual([org.started.length, new Principals().isKnown("ding:p01")], [0, false], "cancelling starts nothing and makes nobody");
  assert.deepEqual((await request("/api/activations/department", "web:operator", { ...press, confirm: { boxes: 30 } })).data, { activated: 30, alreadyActive: 0 });
  const acts = (await request("/api/activations/audit", "web:operator")).data.acts as Array<{ type: string; estimate?: unknown }>;
  assert.deepEqual(acts.filter(act => act.type === "activate-department").map(act => act.estimate), [{ people: 30, boxes: 30, outOfQuota: 0, memoryRequest: "2Gi", memoryBytes: 30 * 2 * 2 ** 30 }], "the press is audited with what it was confirmed against");
  const roster = new Principals();
  assert.equal(staff.filter(subject => roster.isKnown(`ding:${subject}`) && roster.roleOf(`ding:${subject}`) === "driver").length, 30, "thirty people, before one box is up");
  for (let i = 0; i < 200 && org.started.length < STARTING_AT_ONCE; i++) await new Promise(resolve => setTimeout(resolve, 10));
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(org.started.length, STARTING_AT_ONCE, "the rest wait their turn");
  const midway = (await request("/api/activations/progress?channelId=ding", "web:operator")).data;
  assert.deepEqual(midway.counts, { ready: 0, starting: STARTING_AT_ONCE, queued: 30 - STARTING_AT_ONCE, failed: 0, quota: 0 }, "counted, not listed");
  assert.equal(midway.people, undefined, "nobody's row until a state is opened");
  assert.deepEqual((await request("/api/setup", "ding:p30")).data.autoBox, { state: "preparing" }, "and somebody still in the queue is told theirs is being prepared — what the chat tells them too (INV-2221)");
  open();
  const boxes = await allSettled(request, 30);
  assert.ok(most <= STARTING_AT_ONCE, `at most ${STARTING_AT_ONCE} starting together, saw ${most}`);
  assert.equal(org.started.length, 30);
  const failed = boxes.filter(box => box.status !== "ready");
  assert.deepEqual(failed.map(box => [box.owner, box.status, box.stateReason]), [["ding:p07", "failed", "ImagePullBackOff"]], "the platform's reason, on the one that failed");
  assert.deepEqual((await request("/api/setup", "ding:p07")).data.autoBox, { state: "failed", reason: "ImagePullBackOff", id: failed[0]!.id });
  const done = (await request("/api/activations/progress?channelId=ding&state=failed", "web:operator")).data;
  assert.deepEqual(done.counts, { ready: 29, starting: 0, queued: 0, failed: 1, quota: 0 });
  assert.deepEqual(done.people.map((row: { subject: string; reason: string }) => [row.subject, row.reason]), [["p07", "ImagePullBackOff"]]);
  // Nobody holds a door here whose bot can write to them, so the 29 whose box came up are listed as not told, with why.
  const notTold = (await request("/api/activations/progress?channelId=ding&state=not-told", "web:operator")).data;
  assert.equal(notTold.notTold, 29);
  assert.match(notTold.people[0].told.why, /holds no identity on a channel whose bot can write to them/);
  assert.equal(new Principals().isKnown("ding:p07"), true, "and that person still exists and can sign in");
  // Nothing is tried again: not by a page load, not by a restart.
  await request("/api/me", "ding:p07");
  org.stopAll();
  const again = await org.boot();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(org.started.length, 30);
  assert.equal((await again("/api/personal-boxes/admin", "web:operator")).data.boxes.length, 30);
  // An Admin asks for the failed one again: started once more, through the same queue, and it comes up.
  assert.deepEqual((await again("/api/activations/retry-boxes", "web:operator", { channelId: "ding" })).data, { retried: 1 });
  for (let i = 0; i < 200 && (await again("/api/activations/progress?channelId=ding", "web:operator")).data.counts.ready < 30; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(org.started.length, 31);
  assert.deepEqual((await again("/api/activations/progress?channelId=ding", "web:operator")).data.counts, { ready: 30, starting: 0, queued: 0, failed: 0, quota: 0 });
  assert.equal((await again("/api/activations/retry-boxes", "web:operator", { channelId: "ding", subject: ["p07"] })).data.code, "activation-subject-invalid", "a malformed selector is refused, never read as everybody");
  // A driver is refused every one of these routes.
  for (const [path, body] of [["/api/activations/estimate?channelId=ding&department=10&role=driver", undefined], ["/api/activations/progress?channelId=ding", undefined],
    ["/api/activations/tell", { channelId: "ding" }], ["/api/activations/retry-boxes", { channelId: "ding" }]] as const) {
    assert.equal((await again(path, "ding:p01", body)).status, 403, path);
  }
});

test("INV-2220: with boxes at first use, activation makes the person and no box; their first page load makes the box and the agent", async (t) => {
  const org = await organisation(t, { withDoor: true, config: { personalBoxAt: "first-use" } });
  const request = await org.boot();
  assert.equal((await request("/api/activations/person", "web:operator", { channelId: "ding", subject: "p02", role: "driver" })).status, 200);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(new Principals().isKnown("ding:p02"), true);
  assert.equal(org.started.length, 0, "nothing is held for somebody who has not come");
  assert.equal((await request("/api/me", "ding:p02")).status, 200);
  const [box] = await allSettled(request, 1);
  assert.deepEqual([box!.owner, box!.status], ["ding:p02", "ready"]);
  for (let i = 0; i < 100 && new Principals().byId("ding:p02")?.homeAgentId === undefined; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(new AgentRegistry(join(org.home, "agents")).agentsIn(box!.id).map(agent => agent.id), [new Principals().byId("ding:p02")!.homeAgentId]);
});

test("INV-2220: somebody activated before the upgrade keeps a box at their first use, whatever the setting; somebody activated after it gets theirs at once", async (t) => {
  const org = await organisation(t, { withDoor: true, config: { personalBoxAt: "activation" } });
  // The home as 0.4.10 left it: P05 activated and never signed in. Then the upgrade's migration, then the server.
  new Activations(join(org.home, "activations.jsonl")).activatePerson(directorySource("ding", 1, "ding-app", "dingtalk"), { subject: "p05", name: "P05" }, "driver", "web:operator", true);
  enrolStandingActivations(org.home);
  assert.equal(new Principals().isKnown("ding:p05"), true, "the migration made her a person");
  let request = await org.boot();
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(org.started.length, 0, "an upgrade starts no box for somebody who has not come");
  // Somebody activated now gets theirs at once; she still has none, across a restart too.
  assert.equal((await request("/api/activations/person", "web:operator", { channelId: "ding", subject: "p06", role: "driver" })).status, 200);
  assert.deepEqual((await allSettled(request, 1)).map(box => box.owner), ["ding:p06"]);
  org.stopAll();
  request = await org.boot();
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(org.started.length, 1);
  // Her first page load is her first use.
  assert.equal((await request("/api/me", "ding:p05")).status, 200);
  assert.deepEqual((await allSettled(request, 2)).map(box => box.owner).sort(), ["ding:p05", "ding:p06"]);
  for (let i = 0; i < 100 && new Principals().byId("ding:p05")?.homeAgentId === undefined; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(new Principals().byId("ding:p05")?.homeAgentId, "with her agent in it");
  const told = (await request("/api/activations/audit", "web:operator")).data.acts.filter((act: { type: string }) => act.type === "told").map((act: { principalId: string }) => act.principalId);
  assert.deepEqual(told, ["ding:p06"], "the upgrade's person is not written to; only the one activated after it was (and not reached: no door here)");
});

test("INV-2221: a person chooses which agent answers their direct messages, among agents they may reach; a request that came from a chat is approved by activating them", async (t) => {
  const org = await organisation(t, { withDoor: true });
  // Somebody the directory lists wrote to the bot before this server started: the durable request, as the chat door writes it.
  const source = directorySource("ding", 1, "ding-app", "dingtalk");
  new Activations(join(org.home, "activations.jsonl")).request(source, { subject: "p05", name: "P05" });
  const request = await org.boot();
  for (const subject of ["p01", "p02"]) assert.equal((await request("/api/activations/person", "web:operator", { channelId: "ding", subject, role: "driver" })).status, 200);
  await allSettled(request, 2);
  const homeOf = async (id: string) => { for (let i = 0; i < 100 && new Principals().byId(id)?.homeAgentId === undefined; i++) await new Promise(resolve => setTimeout(resolve, 20)); return new Principals().byId(id)!.homeAgentId!; };
  const hers = await homeOf("ding:p01"), his = await homeOf("ding:p02");
  assert.equal((await request("/api/me", "ding:p01")).data.homeAgentId, hers, "the page is told which agent answers her");

  // Another of her own: made in her box, then chosen.
  const box = new AgentRegistry(join(org.home, "agents")).boxOf(hers).id;
  const second = (await request("/api/agents", "ding:p01", { name: "Scribe", boxId: box })).data.id as string;
  assert.deepEqual((await request("/api/me/home-agent", "ding:p01", { agentId: second })).data, { homeAgentId: second });
  assert.equal((await request("/api/me", "ding:p01")).data.homeAgentId, second);
  assert.equal(new Principals().byId("ding:p01")?.homeAgentId, second, "written on the roster");
  // Not an agent in a box she may not enter, and not one that does not exist: the same answer for both, and nothing changes.
  const theirs = await request("/api/me/home-agent", "ding:p01", { agentId: his }), nobody = await request("/api/me/home-agent", "ding:p01", { agentId: "no-such-agent" });
  assert.deepEqual([theirs.status, nobody.status], [404, 404]);
  assert.equal(String(theirs.data.error).replace(his, "no-such-agent"), nobody.data.error);
  assert.equal((await request("/api/me", "ding:p01")).data.homeAgentId, second);

  // Approving the request that came from a chat: the same person, box and agent an activation makes.
  assert.equal((await request("/api/channels/approve", "web:operator", { identity: "ding:p09" })).status, 404, "nobody who did not ask");
  assert.equal((await request("/api/channels/approve", "ding:p01", { identity: "ding:p05" })).status, 403, "and only an Admin");
  assert.equal((await request("/api/channels/approve", "web:operator", { identity: "ding:p05" })).status, 200);
  assert.equal(new Principals().byId("ding:p05")?.role, "driver");
  const rows = await allSettled(request, 3);
  assert.ok(rows.some(row => row.owner === "ding:p05" && row.status === "ready"), "his box was made");
  assert.notEqual(await homeOf("ding:p05"), undefined, "and his agent in it");
  assert.equal((await request("/api/channels/approve", "web:operator", { identity: "ding:p05" })).status, 404, "the request is spent");
});

/** The "assistant ready" notices the server handed its door's push, as the outbox wrote them down. */
function readyNotices(home: string): Array<{ chatKey: string; text: string }> {
  let lines: string[];
  try { lines = readFileSync(join(home, "outbox.jsonl"), "utf8").split("\n").filter(line => line !== ""); } catch { return []; }
  return lines.map(line => JSON.parse(line)).filter(event => event.event === "open" && event.receipt.purpose === "notice: assistant ready").map(event => ({ chatKey: event.receipt.chatKey, text: event.receipt.text }));
}

/** The DingTalk door up, as a door whose bot may write first: its push is refused by the test's network guard, after the outbox wrote the notice down. */
function doorUp(t: { after(fn: () => void): void }) {
  process.env.DING_CLIENT_ID = "ding-app"; process.env.DING_CLIENT_SECRET = "secret";
  t.after(() => { delete process.env.DING_CLIENT_ID; delete process.env.DING_CLIENT_SECRET; });
}

test("INV-2305: \"assistant ready\" carries the installation's address when it is set in settings, not the process environment", async (t) => {
  doorUp(t);
  assert.equal(process.env.AGENTBOX_PUBLIC_URL, undefined, "the address is only in settings here");
  const org = await organisation(t, { withDoor: true, config: { env: { DING_CLIENT_ID: "ding-app", DING_CLIENT_SECRET: "secret", AGENTBOX_PUBLIC_URL: "https://org.example.test" } } });
  const request = await org.boot();
  assert.equal((await request("/api/activations/person", "web:operator", { channelId: "ding", subject: "p01", role: "driver" })).status, 200);
  await allSettled(request, 1);
  for (let i = 0; i < 100 && readyNotices(org.home).length === 0; i++) await new Promise(resolve => setTimeout(resolve, 20));
  const notices = readyNotices(org.home);
  assert.equal(notices.length, 1, "her agent wrote to her once");
  assert.match(notices[0]!.text, /https:\/\/org\.example\.test/, "with the address the sign-in links on this installation carry");
});

test("INV-2304: somebody whose box came up while the server stopped before telling them is told at the next start, and the retry route tells too", async (t) => {
  let failed = false;
  const org = await organisation(t, { withDoor: true, start: async name => {
    if (name.startsWith("P02") && !failed) { failed = true; throw new PersonalBoxStartError("pull failed", "ImagePullBackOff", "Check the image."); }
    return "http://127.0.0.1:1";
  } });
  const request = await org.boot();
  for (const subject of ["p01", "p02"]) assert.equal((await request("/api/activations/person", "web:operator", { channelId: "ding", subject, role: "driver" })).status, 200);
  await allSettled(request, 2);
  for (let i = 0; i < 100 && new Principals().byId("ding:p01")?.homeAgentId === undefined; i++) await new Promise(resolve => setTimeout(resolve, 20));
  await new Promise(resolve => setTimeout(resolve, 100));
  org.stopAll();
  // The server stopped between her box coming up and the telling: no line says she was told, or why not.
  const ledger = join(org.home, "activations.jsonl");
  writeFileSync(ledger, readFileSync(ledger, "utf8").split("\n").filter(line => !line.includes('"type":"told"')).join("\n"));
  doorUp(t);
  const again = await org.boot();
  for (let i = 0; i < 100 && readyNotices(org.home).length === 0; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(readyNotices(org.home).map(notice => notice.chatKey), ["ding:@p01"], "her agent writes to her once, at the start; the person whose box failed is owed nothing yet");
  // His box failed at activation; he starts it again himself, and when it is up his agent tells him.
  const [box] = (await again("/api/personal-boxes", "ding:p02")).data.boxes as Array<{ id: string; status: string }>;
  assert.equal(box!.status, "failed");
  assert.equal((await again("/api/personal-boxes/retry", "ding:p02", { id: box!.id })).status, 200);
  for (let i = 0; i < 100 && readyNotices(org.home).length < 2; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(readyNotices(org.home).map(notice => notice.chatKey), ["ding:@p01", "ding:@p02"]);
});
