import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWebServer } from "./server.ts";
import { UsageLog } from "../host/usage.ts";
import { Principals } from "../host/principals.ts";
import { AgentRegistry } from "../agents/registry.ts";

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
