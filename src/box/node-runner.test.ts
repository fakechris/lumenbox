/**
 * The node's side (INV-1697): a node runs in a directory of its own and never beside an
 * installation, and running it creates none; an organisation that cannot be reached is not a
 * revocation; and `box connect` refuses to give an organisation a box from a machine that holds an
 * installation of its own — before any daemon token leaves it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { holdsInstallation } from "../host/installation.ts";
import { cmdBoxConnect, connectRefusal } from "./connect-cli.ts";
import { cmdNode, NODE_REVOKED_EXIT } from "./node-cli.ts";
import { NodeRunner } from "./node-runner.ts";

const shell = createRequire(import.meta.url)("../../electron/machine-use.cjs") as { personalInstallationExists(home: string): boolean };

function scratch(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "inv1697-node-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("what counts as an installation here is one test, in the shell and in the CLI", t => {
  for (const file of [undefined, "principals.json", "config.json"]) {
    const home = scratch(t);
    if (file !== undefined) writeFileSync(join(home, file), "{}");
    assert.equal(holdsInstallation(home), file !== undefined);
    assert.equal(shell.personalInstallationExists(home), holdsInstallation(home), `the shell agrees (${file ?? "empty"})`);
  }
});

test("a node refuses a directory with an installation, and running one creates none; a revocation stops it with its own exit code", async t => {
  const out: string[] = [];
  const base = { version: "0.0.0-test", boxdBundle: "/nonexistent/boxd.cjs", baseEnv: {}, out: (line: string) => out.push(line), err: (line: string) => out.push(line) };
  const personal = scratch(t);
  writeFileSync(join(personal, "principals.json"), "{}");
  const docker = { up: async () => ({ baseUrl: "http://127.0.0.1:1", token: "t".repeat(20) }), down: async () => {} };
  assert.equal(await cmdNode(["run", "--control", "http://org.test", "--name", "n1", "--no-native"], { ...base, credential: "lbxn_x", home: personal, docker: () => docker }), 1);
  assert.match(out.join("\n"), /holds an installation/);
  assert.equal(await cmdNode(["run", "--control", "http://org.test", "--name", "n1"], { ...base, credential: undefined, home: scratch(t), docker: () => docker }), 1, "no credential, no node");

  const home = scratch(t);
  let beats = 0;
  const fetchImpl = (async () => { beats += 1; return beats === 1 ? Response.json({ state: "connected" }) : Response.json({ code: "node-revoked" }, { status: 403 }); }) as unknown as typeof fetch;
  let runner: NodeRunner | undefined;
  const ran = cmdNode(["run", "--control", "http://org.test", "--name", "n1", "--no-native"], { ...base, credential: "lbxn_x", home, docker: () => docker, fetchImpl, onRunner: r => { runner = r; } });
  await new Promise(resolve => setTimeout(resolve, 50));
  await runner!.beat();
  assert.equal(await ran, NODE_REVOKED_EXIT);
  assert.equal(holdsInstallation(home), false, "no personal installation on a node");
  assert.deepEqual(readdirSync(home), [], "and nothing of a person's in its directory");
});

test("an organisation that cannot be reached is not a revocation: the boxes stay up and the next beat tries again", async t => {
  void t;
  let calls = 0;
  const stopped: string[] = [];
  const runner = new NodeRunner({ control: "http://org.test", credential: "lbxn_x", version: "t", heartbeatMs: 60_000, log: () => {}, fetchImpl: (async () => { calls += 1; throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch, boxes: [{ name: "n1-docker", kind: "docker", start: async () => ({ baseUrl: "http://127.0.0.1:1", token: "t" }), stop: async () => { stopped.push("n1-docker"); } }] });
  await runner.start();
  await runner.beat();
  assert.equal(calls, 2);
  assert.deepEqual(stopped, [], "still up");
  await runner.stop();
  assert.equal(await runner.done, "stopped");

  // Stopped while a box was still starting: that box is stopped as soon as it is up, and never registered.
  let release: () => void = () => {};
  const stoppedLate: string[] = [];
  const slow = new NodeRunner({ control: "http://org.test", credential: "lbxn_x", version: "t", log: () => {}, fetchImpl: (async () => { calls += 1; return Response.json({}); }) as unknown as typeof fetch, boxes: [{ name: "n2-docker", kind: "docker", start: () => new Promise(resolve => { release = () => resolve({ baseUrl: "http://127.0.0.1:1", token: "t" }); }), stop: async () => { stoppedLate.push("n2-docker"); } }] });
  const starting = slow.start();
  await slow.stop();
  release();
  await starting;
  assert.deepEqual([stopped, stoppedLate], [["n1-docker"], ["n2-docker"]]);
  assert.equal(calls, 2, "nothing registered after the stop");
});

test("box connect refuses an organisation from a machine with an installation of its own, and a code at any organisation, before a token is sent", async t => {
  const personal = scratch(t);
  writeFileSync(join(personal, "principals.json"), "{}");
  assert.match(connectRefusal({ installation: "organisation" }, personal, false) ?? "", /never given to an organisation/);
  assert.match(connectRefusal({ installation: "organisation" }, scratch(t), true) ?? "", /no box by a connection code/);
  assert.equal(connectRefusal({ installation: "organisation" }, scratch(t), false), undefined, "a reconnect of a box that joined before");
  assert.equal(connectRefusal({ installation: "single-machine" }, personal, true), undefined, "a personal installation takes codes");
  assert.equal(connectRefusal(undefined, personal, true), undefined, "an older server that does not say");

  const tokenFile = join(personal, "daemon.token");
  writeFileSync(tokenFile, "daemon-token-0123456789\n");
  const posted: string[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => { if (init?.method === "POST") posted.push(String(init.body)); return Response.json({ installation: "organisation", takes: ["node", "runner"] }); }) as unknown as typeof fetch;
  const lines: string[] = [];
  const code = await cmdBoxConnect(["--control", "http://org.test", "--url", "http://127.0.0.1:13380", "--token-file", tokenFile, "--code", "lbx-00000000-x", "--name", "laptop"], { home: personal, version: "t", out: line => lines.push(line), err: line => lines.push(line), fetchImpl });
  assert.equal(code, 1);
  assert.deepEqual(posted, [], "the daemon token never left");
  assert.equal(existsSync(join(personal, "runner")), false);
});

test("the machine's screen opens only where the node was started with --screen, and the registration says so (INV-1707)", async t => {
  const { headlessBoxdEnv } = await import("./headless-boxd.ts");
  const { nativeBox } = await import("./node-cli.ts");
  const input = { bind: "127.0.0.1", port: 1, token: "t", workDir: "/w", repositories: [] };
  assert.equal(headlessBoxdEnv({ BOXD_NATIVE_SCREEN: "1" }, input).BOXD_NATIVE_SCREEN, undefined, "an inherited value opens nothing: host up never opens a screen");
  assert.equal(headlessBoxdEnv({}, { ...input, screen: true }).BOXD_NATIVE_SCREEN, "1");

  const home = scratch(t);
  const bundle = join(home, "boxd.cjs");
  writeFileSync(bundle, "");
  const envs: NodeJS.ProcessEnv[] = [];
  const spawnImpl = ((_command: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
    envs.push(options.env);
    return { stdout: { on() {} }, stderr: { on() {} }, kill() {} };
  }) as unknown as typeof import("node:child_process").spawn;
  const posted: Record<string, unknown>[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => { if (init?.method === "POST") posted.push(JSON.parse(String(init.body)) as Record<string, unknown>); return Response.json({ state: "connected" }); }) as unknown as typeof fetch;
  for (const screen of [true, false]) {
    const box = nativeBox({ name: "n1-native", bundle, advertise: "127.0.0.1", port: 1, home, workDir: join(home, "work"), repositories: [], baseEnv: {}, ...(screen ? { screen: true } : {}), spawnImpl, fetchImpl, log: () => {} });
    const runner = new NodeRunner({ control: "http://org.test", credential: "lbxn_x", version: "t", heartbeatMs: 60_000, log: () => {}, fetchImpl, boxes: [box] });
    await runner.start();
    await runner.stop();
  }
  assert.deepEqual(envs.map(env => env.BOXD_NATIVE_SCREEN), ["1", undefined]);
  assert.deepEqual(posted.map(body => body.screen), [true, undefined]);
});
