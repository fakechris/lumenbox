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
  async function request(path: string, identity: string, body?: unknown) {
    const response = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: "Bearer personal-test", "x-agentbox-user": identity, "x-agentbox-role": "member", "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  }
  for (const member of ["web:alice", "web:bob"]) {
    const start = await request("/api/box/up", member, {});
    assert.equal(start.status, 409);
    assert.equal(start.data.code, "shared-box-kubernetes");
    const state = await request("/api/state", member);
    assert.equal(state.data.box.starting, false);
    assert.equal(state.data.box.backend, "kubernetes");
    assert.equal(state.data.box.docker, undefined);
  }
  const personal = await request("/api/personal-boxes/create", "web:alice", { requestId: "first" });
  assert.equal(personal.status, 200);
  assert.equal(personal.data.boxes[0].podStatus, "Running");
  assert.equal(personal.data.boxes[0].status, "unreachable", "pod phase and server reachability are different");
  const computers = await request("/api/boxes", "web:alice");
  assert.equal(computers.data.namespace, "org-test");
  const box = computers.data.boxes.find((box: { id: string }) => box.id === personal.data.boxId);
  assert.equal(box.kind, "kubernetes");
  assert.equal(box.connected, false);
  assert.ok(box.detail);
  assert.equal(personal.data.boxes[0].connectionError, box.detail);
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

  const subtitles: string[] = [];
  const node = { appendChild() {}, addEventListener() {} };
  runInNewContext(NEXT_BOXES_JS + "\nObject.assign(boxes, input); renderBoxes(view);", {
    input: { list: computers.data.boxes, own: computers.data.own, state: state.data.box },
    view: node, initial: String, t: String,
    el: (_tag: string, style: string, value: string) => {
      if (style === "why") subtitles.push(value);
      return { ...node };
    },
  });
  assert.match(subtitles[computers.data.boxes.findIndex((row: { id: string }) => row.id === computers.data.own)] ?? "", /^kubernetes · /);
  assert.ok(subtitles.every(value => !/docker/i.test(value)));

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
