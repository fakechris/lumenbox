/**
 * The file routes (browse, download, upload) are bounded by the work directory of the box they talk
 * to (INV-1736): on a host box that is the directory it was started with, where `/home/box` does not
 * exist; on a Docker box it is the image's, as it always was.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { AgentRegistry } from "../agents/registry.ts";
import { BOXES_FILENAME } from "../box/boxes.ts";
import { AttachedBoxProvisioner } from "../box/provisioner.ts";
import { Principals } from "../host/principals.ts";
import { BOXD_PROTOCOL } from "../protocol/index.ts";
import { startWebServer } from "./server.ts";

/** A port the OS hands out; one per server, so the second never races the first one's close. */
const freePort = () => new Promise<number>((resolve, reject) => {
  const probe = createServer().listen(0, "127.0.0.1", () => { const address = probe.address(); probe.close(() => (typeof address === "object" && address !== null ? resolve(address.port) : reject(new Error("no port")))); });
});

test("Files lists and downloads from the requested box for its members only", async () => {
  const home = mkdtempSync(join(tmpdir(), "agentbox-scoped-files-"));
  const previous = { home: process.env.AGENTBOX_HOME, gateway: process.env.AGENTBOX_TRUST_GATEWAY_IDENTITY };
  process.env.AGENTBOX_HOME = home;
  process.env.AGENTBOX_TRUST_GATEWAY_IDENTITY = "1";
  const calls: string[] = [];
  let legacy = false;
  const boxd = createHttpServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/health") { res.end(JSON.stringify({ protocol: BOXD_PROTOCOL })); return; }
    if (req.url !== "/fs/list" && req.url !== "/fs/download") { res.writeHead(404).end("{}"); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString()) as { path: string; work_only?: true };
    const privateBox = req.headers.authorization === "Bearer private-fixture";
    if (input.work_only || req.url === "/fs/download") calls.push(`${privateBox ? "private" : "default"}:${req.url}:${input.path}`);
    if (req.url === "/fs/list") {
      res.end(JSON.stringify({ path: input.path, work_only: legacy ? undefined : input.work_only, entries: [{ name: "alice-47.md", type: "file", size: 10 }] }));
    } else {
      res.end(JSON.stringify({ path: input.path, media_type: "text/markdown", base64: Buffer.from("ALICE-ONLY").toString("base64") }));
    }
  });
  let stop: (() => void) | undefined;
  try {
    const boxPort = await freePort();
    await new Promise<void>(resolve => boxd.listen(boxPort, "127.0.0.1", resolve));
    const boxUrl = `http://127.0.0.1:${boxPort}`;
    new Principals().save([
      { id: "alice", name: "Alice", role: "driver", identities: ["web:alice"] },
      { id: "bob", name: "Bob", role: "viewer", identities: ["web:bob"] },
    ]);
    const registry = new AgentRegistry(join(home, "agents"));
    const tokenFile = join(home, "private.token"), work = "/srv/alice/work";
    writeFileSync(tokenFile, "private-fixture");
    registry.attachBox({ id: "alice-box", name: "Alice’s box", kind: "host", members: ["alice"],
      workDir: work, endpoint: { baseUrl: boxUrl, tokenFile }, displayFloor: 10, createdAt: new Date().toISOString() });
    const port = await freePort();
    stop = await startWebServer({ port, host: "127.0.0.1", token: "t0k", onLog: () => {},
      boxProvisioner: new AttachedBoxProvisioner({ baseUrl: boxUrl, token: "default-fixture" }) });
    const get = (path: string, who: string) => fetch(`http://127.0.0.1:${port}${path}`, { headers: {
      authorization: "Bearer t0k", "x-agentbox-user": `web:${who}`, "x-agentbox-role": who === "alice" ? "member" : "viewer",
    } });
    const list = "/api/files?boxId=alice-box", download = "/api/file?boxId=alice-box&path=" + encodeURIComponent(work + "/alice-47.md");
    assert.doesNotMatch(await (await get("/api/boxes", "bob")).text(), /alice-box/);
    assert.equal((await get(list, "bob")).status, 403);
    assert.equal((await get(download, "bob")).status, 403);
    assert.equal((await get(list + "&dir=" + encodeURIComponent(work + "/../outside"), "alice")).status, 403);
    assert.deepEqual(calls, []);
    const listing = await get(list, "alice");
    assert.equal(listing.status, 200);
    assert.deepEqual(await listing.json(), { path: work, root: work, entries: [{ name: "alice-47.md", type: "file", size: 10 }] });
    const file = await get(download, "alice");
    assert.equal(file.status, 200);
    assert.match(file.headers.get("content-disposition") ?? "", /^attachment; filename="alice-47.md"/);
    assert.equal(await file.text(), "ALICE-ONLY");
    assert.deepEqual(calls, [`private:/fs/list:${work}`, `private:/fs/download:${work}/alice-47.md`]);
    const subfolder = list + "&dir=" + encodeURIComponent(work + "/reports");
    assert.equal((await get(subfolder, "alice")).status, 200);
    assert.deepEqual(calls.splice(2), [`private:/fs/list:${work}`, `private:/fs/list:${work}/reports`]);
    legacy = true;
    const refused = await get(subfolder, "alice");
    assert.equal(refused.status, 503);
    assert.equal((await refused.json()).code, "work-browsing-needs-update");
    assert.deepEqual(calls.splice(2), [`private:/fs/list:${work}`], "never send the subfolder path to a legacy daemon");
  } finally {
    stop?.();
    boxd.close();
    if (previous.home === undefined) delete process.env.AGENTBOX_HOME; else process.env.AGENTBOX_HOME = previous.home;
    if (previous.gateway === undefined) delete process.env.AGENTBOX_TRUST_GATEWAY_IDENTITY; else process.env.AGENTBOX_TRUST_GATEWAY_IDENTITY = previous.gateway;
    rmSync(home, { recursive: true, force: true });
  }
});

test("the file routes refuse what is outside the default box's own work directory, and name it", async () => {
  const home = mkdtempSync(join(tmpdir(), "agentbox-work-dir-routes-"));
  const previous = { home: process.env.AGENTBOX_HOME, work: process.env.AGENTBOX_WORK_DIR };
  process.env.AGENTBOX_HOME = home;
  delete process.env.AGENTBOX_WORK_DIR;
  const stops: (() => void)[] = [];
  try {
    const registry = new AgentRegistry(join(home, "agents"));
    const boxesFile = join(registry.root, BOXES_FILENAME);
    const headers = { "content-type": "application/json", authorization: "Bearer t0k" };
    let base = "";
    const serve = async () => { const port = await freePort(); base = `http://127.0.0.1:${port}`; stops.push(await startWebServer({ port, host: "127.0.0.1", token: "t0k", useBox: false, onLog: () => {} })); };
    const refusal = async (path: string, init?: RequestInit) => {
      const response = await fetch(`${base}${path}`, { headers, ...init });
      return { status: response.status, error: ((await response.json()) as { error?: string }).error ?? "" };
    };
    const routes = (inside: string, outside: string) => [
      [`/api/files?dir=${encodeURIComponent(outside)}`, undefined, inside],
      [`/api/file?path=${encodeURIComponent(`${outside}/x.md`)}`, undefined, inside],
      ["/api/file", { method: "POST", body: JSON.stringify({ path: `${outside}/x.md`, base64: "" }) }, inside],
    ] as const;

    // The image's layout: the host box's directory is outside it.
    await serve();
    for (const [path, init, inside] of routes("/home/box/work", "/Users/ada/lumenbox")) {
      const answer = await refusal(path, init);
      assert.equal(answer.status, 403, path);
      assert.ok(answer.error.includes(inside), `${path}: ${answer.error}`);
    }
    stops.pop()?.();

    // A host box as the installation's own: its directory is the bound, and the image's is outside.
    const work = "/Users/ada/lumenbox";
    const entries = JSON.parse(readFileSync(boxesFile, "utf8")) as Record<string, unknown>[];
    writeFileSync(boxesFile, JSON.stringify([{ ...entries[0], kind: "host", workDir: work }, ...entries.slice(1)]));
    await serve();
    for (const [path, init, inside] of routes(work, "/home/box/work")) {
      const answer = await refusal(path, init);
      assert.equal(answer.status, 403, path);
      assert.ok(answer.error.includes(inside) && !answer.error.includes("/home/box"), `${path}: ${answer.error}`);
    }
    // Inside it, the route goes on to the box, which this test does not run.
    assert.equal((await refusal(`/api/files?dir=${encodeURIComponent(`${work}/reports`)}`)).status, 503);
    // The page's chat links learn the root from here, box or no box (INV-1737).
    assert.equal(((await (await fetch(`${base}/api/files`, { headers })).json()) as { root?: string }).root, work);
  } finally {
    for (const stop of stops) stop();
    if (previous.home === undefined) delete process.env.AGENTBOX_HOME;
    else process.env.AGENTBOX_HOME = previous.home;
    if (previous.work !== undefined) process.env.AGENTBOX_WORK_DIR = previous.work;
    rmSync(home, { recursive: true, force: true });
  }
});

test("Files without a boxId cannot follow a link out of the default box's work folder (INV-2094)", async () => {
  const home = mkdtempSync(join(tmpdir(), "agentbox-files-link-")), outside = mkdtempSync(join(tmpdir(), "agentbox-files-outside-"));
  const work = join(home, "work"), previous = { home: process.env.AGENTBOX_HOME, work: process.env.AGENTBOX_WORK_DIR };
  mkdirSync(work);
  writeFileSync(join(outside, "secret-name.txt"), "x");
  symlinkSync(outside, join(work, "escape"));
  process.env.AGENTBOX_HOME = home;
  process.env.AGENTBOX_WORK_DIR = work;
  const { listDir } = await import("../boxd/fs-service.ts"); // the real listing, which reads the work root at import
  const boxd = createHttpServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/health") { res.end(JSON.stringify({ protocol: BOXD_PROTOCOL })); return; }
    if (req.url !== "/fs/list") { res.writeHead(404).end("{}"); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    try { res.end(JSON.stringify(await listDir(JSON.parse(Buffer.concat(chunks).toString())))); }
    catch (error) { res.writeHead(400).end(JSON.stringify({ error: (error as Error).message })); }
  });
  let stop: (() => void) | undefined;
  try {
    const boxPort = await freePort();
    await new Promise<void>(resolve => boxd.listen(boxPort, "127.0.0.1", resolve));
    const port = await freePort();
    stop = await startWebServer({ port, host: "127.0.0.1", token: "t0k", onLog: () => {},
      boxProvisioner: new AttachedBoxProvisioner({ baseUrl: `http://127.0.0.1:${boxPort}`, token: "default-fixture" }) });
    const get = (dir?: string) => fetch(`http://127.0.0.1:${port}/api/files${dir ? `?dir=${encodeURIComponent(dir)}` : ""}`, { headers: { authorization: "Bearer t0k" } });
    const top = await get();
    assert.equal(top.status, 200, "the page's own listing still works");
    assert.deepEqual(((await top.json()) as { entries: { name: string; target_in_work?: boolean }[] }).entries.map(entry => [entry.name, entry.target_in_work]), [["escape", false]]);
    const through = await get(join(work, "escape"));
    assert.notEqual(through.status, 200);
    assert.doesNotMatch(await through.text(), /secret-name/);
  } finally {
    stop?.();
    boxd.close();
    if (previous.home === undefined) delete process.env.AGENTBOX_HOME; else process.env.AGENTBOX_HOME = previous.home;
    if (previous.work === undefined) delete process.env.AGENTBOX_WORK_DIR; else process.env.AGENTBOX_WORK_DIR = previous.work;
    rmSync(home, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
