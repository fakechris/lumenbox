/**
 * Recordings are read through the member's own box, and only by someone who may enter it
 * (INV-1949). `GET /recording` used to proxy every request to the installation's default box
 * with no member named, so a recording on an attached box could not be fetched at all, and
 * anyone signed in could fetch any file on the default box.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWebServer } from "./server.ts";
import { AgentRegistry } from "../agents/registry.ts";
import { Principals } from "../host/principals.ts";

process.env.AGENTBOX_TRUST_GATEWAY_IDENTITY = "1";

/** A stand-in boxd that says which box answered, what was asked, and with which token. */
async function fakeBoxd(name: string): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ box: name, path: req.url, auth: req.headers.authorization, recordings: [{ file: `${name}.mp4` }] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

test("a recording is fetched from the named member's box, and refused to a non-member", async () => {
  const home = mkdtempSync(join(tmpdir(), "agentbox-recording-access-"));
  const previous = process.env.AGENTBOX_HOME;
  process.env.AGENTBOX_HOME = home;
  const boxes = [await fakeBoxd("one"), await fakeBoxd("two")];
  let stop: (() => void) | undefined;
  try {
    new Principals().save([
      { id: "ada", name: "Ada", role: "driver", identities: ["web:ada"] },
      { id: "bob", name: "Bob", role: "driver", identities: ["web:bob"] },
    ]);
    const registry = new AgentRegistry(join(home, "agents"));
    const agents = ["one", "two"].map((id, index) => {
      const tokenFile = join(home, `${id}.token`);
      writeFileSync(tokenFile, `token-${id}`);
      registry.attachBox({ id, name: id, kind: "attached", endpoint: { baseUrl: boxes[index]!.url, tokenFile },
        members: [index === 0 ? "ada" : "bob"], displayFloor: 1, workDir: "/home/box/work", createdAt: new Date().toISOString() });
      return registry.create({ name: `Agent ${id}`, boxId: id }).id;
    });
    let base = "";
    stop = await startWebServer({ port: 0, host: "127.0.0.1", token: "rec-test", useBox: false, onLog: () => {}, onReady: url => { base = url; } });
    const get = async (path: string, identity: string) => {
      const response = await fetch(base + path, { headers: { authorization: "Bearer rec-test", "x-agentbox-user": identity, "x-agentbox-role": "member" } });
      return { status: response.status, data: await response.json() as Record<string, unknown> };
    };
    const [onOne, onTwo] = agents as [string, string];

    const own = await get(`/recording?agent=${onOne}&name=clip.mp4`, "web:ada");
    assert.equal(own.status, 200, JSON.stringify(own.data));
    assert.equal(own.data.box, "one", "proxied to the member's box, not the default one");
    assert.equal(own.data.path, "/recordings/file?name=clip.mp4");
    assert.equal(own.data.auth, "Bearer token-one", "with that box's own token");
    const second = await get(`/recording?agent=${onTwo}&name=clip.mp4`, "web:bob");
    assert.equal(second.data.box, "two");

    assert.equal((await get(`/recording?agent=${onTwo}&name=clip.mp4`, "web:ada")).status, 403, "not a member of box two");
    assert.equal((await get(`/api/recordings?agent=${onTwo}`, "web:ada")).status, 403);
    assert.equal((await get("/recording?name=clip.mp4", "web:ada")).status, 404, "a recording names its member");
    assert.equal((await get("/api/recordings?agent=nobody", "web:ada")).status, 404);

    const listed = await get(`/api/recordings?agent=${onOne}`, "web:ada");
    assert.equal(listed.status, 200, JSON.stringify(listed.data));
    assert.deepEqual(listed.data.recordings, [], "box one has no live client in this test, and the default box is not asked instead");
  } finally {
    stop?.();
    for (const { server } of boxes) server.close();
    if (previous === undefined) delete process.env.AGENTBOX_HOME; else process.env.AGENTBOX_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
