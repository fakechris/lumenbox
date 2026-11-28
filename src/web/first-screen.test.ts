/**
 * The first screen in both editions (INV-2311, docs/112 §3, §4), on the real server: the sidebar's
 * sandbox headings and the getting-started list for the desktop Owner, an organisation's Admin, a
 * member, and a member whose sandbox is being prepared or failed. Every button of the list is
 * pressed, and where it leads is asked of the server as that person: none of them is a refusal.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWebServer } from "./server.ts";
import { type Destination, drawFirstScreen, type Fake, fakeEl, pageFunctions, texts } from "./testing/first-screen-page.ts";
import { Principals } from "../host/principals.ts";
import { AgentRegistry } from "../agents/registry.ts";
import { STARTER_TEAM, seedStarterTeam } from "../host/orchestrator.ts";
import { boxBackendFromEnvironment } from "../config.ts";
import { KubeBoxes } from "../control/kube-box.ts";
import { KubernetesBoxDriver } from "../box/kubernetes-box.ts";
import { staticDecision } from "../control/policy.ts";
import { fakeKubeApi } from "../control/testing/fake-kube.ts";
import { startsWithStarterTeam } from "./installation-box-here.ts";
import { SETTINGS_PANES } from "./settings-registry.ts";
import { firstScreen } from "./first-screen.ts";
import { tr } from "../i18n/messages.ts";

process.env.AGENTBOX_TRUST_GATEWAY_IDENTITY = "1";

function home(t: { after(fn: () => void): void }, env: Record<string, string | undefined>): string {
  const dir = mkdtempSync(join(tmpdir(), "first-screen-"));
  const all = { AGENTBOX_HOME: dir, AGENTBOX_BOX_BACKEND: undefined, AGENTBOX_K8S_NAMESPACE: undefined, ...env };
  const previous = Object.fromEntries(Object.keys(all).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(all)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

type Request = (path: string, identity?: string, body?: unknown) => Promise<{ status: number; data: any }>;

async function boot(t: { after(fn: () => void): void }, options: Partial<Parameters<typeof startWebServer>[0]>): Promise<Request> {
  let base = "";
  const stop = await startWebServer({ port: 0, host: "127.0.0.1", token: "first-test", useBox: false, onLog: () => {}, onReady: url => { base = url; }, ...options });
  t.after(() => stop());
  return async (path, identity, body) => {
    const response = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: "Bearer first-test", "content-type": "application/json", "accept-language": "en",
        ...(identity ? { "x-agentbox-user": identity, "x-agentbox-role": identity === "ding:boss" ? "owner" : "member" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json().catch(() => ({})) };
  };
}

/** A fresh organisation on the fake cluster with one Admin and one member (deploy/kubernetes/organisation.yaml). */
async function organisation(t: { after(fn: () => void): void }, kube: Parameters<typeof fakeKubeApi>[0] = {}) {
  const dir = home(t, { AGENTBOX_BOX_BACKEND: "kubernetes", AGENTBOX_K8S_NAMESPACE: "org-test" });
  new Principals().save([
    { id: "ding:boss", name: "Boss", role: "admin", identities: ["ding:boss"] },
    { id: "ding:alice", name: "Alice", role: "driver", identities: ["ding:alice"] },
  ]);
  seedStarterTeam(new AgentRegistry(join(dir, "agents")), startsWithStarterTeam(boxBackendFromEnvironment()));
  const image = "lumenbox:test-version";
  const boxes = new KubeBoxes({ api: fakeKubeApi(kube).api, namespace: "org-test", defaultImage: () => image, pollIntervalMs: 1, startTimeoutMs: 50 });
  return boot(t, { personalBoxDriver: new KubernetesBoxDriver({ boxes, image, decision: staticDecision({}) }) });
}

/** Until the person's first page load has made their sandbox, or given up on it. */
async function settled(request: Request, identity: string) {
  await request("/api/me", identity);
  for (let i = 0; i < 200; i++) {
    const [state, setup] = [(await request("/api/state", identity)).data, (await request("/api/setup", identity)).data];
    if ((state.agents.length > 0 && state.boxes.length > 0) || setup.autoBox?.state === "failed") return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`${identity}'s sandbox never settled`);
}

/** What this person's first screen shows, drawn by the page's own functions from what the server said. */
async function firstScreenOf(request: Request, identity: string | undefined) {
  const me = (await request("/api/me", identity)).data, state = (await request("/api/state", identity)).data;
  const computers = (await request("/api/boxes?lang=en", identity)).data, setup = (await request("/api/setup", identity)).data;
  return { me, state, setup, ...drawFirstScreen({ me, state, computers, setup, t: (key, vars) => tr(key, "en", vars) }) };
}

/** Where a press led is not a page that refuses this person: a pane they have and whose first read answers them, a conversation they may read, an act they may do. */
async function assertNoRefusal(request: Request, identity: string | undefined, screen: Awaited<ReturnType<typeof firstScreenOf>>, to: Destination) {
  const said = JSON.stringify(to);
  if (to.pane) {
    assert.ok(screen.panes.includes(String(to.pane)), `${said}: the person has this pane`);
    const api = SETTINGS_PANES.find(pane => pane.key === to.pane)!.apis[0]!;
    assert.notEqual((await request(api, identity)).status, 403, `${said}: ${api} answers them`);
  } else if (to.chat) {
    const read = await request(`/api/transcript?sent=1&requests=1&agent=${encodeURIComponent(String(to.chat))}&conversation=main`, identity);
    assert.equal(read.status, 200, `${said}: they may read the conversation`);
  } else if (to.start) {
    // The two refusals POST /api/box/up has (server.ts, SharedBoxStart). It is not pressed: it would start Docker on this machine.
    assert.equal(screen.me.role, "admin", `${said}: an Admin's act`);
    assert.notEqual(screen.state.box.backend, "kubernetes", `${said}: a box this installation starts`);
  } else if (to.retry) {
    const retried = await request("/api/personal-boxes/retry", identity, { id: to.retry });
    assert.ok(retried.status !== 403 && retried.status !== 404, `${said}: their own sandbox, started again (${retried.status})`);
  } else if (to.url) {
    assert.match(String(to.url), /^https:\/\//, said);
  } else assert.fail(`${said}: no such destination on the list`);
}

const INTERNAL = /Kubernetes|backend|\bpod\b|\bnode\b|\bBox\b|container|\bimage\b/;

test("INV-2311: the desktop Owner — Your sandbox heading over the starter team; model, start it, talk to Ada, a channel; no button refuses", async (t) => {
  const dir = home(t, {});
  writeFileSync(join(dir, "principals.json"), JSON.stringify({ principals: [{ id: "local:owner", name: "Owner", role: "admin", identities: [] }], installation: { mode: "single-machine", ownerId: "local:owner" } }));
  seedStarterTeam(new AgentRegistry(join(dir, "agents")), startsWithStarterTeam(boxBackendFromEnvironment()));
  const dial = async () => { throw new Error("no Docker in the suite"); };
  const request = await boot(t, { boxProvisioner: { kind: "docker", boxName: "agentbox-box", label: "Docker", connect: dial, endpoint: dial } });
  const screen = await firstScreenOf(request, undefined);
  assert.equal(screen.setup.edition, "personal");
  assert.equal(screen.headings.length, 1, "one sandbox, one heading — the desktop's is the Owner's own");
  assert.match(screen.headings[0]!, /^Your sandbox · (Stopped|Failed)$/);
  assert.deepEqual([...screen.agents].sort(), STARTER_TEAM.map(profile => profile.name).sort(), "the agents in it, under it");
  assert.ok(!screen.panes.includes("organisation"), "no Settings → Organisation on the desktop");
  const steps = screen.steps.join("\n");
  // The suite has no credential, so no model is set; a run with one has nothing to choose (the logic test below holds both).
  if (screen.setup.key === false) assert.match(steps, /Model \| Choose a model/); else assert.doesNotMatch(steps, /Model/);
  assert.match(steps, /Your sandbox · (Stopped \| Start it|Failed · .+ \| (Try again|Get Docker Desktop))/);
  assert.match(steps, /Your agent \| Talk to Ada/);
  assert.match(steps, /Chat channel \(optional\) \| Connect DingTalk or Feishu/);
  const walked = screen.walk();
  assert.equal(walked.length, screen.steps.length, "every step has its one button");
  for (const to of walked) await assertNoRefusal(request, undefined, screen, to);
});

test("INV-2311: an organisation's Admin and member — each their own sandbox; the member's list has no button for the model; no button refuses", async (t) => {
  const request = await organisation(t);
  for (const identity of ["ding:boss", "ding:alice"]) await settled(request, identity);
  const admin = await firstScreenOf(request, "ding:boss"), member = await firstScreenOf(request, "ding:alice");
  for (const screen of [admin, member]) {
    assert.equal(screen.setup.edition, "organisation");
    assert.equal(screen.headings.length, 1, "their own sandbox only: not the installation's, not the other person's");
    assert.match(screen.headings[0]!, /^Your sandbox · (Ready|Failed)$/);
    assert.equal(screen.agents.length, 1, "their one agent under it");
    assert.doesNotMatch(screen.words, /Shared box|Kubernetes backend/);
  }
  assert.equal(admin.panes[0], "organisation", "Settings → Organisation leads the Admin's list");
  assert.ok(!member.panes.includes("organisation"));
  if (admin.setup.key === false) {
    assert.match(admin.steps.join("\n"), /Model \| Choose a model/);
    assert.match(member.steps.join("\n"), /Your Admin has not chosen a model yet\./);
  }
  assert.equal(member.setup.key, admin.setup.key, "a member is told whether a model is set, as the Admin is");
  assert.ok(!member.steps.some(step => /Model/.test(step) && step.split(" | ").length > 2), "a sentence, no button");
  assert.ok(!member.steps.some(step => /Chat channel/.test(step)), "the channel is the Admin's");
  assert.match(admin.steps.join("\n"), /Chat channel/);
  for (const screen of [admin, member]) assert.match(screen.steps.join("\n"), new RegExp(`Your agent \\| Talk to ${screen.agents[0]}`));
  assert.doesNotMatch(member.words, INTERNAL, "a member reads no internal word");
  for (const [identity, screen] of [["ding:boss", admin], ["ding:alice", member]] as const) for (const to of screen.walk()) await assertNoRefusal(request, identity, screen, to);
});

test("INV-2311: a member whose sandbox failed is told why in plain words, and Try again starts it again; while it is prepared nothing is pressed", async (t) => {
  const request = await organisation(t, { podFate: "failed" });
  await settled(request, "ding:alice");
  const failed = await firstScreenOf(request, "ding:alice");
  assert.equal(failed.setup.autoBox.state, "failed");
  assert.deepEqual(failed.headings, ["Your sandbox · Failed"]);
  assert.equal(failed.why.length, 1);
  assert.match(failed.why[0]!, /\| Try again$/, "the reason, and one button that works");
  assert.match(failed.steps.join("\n"), /Your sandbox · Failed · .+ \| Try again/);
  assert.doesNotMatch(failed.words, INTERNAL);
  const walked = failed.walk();
  assert.deepEqual(walked.filter(to => to.retry), [{ retry: failed.setup.autoBox.id }]);
  for (const to of walked) await assertNoRefusal(request, "ding:alice", failed, to);

  // Being prepared: the same person a moment earlier.
  const preparing = firstScreen.sandboxesOf([], { edition: "organisation", admin: false, own: "default", starting: false, failed: "", docker: "", auto: { state: "preparing" } });
  assert.deepEqual(preparing.map(box => [box.yours, box.state, box.act]), [[true, "preparing", undefined]]);
  const steps = firstScreen.gettingStartedOf({ admin: false, key: true, door: false, yours: preparing[0], quota: false, canCreate: false, readyOnce: false, agent: undefined, opened: false });
  assert.deepEqual(steps.map(step => [step.key, step.state, step.act]), [["sandbox", "preparing", undefined]], "progress, no button, and no agent step before there is an agent");
});

test("INV-2311: state words are four, a failed sandbox always has its reason and a button, and a stopped one with nothing to press here is not a step", () => {
  const facts = { edition: "personal", admin: true, own: "default", starting: false, failed: "", docker: "" };
  const of = (row: object, more: object = {}) => firstScreen.sandboxesOf([{ id: "default", name: "Default", ...row }], { ...facts, ...more })[0]!;
  assert.deepEqual([of({ connected: true }).state, of({}, { starting: true }).state, of({}).state, of({}, { failed: "exit 1" }).state], ["ready", "preparing", "stopped", "failed"]);
  const theirs = firstScreen.sandboxesOf([{ id: "p1", name: "Alice's", personal: true }, { id: "vm", name: "Grok Bot" }], { ...facts, edition: "organisation", admin: false });
  assert.deepEqual(theirs.map(box => [box.name, box.state, box.reason, box.act]), [["Alice's", "failed", "noAnswer", undefined], ["Grok Bot", "stopped", undefined, undefined]]);
  for (const raw of ["ImagePullBackOff", "0/3 nodes: Insufficient memory", "connect ECONNREFUSED", "exit 137"]) assert.ok(tr(`ui.first.why.${firstScreen.sandboxReasonOf(raw)}`, "en") !== `ui.first.why.${firstScreen.sandboxReasonOf(raw)}`, raw);
  const member = { admin: false, key: true, door: false, quota: false, canCreate: false, readyOnce: false, agent: undefined, opened: false };
  const model = (admin: boolean) => firstScreen.gettingStartedOf({ ...member, admin, key: false, yours: undefined, door: true }).map(step => [step.words, step.act?.to]);
  assert.deepEqual([model(true), model(false)], [[["ui.first.step.model", { pane: "model" }]], [["ui.first.model.member", undefined]]], "an Admin opens Settings → Model; a member is told, with nothing to press");
  assert.deepEqual(firstScreen.gettingStartedOf({ ...member, yours: { id: "default", name: "", yours: true, state: "stopped" } }), [], "a member's stopped sandbox they cannot start is the sidebar's to say");
  assert.deepEqual(firstScreen.gettingStartedOf({ ...member, yours: undefined, quota: true }).map(step => [step.words, step.act]), [["ui.first.sandbox.quota", undefined]]);
  for (const state of ["preparing", "ready", "stopped", "failed"]) for (const locale of ["en", "zh"] as const) assert.notEqual(tr(`ui.first.state.${state}`, locale), `ui.first.state.${state}`);
});

test("INV-2311: Settings → Organisation is the Admin's on an organisation: the channel app, the public address and activating members, each with its state, moved and not copied", () => {
  const opened: string[] = [], moved = { publicUrl: 0, directory: 0 };
  const doors = { data: { records: [{ id: "ding", type: "dingtalk", name: "Acme", credentialsSet: true }], channels: [{ name: "ding", running: true }], publicUrl: "" } as Record<string, unknown>, error: "", note: "" };
  const globals: Record<string, unknown> = {
    el: fakeEl, t: (key: string) => key, doors, directory: { data: { doors: [] } }, openSettingsPane: (pane: string) => opened.push(pane), loadDoors() {}, selectOf: () => fakeEl("select"),
    publicUrlBlock: () => { moved.publicUrl++; return fakeEl("div", "fact", "publicUrlBlock"); }, directoryBlock: () => { moved.directory++; return null; },
    settings: { setup: { edition: "organisation" }, me: { role: "admin" } }, SETTING_PANES: ["model", "boxes", "doors"], shellPanes: () => [],
  };
  const page = pageFunctions(["isOrganisation", "canOperateInstallation", "canDriveAgents", "settingsPanes", "organisationApps", "organisationHead", "organisationAppBlock",
    "organisationAddressBlock", "organisationActivateBlock", "renderOrganisationPane", "channelsBlock"], globals);
  assert.deepEqual([...page.settingsPanes!()], ["organisation", "model", "boxes", "doors"]);
  const view = fakeEl("div");
  page.renderOrganisationPane!(view);
  assert.deepEqual(view.kids.map(section => texts(section.kids[0]).join("")), ["ui.org.channelApp · ui.org.state.connected", "ui.org.publicAddress · ui.org.state.notSet", "ui.org.activate · ui.org.state.needsApp"]);
  assert.deepEqual(moved, { publicUrl: 1, directory: 1 }, "the public address and activation are the very blocks Channels and Team had");
  for (const kid of view.kids.flatMap(section => section.kids)) kid.press?.();
  assert.deepEqual(opened, ["doors", "doors"], "the channel app is edited where every channel is");

  // Channels no longer holds the public address on an organisation: it says where it went.
  const channels = page.channelsBlock!() as Fake;
  assert.equal(moved.publicUrl, 1);
  assert.ok(texts(channels).includes("ui.org.movedHere"));
  (globals.settings as { setup: { edition: string } }).setup.edition = "personal";
  assert.ok(!page.settingsPanes!().includes("organisation"), "and the desktop has no such pane");
  assert.ok(texts(page.channelsBlock!() as Fake).includes("publicUrlBlock"), "its Channels keeps the public address");
});
