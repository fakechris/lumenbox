import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWebServer } from "./server.ts";
import { Principals } from "../host/principals.ts";
import { PersonalBoxStartError, type PersonalBoxDriver } from "../host/personal-boxes.ts";

// These requests carry identity the way the hosted gateway sends it (INV-1543).
process.env.AGENTBOX_TRUST_GATEWAY_IDENTITY = "1";

const roster = [
  { id: "alice", name: "Alice", role: "driver" as const, identities: ["web:alice"] },
  { id: "carol", name: "Carol", role: "viewer" as const, identities: ["web:carol"] },
  { id: "operator", name: "Operator", role: "admin" as const, identities: ["web:operator"] },
];

/** An organisation server on a temporary home, with a fake box backend that counts what it was asked to start. */
async function organisation(t: { after(fn: () => void): void }, options: { config?: Record<string, unknown>; start?: () => Promise<string> } = {}) {
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
  if (options.config) writeFileSync(join(home, "config.json"), JSON.stringify(options.config));
  const started: string[] = [];
  const driver: PersonalBoxDriver = {
    start: async record => { started.push(record.displayName ?? record.name); return (options.start ?? (async () => "http://127.0.0.1:1"))(); },
    remove: async () => {},
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
  assert.deepEqual(org.started, ["Alice’s computer"], "one box, named as the create dialog suggests");
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

  const removed = await request("/api/personal-boxes/remove", "web:alice", { id: mine.boxes[0].id, deleteData: true });
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
  assert.deepEqual(setup.data.autoBox, { state: "failed", reason: "ImagePullBackOff" });
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
