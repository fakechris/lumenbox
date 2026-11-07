/**
 * The file routes (browse, download, upload) are bounded by the work directory of the box they talk
 * to (INV-1736): on a host box that is the directory it was started with, where `/home/box` does not
 * exist; on a Docker box it is the image's, as it always was.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { AgentRegistry } from "../agents/registry.ts";
import { BOXES_FILENAME } from "../box/boxes.ts";
import { startWebServer } from "./server.ts";

/** A port the OS hands out; one per server, so the second never races the first one's close. */
const freePort = () => new Promise<number>((resolve, reject) => {
  const probe = createServer().listen(0, "127.0.0.1", () => { const address = probe.address(); probe.close(() => (typeof address === "object" && address !== null ? resolve(address.port) : reject(new Error("no port")))); });
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
  } finally {
    for (const stop of stops) stop();
    if (previous.home === undefined) delete process.env.AGENTBOX_HOME;
    else process.env.AGENTBOX_HOME = previous.home;
    if (previous.work !== undefined) process.env.AGENTBOX_WORK_DIR = previous.work;
    rmSync(home, { recursive: true, force: true });
  }
});
