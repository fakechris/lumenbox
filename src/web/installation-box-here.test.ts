import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { startWebServer } from "./server.ts";
import { NEXT_PAGE } from "./page-locale.ts";
import { Principals } from "../host/principals.ts";
import { AgentRegistry } from "../agents/registry.ts";
import { STARTER_TEAM, seedStarterTeam } from "../host/orchestrator.ts";
import { boxBackendFromEnvironment } from "../config.ts";
import { KubeBoxes } from "../control/kube-box.ts";
import { KubernetesBoxDriver } from "../box/kubernetes-box.ts";
import { staticDecision } from "../control/policy.ts";
import { fakeKubeApi } from "../control/testing/fake-kube.ts";
import { ChatRoute } from "../host/chat-route.ts";
import { runnableAgents, startsWithStarterTeam } from "./installation-box-here.ts";
import { coordinatorOf } from "./mcp-goal-tools.ts";

// Identity arrives the way the hosted gateway sends it, as for a person signed in through the door (INV-1543).
process.env.AGENTBOX_TRUST_GATEWAY_IDENTITY = "1";

const STARTERS = STARTER_TEAM.map(profile => profile.name);

/** A temporary home with these variables set, put back afterwards. */
function home(t: { after(fn: () => void): void }, env: Record<string, string | undefined>): string {
  const dir = mkdtempSync(join(tmpdir(), "installation-box-here-"));
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
  const stop = await startWebServer({ port: 0, host: "127.0.0.1", token: "here-test", useBox: false, onLog: () => {}, onReady: url => { base = url; }, ...options });
  t.after(() => stop());
  return async (path, identity, body) => {
    const response = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: "Bearer here-test", "content-type": "application/json", "accept-language": "en",
        ...(identity ? { "x-agentbox-user": identity, "x-agentbox-role": identity === "ding:boss" ? "owner" : "member" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };
}

/** A fresh organisation server on Kubernetes (deploy/kubernetes/organisation.yaml), on the fake cluster, as `/bootstrap` leaves it: one Admin. */
async function organisation(t: { after(fn: () => void): void }, before: (dir: string) => void = () => {}) {
  const dir = home(t, { AGENTBOX_BOX_BACKEND: "kubernetes", AGENTBOX_K8S_NAMESPACE: "org-test" });
  new Principals().save([
    { id: "ding:boss", name: "Boss", role: "admin", identities: ["ding:boss"] },
    { id: "ding:alice", name: "Alice", role: "driver", identities: ["ding:alice"] },
  ]);
  before(dir);
  // What `agentbox web` does before it starts the server.
  const seeded = seedStarterTeam(new AgentRegistry(join(dir, "agents")), startsWithStarterTeam(boxBackendFromEnvironment()));
  const fake = fakeKubeApi(), image = "lumenbox:test-version";
  const kube = new KubeBoxes({ api: fake.api, namespace: "org-test", defaultImage: () => image, pollIntervalMs: 1, startTimeoutMs: 50 });
  const request = await boot(t, { personalBoxDriver: new KubernetesBoxDriver({ boxes: kube, image, decision: staticDecision({}) }) });
  return { dir, seeded, fake, request };
}

/** Waits for a person's first page load to have made their box and their agent. */
async function arrived(request: Request, identity: string) {
  await request("/api/me", identity);
  for (let i = 0; i < 200; i++) {
    const state = (await request("/api/state", identity)).data;
    if (state.agents.length > 0 && state.boxes.length > 0) return state;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`${identity}'s box and agent were never made`);
}

/** One function of the rebuilt page, run with the globals given. */
function pageFunction(name: string, globals: Record<string, unknown>): (...args: unknown[]) => unknown {
  const script = [...NEXT_PAGE("en").matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]!).sort((a, b) => b.length - a.length)[0]!;
  const start = script.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `the page has ${name}`);
  let depth = 0, end = start;
  for (let i = script.indexOf("{", start); i < script.length; i++) {
    if (script[i] === "{") depth++;
    if (script[i] === "}" && --depth === 0) { end = i + 1; break; }
  }
  return vm.runInNewContext(`(${script.slice(start, end)})`, globals) as (...args: unknown[]) => unknown;
}

interface Fake { text: string; kids: Fake[]; hidden?: boolean; title?: string; appendChild(kid: Fake): void; addEventListener(): void; setAttribute(): void; replaceChildren(): void; replaceWith(): void }
const el = (_tag: string, _cls = "", text = ""): Fake => {
  const node: Fake = { text: String(text), kids: [], appendChild(kid) { node.kids.push(kid); }, addEventListener() {}, setAttribute() {}, replaceChildren() { node.kids = []; }, replaceWith() {} };
  return node;
};
const texts = (node: Fake | null): string[] => node === null ? [] : [node.text, ...node.kids.flatMap(texts)].filter(Boolean);

/** The first screen as this person sees it: the sidebar's box heading and agents, and the getting-started card. */
function firstScreen(state: any, computers: any, setup: any, admin: boolean) {
  const nodes: Record<string, Fake> = {}, $ = (id: string) => (nodes[id] ??= el("div"));
  const boxes = { list: computers.boxes, own: computers.own }, next = { agents: Object.fromEntries(state.agents.map((agent: any) => [agent.id, agent])), view: "chat", mine: [] };
  const chat = { box: "", agentId: "" }, t = (key: string) => key;
  const boxesKnown = pageFunction("boxesKnown", { boxes, next });
  const agentsHere = pageFunction("agentsHere", { next, chat });
  pageFunction("renderSide", { $, el, t, chat, next, boxesKnown, agentsHere, inTeam: (list: unknown) => list, teams: {}, renderTeams() {}, settings: {}, member: { paused: {} },
    lineNode: () => el("span"), memberLine: () => "", initial: String, agentOwes: () => false, openChat() {}, boxNotice() {}, render() {} })();
  const card = pageFunction("setupCard", { settings: { setup, me: { identity: admin ? "ding:boss" : "ding:alice" } }, chat, agentsHere, canOperateInstallation: () => admin, canDriveAgents: () => true,
    localStorage: { getItem: () => null, setItem() {} }, t, el, openSettingsPane() {}, openMember() {}, navigateView() {}, createSetupBox() {}, render() {} })() as Fake | null;
  return { heading: nodes.boxes!, agents: texts(nodes.agents!), card: texts(card) };
}

test("INV-2310: a Kubernetes organisation's first Admin gets their own box and agent, and never meets the box that cannot run", async (t) => {
  const org = await organisation(t);
  assert.deepEqual(org.seeded, [], "no starter team on an organisation whose sandboxes run on Kubernetes");
  const state = await arrived(org.request, "ding:boss");
  const own = state.box.own;
  assert.equal(state.boxes.length, 1);
  assert.notEqual(state.boxes[0].id, own);
  assert.deepEqual(state.agents.map((agent: any) => agent.boxId), [state.boxes[0].id], "the Admin's one agent, in the Admin's own box");
  assert.ok(!STARTERS.slice(1).some(name => state.agents.some((agent: any) => agent.name === name)), "no four-agent team");
  const computers = (await org.request("/api/boxes?lang=en", "ding:boss")).data;
  assert.deepEqual(computers.boxes.map((box: any) => [box.id, box.personal]), [[state.boxes[0].id, true]]);
  const shelf = (await org.request("/api/templates/shelf", "ding:boss")).data;
  assert.ok(!shelf.boxes.some((box: any) => box.id === own), "the box picker does not offer it");
  const setup = (await org.request("/api/setup", "ding:boss")).data;
  assert.equal(setup.hasPersonalBox, true);
  assert.equal(setup.byBox[own], undefined);
  assert.equal((await org.request("/api/boxes/stranded", "ding:boss")).data.agents.length, 0);

  const screen = firstScreen(state, computers, setup, true);
  assert.equal(screen.heading.hidden, false, "their one box is their heading");
  assert.deepEqual(texts(screen.heading), [computers.boxes[0].name]);
  assert.ok(screen.agents.includes(state.agents[0].name), "and their agent under it");
  assert.ok(!screen.card.includes("ui.next.setup.box"), "no step to give the agents the installation's computer");
  assert.ok(screen.card.includes("ui.next.setup.key"), "the Admin's own steps stay");
  const words = JSON.stringify([state, computers, setup, screen]);
  assert.doesNotMatch(words, /Kubernetes backend|shared-box-kubernetes|Shared box/, "no refusal about it anywhere");

  // A member is the same: their own box and agent, and nobody else's.
  const alice = await arrived(org.request, "ding:alice");
  assert.equal(alice.boxes.length, 1);
  assert.notEqual(alice.boxes[0].id, state.boxes[0].id);
  assert.deepEqual(alice.agents.map((agent: any) => agent.boxId), [alice.boxes[0].id]);
  const aliceSetup = (await org.request("/api/setup", "ding:alice")).data;
  const aliceScreen = firstScreen(alice, (await org.request("/api/boxes?lang=en", "ding:alice")).data, aliceSetup, false);
  assert.equal(aliceScreen.heading.hidden, false);
  assert.ok(!aliceScreen.card.includes("ui.next.setup.box"));
});

test("INV-2310: an installation 0.4.10–0.4.12 opened keeps its starter team's records, shows them nowhere, and an Admin may delete them", async (t) => {
  // The team those versions made in the installation's own box at the first page load.
  const org = await organisation(t, dir => { seedStarterTeam(new AgentRegistry(join(dir, "agents")), true); });
  const registry = new AgentRegistry(join(org.dir, "agents"));
  assert.deepEqual(registry.list().map(agent => agent.profile.name).sort(), [...STARTERS].sort(), "kept across the upgrade");
  const state = await arrived(org.request, "ding:boss");
  assert.deepEqual(state.agents.map((agent: any) => agent.boxId), [state.boxes[0].id], "the sidebar has the Admin's own agent only");
  assert.ok(!state.boxes.some((box: any) => box.id === state.box.own));

  assert.equal((await org.request("/api/boxes/stranded", "ding:alice")).status, 403, "the Admins' to decide");
  const stranded = (await org.request("/api/boxes/stranded", "ding:boss")).data.agents;
  assert.deepEqual(stranded.map((agent: any) => agent.name).sort(), [...STARTERS].sort());
  const block = pageFunction("strandedBlock", { boxSet: { stranded }, el, t: (key: string, vars?: { names: string }) => vars ? `${key}: ${vars.names}` : key })() as Fake;
  assert.deepEqual(texts(block), ["ui.personal.strandedTitle", `ui.personal.stranded: ${stranded.map((agent: any) => agent.name).join(", ")}`, "ui.personal.strandedDelete"]);

  // A direct message, or a side-door call, that names nobody never reaches them.
  const principals = new Principals(), now = new AgentRegistry(join(org.dir, "agents"));
  const route = new ChatRoute({ registry: runnableAgents(now, () => state.box.own), principals, log: () => {}, preparing: () => false, firstAgent: () => undefined,
    door: () => ({ defaultAgent: "Ada", type: "dingtalk" }) });
  const unnamed = route.unnamed("ding", { identity: "ding:alice", privateChat: true });
  assert.ok("none" in unnamed, "Ada in the box that cannot run is no door default");
  assert.equal(route.coordinatorFor("ding:alice"), undefined);
  assert.throws(() => coordinatorOf({ registry, orchestrator: { ensureDefaultAgent: () => undefined } as never, coordinator: id => route.coordinatorFor(id) }, "ding:alice"), /No agent is available to you here/);
  assert.equal(now.boxOf(route.coordinatorFor("ding:boss")!.id).id, state.boxes[0].id, "the Admin's call reaches their own agent");

  const deleted = await org.request("/api/boxes/stranded/delete", "ding:boss", { agentIds: stranded.map((agent: any) => agent.id) });
  assert.equal(deleted.status, 200);
  assert.deepEqual(new AgentRegistry(join(org.dir, "agents")).list().map(agent => agent.id), [state.agents[0].id]);
  const archive = join(org.dir, "archive", "agents");
  assert.ok(existsSync(archive) && readdirSync(archive).length === STARTERS.length, "their records are archived, not erased");
  assert.equal((await org.request("/api/boxes/stranded", "ding:boss")).data.agents.length, 0);
});

test("INV-2310: the desktop is unchanged — its own box, the starter team, the box step, no heading for one box", async (t) => {
  const dir = home(t, {});
  writeFileSync(join(dir, "principals.json"), JSON.stringify({ principals: [{ id: "local:owner", name: "Owner", role: "admin", identities: [] }], installation: { mode: "single-machine", ownerId: "local:owner" } }));
  const seeded = seedStarterTeam(new AgentRegistry(join(dir, "agents")), startsWithStarterTeam(boxBackendFromEnvironment()));
  assert.deepEqual(seeded.map(agent => agent.profile.name), STARTERS);
  const dial = async () => { throw new Error("no Docker in the suite"); };
  const request = await boot(t, { boxProvisioner: { kind: "docker", boxName: "agentbox-box", label: "Docker", connect: dial, endpoint: dial } });
  const state = (await request("/api/state")).data, computers = (await request("/api/boxes?lang=en")).data, setup = (await request("/api/setup")).data;
  assert.deepEqual(state.boxes.map((box: any) => box.id), [state.box.own]);
  assert.deepEqual(state.agents.map((agent: any) => agent.name).sort(), [...STARTERS].sort());
  assert.equal(setup.hasPersonalBox, undefined);
  assert.ok(setup.byBox[state.box.own]);
  assert.equal((await request("/api/boxes/stranded")).data.agents.length, 0);
  const screen = firstScreen(state, computers, setup, true);
  assert.equal(screen.heading.hidden, true, "one box and nobody else's: no switch, as before");
  assert.ok(screen.card.includes("ui.next.setup.box"), "the step that starts this computer's box stays");
  const route = new ChatRoute({ registry: runnableAgents(new AgentRegistry(join(dir, "agents")), () => undefined), principals: new Principals(), log: () => {}, preparing: () => false,
    firstAgent: () => undefined, door: () => undefined });
  assert.equal(route.coordinatorFor("local:owner")?.profile.name, STARTERS[0], "a side-door call naming nobody reaches the first agent, as before");
});
