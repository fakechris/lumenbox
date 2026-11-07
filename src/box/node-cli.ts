/**
 * `agentbox node run` (INV-1697, docs/96 §4): this machine as an organisation's node. The app
 * starts it after an Admin signed in to the organisation here and the organisation issued the node
 * credential (electron/organisation-node.cjs); the credential arrives in the environment, never on
 * the command line, where `ps` would show it.
 *
 * It runs in a state directory of its own (the app's `userData/node`), never in a personal
 * installation's: a directory that holds an installation is refused, because a node has no
 * personal installation and a personal machine never gives an organisation a box (docs/96 §0.3).
 * What it writes there is the daemons' tokens, nothing a person put there.
 *
 * Two boxes, each optional: `<name>-docker`, the same image a personal machine runs, and
 * `<name>-native`, the machine's native environment — the headless box daemon `host up` starts,
 * confined by the OS sandbox (INV-1700), reaching only the granted directories. Both listen on
 * the address given with `--advertise` (a network the node and the organisation's server share,
 * such as a tailnet) and nowhere else.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Repository } from "../host/bundles.ts";
import { holdsInstallation } from "../host/installation.ts";
import { headlessBoxdEnv } from "./headless-boxd.ts";
import { type NodeBox, NodeRunner } from "./node-runner.ts";

export interface NodeCliDeps {
  credential: string | undefined;
  home: string;
  version: string;
  /** The built box daemon (`npm run build:boxd`). */
  boxdBundle: string;
  /** The Docker box: up, its daemon's address and token; down. */
  docker: (containerName: string, advertise: string) => { up(): Promise<{ baseUrl: string; token: string }>; down(): Promise<void> };
  baseEnv: NodeJS.ProcessEnv;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Replaced in tests. */
  spawnImpl?: typeof spawn;
  fetchImpl?: typeof fetch;
  onRunner?: (runner: NodeRunner) => void;
}

/** What `node run` exits with once the organisation revoked the node. */
export const NODE_REVOKED_EXIT = 3;

async function waitForHealth(url: string, fetchImpl: typeof fetch, timeoutMs = 20_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < until) {
    try {
      if ((await fetchImpl(`${url}/health`, { signal: AbortSignal.timeout(2000) })).ok) return;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`the box daemon at ${url} did not answer (${last || "no answer"})`);
}

/** The machine's native environment as a box: the headless daemon, bound to the advertised address only. */
export function nativeBox(input: { name: string; bundle: string; advertise: string; port: number; home: string; workDir: string; repositories: Repository[]; baseEnv: NodeJS.ProcessEnv; screen?: boolean; spawnImpl?: typeof spawn; fetchImpl?: typeof fetch; log: (line: string) => void }): NodeBox {
  let child: ChildProcess | undefined;
  return {
    name: input.name,
    kind: "host",
    async start() {
      if (!existsSync(input.bundle)) throw new Error(`no box daemon at ${input.bundle}; run \`npm run build:boxd\``);
      const dir = join(input.home, "node-boxes");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      mkdirSync(input.workDir, { recursive: true });
      const tokenFile = join(dir, `${input.name}.token`);
      if (!existsSync(tokenFile)) writeFileSync(tokenFile, `${randomBytes(24).toString("hex")}\n`, { mode: 0o600 });
      const token = readFileSync(tokenFile, "utf8").trim();
      child = (input.spawnImpl ?? spawn)(process.execPath, [input.bundle], { stdio: ["ignore", "pipe", "pipe"], env: headlessBoxdEnv(input.baseEnv, { bind: input.advertise, port: input.port, token, workDir: input.workDir, repositories: input.repositories, ...(input.screen === true ? { screen: true } : {}) }) });
      const started = child;
      process.once("exit", () => started.kill("SIGTERM")); // a node that dies takes its daemon with it: nothing is left listening for an organisation
      const relay = (chunk: unknown) => { for (const line of String(chunk).split("\n")) if (line.trim() !== "") input.log(`${input.name}: ${line}`); };
      child.stdout?.on("data", relay);
      child.stderr?.on("data", relay);
      const baseUrl = `http://${input.advertise.includes(":") ? `[${input.advertise}]` : input.advertise}:${input.port}`;
      await waitForHealth(baseUrl, input.fetchImpl ?? fetch);
      return { baseUrl, token, workDir: input.workDir, repositories: input.repositories, ...(input.screen === true ? { screen: true as const } : {}) };
    },
    async stop() {
      child?.kill("SIGTERM");
      child = undefined;
    },
  };
}

/**
 * `agentbox node run --control URL --name N [--advertise HOST] [--work D] [--repo P[:ro]]... [--port N] [--no-docker] [--no-native] [--screen]`
 *
 * `--screen` opens the native environment's own screen to the computer tool (INV-1707, macOS only):
 * chosen at the machine, by whoever starts the node there, never by the organisation from afar.
 */
export async function cmdNode(argv: string[], deps: NodeCliDeps): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub !== "run") {
    deps.err("Usage: agentbox node run --control URL --name N [--advertise HOST] [--work D] [--repo P[:ro]]... [--port N] [--no-docker] [--no-native] [--screen]\n       --screen opens this Mac's own screen to the computer tool (Screen Recording and Accessibility for the app that starts the node).\n       The node credential is read from AGENTBOX_NODE_CREDENTIAL; the LumenBox app sets it after an Admin signs in.");
    return 1;
  }
  const { values } = parseArgs({ args: rest, options: { control: { type: "string" }, name: { type: "string" }, advertise: { type: "string" }, work: { type: "string" }, repo: { type: "string", multiple: true }, port: { type: "string" }, "no-docker": { type: "boolean" }, "no-native": { type: "boolean" }, screen: { type: "boolean" } }, strict: true });
  const control = String(values.control ?? "");
  const name = String(values.name ?? "");
  if (control === "" || name === "" || deps.credential === undefined || deps.credential === "") {
    deps.err("node run needs --control, --name and the node credential in AGENTBOX_NODE_CREDENTIAL.");
    return 1;
  }
  if (holdsInstallation(deps.home)) {
    deps.err(`${deps.home} holds an installation of LumenBox. A node runs in a directory of its own and never beside a personal installation (docs/96 §0.3); the app gives it userData/node.`);
    return 1;
  }
  const advertise = String(values.advertise ?? "127.0.0.1");
  const workDir = values.work !== undefined ? resolve(String(values.work)) : join(homedir(), "lumenbox-node-work");
  const repositories: Repository[] = (values.repo as string[] | undefined ?? []).map(raw => (raw.endsWith(":ro") ? { path: resolve(raw.slice(0, -3)), mode: "ro" as const } : { path: resolve(raw.replace(/:rw$/, "")), mode: "rw" as const }));
  if (!repositories.some(repo => repo.path === workDir)) repositories.push({ path: workDir, mode: "rw" });
  const log = (line: string) => deps.out(line);
  const boxes: NodeBox[] = [];
  if (values["no-native"] !== true) boxes.push(nativeBox({ name: `${name}-native`, bundle: deps.boxdBundle, advertise, port: values.port !== undefined ? Number(values.port) : 13390, home: deps.home, workDir, repositories, baseEnv: deps.baseEnv, ...(values.screen === true ? { screen: true } : {}), ...(deps.spawnImpl !== undefined ? { spawnImpl: deps.spawnImpl } : {}), ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}), log }));
  if (values["no-docker"] !== true) {
    const docker = deps.docker(`lumenbox-node-${name}`, advertise);
    boxes.push({ name: `${name}-docker`, kind: "docker", start: () => docker.up(), stop: () => docker.down() });
  }
  const runner = new NodeRunner({ control, credential: deps.credential, boxes, version: deps.version, log, ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}) });
  deps.onRunner?.(runner);
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void runner.stop("stopped"); });
  log(`node ${name}: an organisation node of ${control}; boxes listen on ${advertise} only`);
  await runner.start();
  const end = await runner.done;
  log(`node ${name}: ${end === "revoked" ? "revoked by the organisation; every box here is stopped" : "stopped"}`);
  return end === "revoked" ? NODE_REVOKED_EXIT : 0;
}
