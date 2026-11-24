import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { startWebServer } from "./server.ts";
import { APP_PAGE } from "./page-locale.ts";
import { NEXT_BOXES_JS } from "./next-boxes-ui.ts";
import { UsageLog } from "../host/usage.ts";
import { Principals } from "../host/principals.ts";
import { AgentRegistry } from "../agents/registry.ts";
import { KubernetesBoxDriver } from "../box/kubernetes-box.ts";
import { KubeBoxes } from "../control/kube-box.ts";
import { staticDecision } from "../control/policy.ts";
import { fakeKubeApi } from "../control/testing/fake-kube.ts";

// These requests carry identity the way the hosted gateway sends it, so this file runs as a box behind one (INV-1543).
process.env.AGENTBOX_TRUST_GATEWAY_IDENTITY = "1";

test("INV-2040/2041/2049: Kubernetes uses cluster status, never the shared Docker provisioner", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "kube-personal-http-"));
  t.mock.method(console, "error", () => {});
  const env = { AGENTBOX_HOME: home, AGENTBOX_BOX_BACKEND: "kubernetes", AGENTBOX_K8S_NAMESPACE: "org-test" };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  let stop: (() => void) | undefined;
  t.after(() => {
    stop?.();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  });
  new Principals().save([
    { id: "alice", name: "Alice", role: "driver", identities: ["web:alice"] },
    { id: "bob", name: "Bob", role: "driver", identities: ["web:bob"] },
    { id: "operator", name: "Operator", role: "admin", identities: ["web:operator"] },
  ]);
  const logs: string[] = [];
  let base = "", sharedDials = 0;
  const dial = async () => { sharedDials++; throw new Error("unexpected Docker lookup"); };
  stop = await startWebServer({
    port: 0, host: "127.0.0.1", token: "personal-test",
    onReady: url => { base = url; }, onLog: line => logs.push(line),
    boxProvisioner: { kind: "docker", boxName: "agentbox-box", label: "Docker", connect: dial, endpoint: dial },
    personalBoxDriver: {
      start: async () => "http://127.0.0.1:1", remove: async () => {}, podStatus: async () => "Running",
    },
  });
  async function request(path: string, identity: string, body?: unknown, role = "member") {
    const response = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: "Bearer personal-test", "x-agentbox-user": identity, "x-agentbox-role": role, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  }
  for (const member of ["web:alice", "web:bob"]) {
    const start = await request("/api/box/up", member, {});
    assert.equal(start.status, 403);
    assert.equal(start.data.code, "role-needed");
    const state = await request("/api/state", member);
    assert.equal(state.data.box.starting, false);
    assert.equal(state.data.box.backend, "kubernetes");
    assert.equal(state.data.box.docker, undefined);
  }
  const adminStart = await request("/api/box/up", "web:operator", {}, "owner");
  assert.equal(adminStart.status, 409);
  assert.equal(adminStart.data.code, "shared-box-kubernetes");
  const personal = await request("/api/personal-boxes/create", "web:alice", { requestId: "first" });
  assert.equal(personal.status, 200);
  assert.equal(personal.data.boxes[0].podStatus, "Running");
  assert.equal(personal.data.boxes[0].status, "unreachable", "pod phase and server reachability are different");
  const computers = await request("/api/boxes?lang=en", "web:alice");
  assert.equal(computers.data.namespace, "org-test");
  const box = computers.data.boxes.find((box: { id: string }) => box.id === personal.data.boxId);
  assert.equal(box.kind, "kubernetes");
  assert.equal(box.connected, false);
  assert.ok(box.detail);
  assert.equal(personal.data.boxes[0].connectionError, box.detail);
  const recovery = await request("/api/personal-boxes/admin", "web:operator", { id: box.id, action: "recover" }, "owner");
  assert.equal(recovery.status, 409, "admin connection retry must not report success while the computer remains unreachable");
  assert.equal(recovery.data.error, box.detail);
  const state = await request("/api/state", "web:alice");
  for (const [data, own] of [[state.data, state.data.box.own], [computers.data, computers.data.own]]) {
    const shared = data.boxes.find((row: { id: string }) => row.id === own);
    assert.equal(shared.connected, false);
    assert.equal(shared.kind, "kubernetes");
  }

  const page = APP_PAGE("en"), bar = { innerHTML: "" };
  const classic = page.slice(page.indexOf("function renderBoxBar()"), page.indexOf('$("boxbar").onclick'));
  runInNewContext(classic + "renderBoxBar();", {
    boxesSeen: state.data.boxes, currentBox: state.data.box.own, $: () => bar, esc: String,
  });
  assert.match(bar.innerHTML, /title="kubernetes"[^>]*>.*<span class="kind">kubernetes<\/span>/);
  assert.doesNotMatch(bar.innerHTML, /docker|the box on this machine/i);
  const footer = { textContent: "" };
  const footerSource = page.slice(page.indexOf("function renderClusterBoxStatus()"), page.indexOf("function refresh()"));
  runInNewContext(`${footerSource}; renderClusterBoxStatus();`, {
    $: () => footer, boxesSeen: state.data.boxes, boxState: state.data.box, currentBox: state.data.box.own, t: String,
  });
  assert.equal(footer.textContent, "ui.next.box.sharedKubernetes");

  const settings = { innerHTML: "" };
  const listStart = page.indexOf("function renderBoxes()");
  const listScript = page.slice(listStart, page.indexOf('\ndocument.addEventListener("click"', listStart));
  const external = { id: "external", kind: "attached", name: "Remote VM", displayFloor: 1, agents: 0 };
  await runInNewContext(listScript + "renderBoxes();", {
    $: () => settings, esc: String, t: String, myRole: "admin", renderDesktopResources: () => "",
    fetch: async (path: string) => {
      assert.equal(path, "/api/boxes?lang=en");
      return { json: async () => ({ ...computers.data, boxes: [...computers.data.boxes, external] }) };
    },
  });
  assert.match(settings.innerHTML, /data-detach-box="Remote VM">/, "the first visible attached box can be detached");

  const subtitles: string[] = [];
  const buttons: string[] = [];
  const notice: string[] = [];
  const node = { appendChild() {}, dataset: {}, replaceChildren() {} };
  const strip = {
    ...node,
    replaceChildren: (...children: { value: string }[]) => notice.splice(0, notice.length, ...children.map(child => child.value)),
    appendChild: (child: { value: string }) => notice.push(child.value),
  };
  const chat = { box: computers.data.own };
  let retry: (() => Promise<void>) | undefined;
  let refreshes = 0;
  const drawNotice: () => void = runInNewContext(NEXT_BOXES_JS + "\nObject.assign(boxes, input); renderBoxes(view); boxNotice(); boxNotice;", {
    input: { list: computers.data.boxes, own: computers.data.own, state: state.data.box },
    view: node, initial: String, t: String, canOperateInstallation: () => false, canDriveAgents: () => true, chat,
    refreshSoon: () => { refreshes++; }, failed: assert.fail,
    postJson: async (path: string, body: { id: string }) => {
      assert.equal(path, "/api/personal-boxes/retry");
      assert.equal(body.id, personal.data.boxId);
      const response = await request(path, "web:alice", body);
      assert.equal(response.status, 200);
      assert.equal(response.data.boxId, personal.data.boxId);
    },
    $: (id: string) => id === "box-notice" ? strip : node,
    el: (tag: string, style: string, value: string) => {
      if (style === "why") subtitles.push(value);
      if (tag === "button") buttons.push(value);
      return {
        ...node, dataset: {}, value,
        addEventListener: (event: string, action: () => Promise<void>) => {
          if (event === "click" && value === "ui.next.boxset.retryConnection") retry = action;
        },
      };
    },
  });
  assert.match(subtitles[computers.data.boxes.findIndex((row: { id: string }) => row.id === computers.data.own)] ?? "", /^kubernetes · /);
  assert.ok(subtitles.every(value => !/docker/i.test(value)));
  assert.ok(subtitles.includes("ui.next.box.sharedKubernetes"));
  assert.deepEqual(notice, ["ui.next.box.sharedKubernetes"]);
  assert.ok(!buttons.includes("ui.next.box.start"));
  const otherComputers = await request("/api/boxes", "web:bob");
  assert.ok(!otherComputers.data.boxes.some((row: { id: string }) => row.id === personal.data.boxId));
  chat.box = personal.data.boxId;
  drawNotice();
  assert.deepEqual(notice, ["ui.next.box.podUnreachable", "ui.next.boxset.retryConnection"]);
  assert.ok(retry, "the driver can retry the unreachable personal box without opening admin settings");
  await retry();
  assert.equal(refreshes, 1);

  const shelf = await request("/api/templates/shelf", "web:alice");
  const shelfPage = page.slice(page.indexOf("function openShelf("), page.indexOf('$("shelfopen").onclick'));
  const select = { innerHTML: "" };
  const panel = { innerHTML: "", style: {}, textContent: "" };
  runInNewContext(shelfPage + "openShelf(currentBox);", {
    currentBox: state.data.box.own, esc: String, $: (id: string) => id === "shelfbox" ? select : panel,
    loadPersonalBoxes() {}, shelfCard: () => "", document: { getElementById: () => null },
    fetch: async (path: string) => {
      assert.equal(path, "/api/templates/shelf");
      return { json: async () => shelf.data };
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(select.innerHTML, / selected>[^<]+ \(kubernetes\)<\/option>/, "INV-2069: Stamp into names the shared backend");
  assert.doesNotMatch(select.innerHTML, /docker/i);
  assert.equal(sharedDials, 0);
  assert.ok(!logs.some(line => /Docker lookup|docker inspect|box update:/.test(line)));
});

test("member provisioning uses canonical owner, rejects injected host options, enforces quota and hides other members' boxes", async () => {
  const home = mkdtempSync(join(tmpdir(), "personal-http-"));
  const previous = process.env.AGENTBOX_HOME;
  process.env.AGENTBOX_HOME = home;
  let stop: (() => void) | undefined;
  let starts = 0;
  try {
    new Principals().save([
      { id: "alice", name: "Alice", role: "driver", identities: ["web:alice", "web:alice-alt"] },
      { id: "bob", name: "Bob", role: "driver", identities: ["web:bob"] },
    ]);
    let base = "";
    stop = await startWebServer({
      port: 0,
      host: "127.0.0.1",
      token: "personal-test",
      useBox: false,
      onLog: () => {},
      onReady: (url) => {
        base = url;
      },
      personalBoxDriver: {
        start: async () => {
          starts++;
          return "http://127.0.0.1:1";
        },
        remove: async () => {},
      },
    });
    const request = async (path: string, body?: unknown, identity: string | undefined = "web:alice") => {
      const response = await fetch(base + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: "Bearer personal-test",
          "content-type": "application/json",
          ...(identity ? { "x-agentbox-user": identity, "x-agentbox-role": "member" } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return {
        status: response.status,
        data: (await response.json()) as {
          boxes: Array<{ id: string; name: string; status: string }>;
          error?: string;
        },
      };
    };
    // Installation credentials administer quotas but cannot impersonate a personal owner.
    const admin = await fetch(base + "/api/quotas", {
      method: "POST",
      headers: { authorization: "Bearer personal-test", "content-type": "application/json" },
      body: JSON.stringify({ personalBoxQuota: 1 }),
    });
    assert.equal(admin.status, 200);
    assert.equal(
      (await request("/api/personal-boxes/create", { requestId: "first", owner: "bob" })).status,
      400,
    );
    assert.equal(
      (await request("/api/personal-boxes/create", { requestId: "first", withHost: true })).status,
      400,
    );
    assert.equal(
      (await request("/api/personal-boxes/create", { requestId: "first" }, "unknown")).status,
      403,
    );
    const created = await request("/api/personal-boxes/create", { requestId: "first" });
    assert.equal(created.status, 200);
    assert.equal(created.data.boxes[0]!.status, "ready");
    const box = created.data.boxes[0]!;
    assert.deepEqual(Object.keys(box).sort(), ["dataRetained", "id", "name", "status"]);
    assert.equal(
      (await request("/api/personal-boxes/create", { requestId: "first" }, "web:alice-alt")).data.boxes[0]!
        .id,
      box.id,
    );
    assert.equal(starts, 1);
    assert.equal((await request("/api/personal-boxes/create", { requestId: "second" })).status, 409);
    assert.deepEqual((await request("/api/personal-boxes", undefined, "web:bob")).data.boxes, []);
    assert.equal((await request("/api/personal-boxes/retry", { id: box.id }, "web:bob")).status, 409);
    assert.equal(
      (await request("/api/personal-boxes/remove", { id: box.id, deleteData: true }, "web:bob")).status,
      409,
    );
    assert.equal(
      (await request("/api/boxes/update", { name: box.name, baseUrl: "http://example.invalid" })).status,
      409,
    );
    assert.equal((await request("/api/boxes/detach", { name: box.name })).status, 409);
    const bobState = await request("/api/state", undefined, "web:bob");
    assert.equal(bobState.status, 200);
    assert.ok(!JSON.stringify(bobState.data).includes(box.id));
    assert.equal((await request("/api/channels", undefined, "web:bob")).status, 403, "channel administration cannot expose another member or invitation credentials");
    assert.ok(
      !(await request("/api/templates/shelf", undefined, "web:bob")).data.boxes.some(
        (b: { id: string }) => b.id === box.id,
      ),
    );
    const desktop = await fetch(base + `/desktop/b/${box.id}/1/vnc.html`, {
      headers: {
        authorization: "Bearer personal-test",
        "x-agentbox-user": "web:bob",
        "x-agentbox-role": "member",
      },
    });
    assert.equal(desktop.status, 403);
    assert.equal((await request("/api/agents", { name: "Intruder", boxId: box.id }, "web:bob")).status, 403);
    const diskRegistry = new AgentRegistry(join(home, "agents"));
    const secretAgent = diskRegistry.create({ name: "Private Alice", boxId: box.id });
    assert.equal(
      (await request(`/api/transcript?agent=${secretAgent.id}`, undefined, "web:bob")).status,
      403,
    );
    assert.equal((await request(`/api/progress?agent=${secretAgent.id}`, undefined, "web:bob")).status, 403);
    assert.ok(
      !JSON.stringify((await request("/api/state", undefined, "web:bob")).data).includes(secretAgent.id),
    );
    const entry = new AgentRegistry(join(home, "agents")).boxById(box.id);
    assert.deepEqual(entry?.members, ["alice"]);
    assert.equal((await request("/api/reactions", { agent: secretAgent.id, index: 0, emoji: null }, "web:bob")).status, 403);
    const sharedAgent = diskRegistry.create({ name: "Shared stream fixture", boxId: diskRegistry.box.id });
    const streamAbort = new AbortController();
    const stream = await fetch(base + "/api/events", { headers: { authorization: "Bearer personal-test", "x-agentbox-user": "web:alice", "x-agentbox-role": "member" }, signal: streamAbort.signal });
    const reader = stream.body!.getReader();
    try {
      await reader.read(); // Initial connected comment.
      const react = () => fetch(base + "/api/reactions", { method: "POST", headers: { authorization: "Bearer personal-test", "content-type": "application/json" }, body: JSON.stringify({ agent: sharedAgent.id, index: 0, emoji: null }) });
      assert.equal((await react()).status, 200);
      assert.match(new TextDecoder().decode((await reader.read()).value), /reaction/);
      new Principals().save([]);
      assert.equal((await react()).status, 200);
      const received = reader.read().then(() => "event", () => "closed");
      assert.equal(await Promise.race([received, new Promise<string>(resolve => setTimeout(() => resolve("silent"), 250))]), "silent", "an already-open SSE stream stops receiving shared-box events after principal removal");
    } finally { streamAbort.abort(); await reader.cancel().catch(() => {}); }
    diskRegistry.remove(sharedAgent.id, { archive: false });
    new Principals().save([
      { id: "alice", name: "Alice", role: "driver", identities: ["web:alice", "web:alice-alt"] },
      { id: "bob", name: "Bob", role: "driver", identities: ["web:bob"] },
    ]);
    new UsageLog().record({
      agentId: secretAgent.id,
      agentName: "Private Alice",
      provider: "fixture",
      model: "fixture",
      round: 1,
      inputTokens: 17,
      outputTokens: 23,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      principal: "alice",
    });
    const usage = await request("/api/usage", undefined, "web:bob");
    assert.ok(!JSON.stringify(usage.data).includes(secretAgent.id));
    assert.equal((usage.data as unknown as { totals: { inputTokens: number } }).totals.inputTokens, 0);
    const ownUsage = await request("/api/usage");
    assert.ok(JSON.stringify(ownUsage.data).includes(secretAgent.id));
    assert.equal((await request("/api/personal-boxes/admin-cleanup", undefined, "web:bob")).status, 403);
    diskRegistry.remove(secretAgent.id, { archive: false });
    assert.equal(
      (await request("/api/personal-boxes/remove", { id: box.id })).status,
      400,
      "data retention must be explicit",
    );
    assert.equal(
      (await request("/api/personal-boxes/remove", { id: box.id, deleteData: false })).data.boxes[0]!.status,
      "detached",
    );
    assert.equal((await request("/api/personal-boxes/retry", { id: box.id })).data.boxes[0]!.status, "ready");
    new Principals().save([{ id: "alice", name: "Alice", role: "viewer", identities: ["web:alice"] }]);
    assert.deepEqual(
      (await request("/api/personal-boxes/remove", { id: box.id, deleteData: true })).data.boxes,
      [],
    );
    new Principals().save([{ id: "alice", name: "Alice", role: "driver", identities: ["web:alice"] }]);
    const orphan = (await request("/api/personal-boxes/create", { requestId: "orphan" })).data.boxes[0]!;
    new Principals().save([]);
    const cleanup = await fetch(base + "/api/personal-boxes/admin-cleanup", {
      method: "POST",
      headers: { authorization: "Bearer personal-test", "content-type": "application/json" },
      body: JSON.stringify({ id: orphan.id, deleteData: true }),
    });
    assert.equal(cleanup.status, 200);
    assert.deepEqual(((await cleanup.json()) as { boxes: unknown[] }).boxes, []);
  } finally {
    stop?.();
    if (previous === undefined) delete process.env.AGENTBOX_HOME;
    else process.env.AGENTBOX_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test("Computers inventories personal Kubernetes boxes and member removal keeps, transfers or deletes their resources explicitly", async () => {
  const home = mkdtempSync(join(tmpdir(), "personal-lifecycle-http-"));
  const previous = process.env.AGENTBOX_HOME;
  process.env.AGENTBOX_HOME = home;
  let stop: (() => void) | undefined;
  try {
    const people = ["Admin", "Alice", "Bob", "Charlie", "Dana", "Constructor"].map(name => ({
      id: name.toLowerCase(), name, role: (name === "Admin" ? "admin" : "driver") as "admin" | "driver" | "viewer",
      identities: [`web:${name.toLowerCase()}`],
    }));
    const principals = new Principals();
    principals.save(people);
    const fake = fakeKubeApi(), image = "lumenbox:test-version";
    const kube = new KubeBoxes({ api: fake.api, namespace: "org", defaultImage: () => image, pollIntervalMs: 1, startTimeoutMs: 50 });
    const driver = new KubernetesBoxDriver({ boxes: kube, image, decision: staticDecision({}) });
    let base = "";
    stop = await startWebServer({ port: 0, host: "127.0.0.1", token: "personal-lifecycle", useBox: false,
      onLog: () => {}, onReady: url => { base = url; }, personalBoxDriver: driver });
    const call = async (path: string, body?: unknown, member?: string) => {
      const response = await fetch(base + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: "Bearer personal-lifecycle", "content-type": "application/json",
          ...(member ? { "x-agentbox-user": `web:${member}`, "x-agentbox-role": member === "admin" ? "admin" : "member" } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, data: await response.json() };
    };
    assert.equal((await call("/api/quotas", { personalBoxQuota: 1, personBoxQuotas: { alice: 2, charlie: 2 } })).status, 200);
    const collection = "/api/personal-boxes";
    const create = async (person: string, name: string, requestId = "first") => {
      const result = await call(collection + "/create", { requestId, name }, person);
      assert.equal(result.status, 200, JSON.stringify(result.data));
      assert.equal(result.data.boxes.find((box: { id: string }) => box.id === result.data.boxId)?.status, "ready");
      return result.data.boxId as string;
    };
    const alice = await create("alice", "Alice’s computer");
    const bob = await create("bob", "Bob’s computer");
    const charlie = await create("charlie", "Charlie’s computer");
    const dana = await create("dana", "Dana’s computer");
    const resource = (id: string) => `personal-${id.slice(4)}`;
    const registry = new AgentRegistry(join(home, "agents"));
    const bea = registry.create({ name: "Bea", boxId: bob });
    const dee = registry.create({ name: "Dee", boxId: dana });
    principals.save(people.map(person => person.id === "bob" ? { ...person, role: "viewer" } : person));
    assert.equal((await call(collection + "/remove", { id: bob, deleteData: true, deleteAgents: true }, "bob")).status, 403);
    assert.ok(registry.has(bea.id));
    assert.ok(fake.pods.has(resource(bob)));
    principals.save(people);
    for (const agent of registry.list()) if (agent.id !== bea.id && agent.id !== dee.id) registry.remove(agent.id, { archive: false });
    const lastAgents = await call("/api/principals", {
      principals: people.filter(person => person.id !== "bob" && person.id !== "dana"),
      personalBoxes: { bob: { action: "delete", boxIds: [bob], agentIds: [bea.id] }, dana: { action: "delete", boxIds: [dana], agentIds: [dee.id] } },
    });
    assert.equal(lastAgents.status, 409);
    assert.match(lastAgents.data.error, /Keep at least one agent/);
    assert.ok(registry.has(bea.id) && registry.has(dee.id));
    assert.ok(fake.pods.has(resource(bob)) && fake.pods.has(resource(dana)));
    assert.equal((await call(collection, undefined, "bob")).status, 200);
    const renamed = (await call(collection + "/rename", { id: alice, name: "Desk" }, "alice")).data.boxes[0];
    assert.equal(renamed.name, "Desk");
    assert.equal(renamed.podStatus, "Running", "pod lookup uses the Kubernetes name after rename");
    assert.equal((await call(collection + "/rename", { id: bob, name: "Unexpected" }, "alice")).status, 409);
    const own = (await call(collection + "/panel", undefined, "bob")).data;
    assert.equal(own.inventory, null);
    assert.equal(own.mine.held, 1);
    assert.equal(own.mine.boxes[0].podStatus, "Running");
    assert.deepEqual(own.mine.boxes[0].agents, ["Bea"]);
    assert.equal((await call(collection + "/admin", undefined, "bob")).status, 403);
    const admin = () => call(collection + "/admin", undefined, "admin");
    const inventory = await admin();
    assert.equal(inventory.data.boxes.length, 4);
    const row = (rows: { id: string }[], id: string) => rows.find(item => item.id === id);
    assert.deepEqual(row(inventory.data.boxes, bob), {
      id: bob, owner: "bob", ownerName: "Bob", name: "Bob’s computer", status: "ready", podStatus: "Running",
      image, createdAt: own.mine.boxes[0].createdAt, retained: false, orphaned: false, pendingRemoval: false, dataRetained: false,
      agents: ["Bea"], agentIds: [bea.id],
    });
    const quota = (await call("/api/quotas")).data.people;
    assert.equal(inventory.data.people.find((person: { id: string }) => person.id === "bob").held,
      quota.find((person: { id: string }) => person.id === "bob").held);

    let roster = people.filter(person => person.id !== "bob");
    assert.equal((await call("/api/principals", { principals: roster })).status, 409);
    assert.ok(fake.pods.has(resource(bob)), "removal without a disposition did not stop the pod");
    const extra = registry.create({ name: "New agent", boxId: bob });
    const staleAgents = { id: bob, deleteData: true, deleteAgents: true, agentIds: [bea.id] };
    assert.match((await call(collection + "/remove", staleAgents, "bob")).data.error, /agents on these computers changed/);
    assert.match((await call(collection + "/admin", { ...staleAgents, action: "delete" }, "admin")).data.error, /agents on these computers changed/);
    const staleBoxes = await call("/api/principals", {
      principals: roster, personalBoxes: { bob: { action: "delete", boxIds: [], agentIds: [] } },
    });
    assert.equal(staleBoxes.status, 409);
    assert.match(staleBoxes.data.error, /computers changed/);
    const staleRemoval = await call("/api/principals", {
      principals: roster, personalBoxes: { bob: { action: "delete", boxIds: [bob], agentIds: [bea.id] } },
    });
    assert.equal(staleRemoval.status, 409);
    assert.match(staleRemoval.data.error, /agents on these computers changed/);
    assert.ok(fake.pods.has(resource(bob)) && registry.has(bea.id) && registry.has(extra.id));
    assert.equal((await call(collection, undefined, "bob")).status, 200);
    registry.remove(extra.id, { archive: false });
    const removed = await call("/api/principals", { principals: roster, personalBoxes: { bob: { action: "keep", boxIds: [bob] } } });
    assert.equal(removed.status, 200, JSON.stringify(removed.data));
    assert.equal(fake.pods.has(resource(bob)), false);
    assert.equal([...fake.pvcs].filter(([name]) => name.startsWith(resource(bob))).length, 3);
    assert.equal(registry.has(bea.id), true);
    assert.deepEqual((await call(collection, undefined, "bob")).status, 403);
    const retained = (await admin()).data.boxes.find((box: { id: string }) => box.id === bob);
    assert.equal(retained.ownerName, "Bob");
    assert.equal(retained.orphaned, true);
    assert.equal(retained.status, "detached");
    assert.equal((await call(collection + "/admin", { id: bob, action: "transfer", recipient: "admin" })).status, 200);
    assert.equal((await call(collection + "/admin", { id: bob, action: "recover" })).status, 200);
    assert.ok(fake.pods.has(resource(bob)));
    assert.equal((await call(collection, undefined, "admin")).data.boxes[0].agents[0], "Bea");

    roster = roster.filter(person => person.id !== "charlie");
    const spare = await create("charlie", "Charlie’s spare", "spare");
    assert.equal((await call(collection + "/remove", { id: spare, deleteData: false }, "charlie")).status, 200);
    const transfer = { action: "transfer", recipient: "alice", boxIds: [charlie, spare] };
    assert.equal((await call("/api/principals", { principals: roster, personalBoxes: { charlie: transfer } })).status, 200);
    assert.equal((await call(collection, undefined, "alice")).data.held, 2);
    assert.ok(fake.pods.has(resource(charlie)), "transfer retained the original pod and volumes");
    assert.equal((await admin()).data.boxes.find((box: { id: string }) => box.id === spare).owner, "alice");
    roster = roster.filter(person => person.id !== "dana");
    const erase = { action: "delete", boxIds: [dana], agentIds: [dee.id] };
    assert.equal((await call("/api/principals", { principals: roster, personalBoxes: { dana: erase } })).status, 200);
    assert.equal(fake.pods.has(resource(dana)), false);
    assert.equal([...fake.pvcs.keys()].some(name => name.startsWith(resource(dana))), false);
    assert.equal(registry.has(dee.id), false);
    assert.equal(row((await admin()).data.boxes, dana), undefined);
    roster = roster.filter(person => person.id !== "constructor");
    const removedComputerless = await call("/api/principals", { principals: roster, personalBoxes: {} });
    assert.equal(removedComputerless.status, 200, JSON.stringify(removedComputerless.data));
    assert.equal((await call(collection, undefined, "constructor")).status, 403);
  } finally {
    stop?.();
    if (previous === undefined) delete process.env.AGENTBOX_HOME;
    else process.env.AGENTBOX_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
