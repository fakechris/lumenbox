/**
 * `agentbox box connect` (INV-434): registers this machine's boxd with another installation using a
 * one-time connection code it minted. The daemon token travels once, over the control URL; what is
 * kept here is the runner credential the reply carries, so `box connect` without `--code` can
 * reconnect after a move or a restart.
 *
 * Asked first, before any token leaves this machine: which ways the installation takes
 * (`GET /api/boxes/register`). An organisation takes no code (docs/96 §8 Q3), and a machine that
 * holds an installation of its own — a personal machine, or personal + organisation — never gives
 * an organisation a box at all (docs/96 §0.3, INV-1697). Both are refused here, with what to do
 * instead; the organisation refuses them too.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { holdsInstallation } from "../host/installation.ts";

export interface ConnectIo {
  home: string;
  version: string;
  out: (line: string) => void;
  err: (line: string) => void;
  fetchImpl?: typeof fetch;
}

/** Why this machine may not give this installation a box by `box connect`, or undefined when it may. */
export function connectRefusal(ways: { installation?: string } | undefined, home: string, withCode: boolean): string | undefined {
  if (ways?.installation !== "organisation") return undefined;
  if (holdsInstallation(home)) return `This machine holds an installation of its own (${home}): it is a personal machine, and its boxes are never given to an organisation (docs/96 §0.3). Work for the organisation in the organisation's boxes instead.`;
  if (withCode) return "An organisation takes no box by a connection code. Make this machine an organisation node from the LumenBox app (first run → Organisation node, then an Admin signs in), or ask an Admin to `box attach` it.";
  return undefined;
}

export async function cmdBoxConnect(argv: string[], io: ConnectIo): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { control: { type: "string" }, url: { type: "string" }, "token-file": { type: "string" }, name: { type: "string" }, code: { type: "string" }, runner: { type: "string" }, kind: { type: "string" } }, strict: false });
  const text = (key: string): string => (typeof values[key] === "string" ? String(values[key]) : "");
  const control = text("control").replace(/\/$/, "");
  const baseUrl = text("url");
  const tokenFile = text("token-file");
  const name = text("name");
  const code = text("code");
  const fetchImpl = io.fetchImpl ?? fetch;
  const stateDir = join(io.home, "runner");
  const stateFile = join(stateDir, `${name || "box"}.json`);
  let runner = text("runner");
  if (runner === "" && code === "" && existsSync(stateFile)) {
    try {
      runner = String((JSON.parse(readFileSync(stateFile, "utf8")) as { runner?: string }).runner ?? "");
    } catch {
      // No saved credential: a code is needed.
    }
  }
  if (control === "" || baseUrl === "" || tokenFile === "" || (code === "" && runner === "")) {
    io.err("Usage: agentbox box connect --control http://host:7777 --url http://this-machine:13370 --token-file F --code lbx-… [--name N] [--kind host]\n       agentbox box connect --control … --url … --token-file F --name N   (reconnect with the saved runner credential)");
    return 1;
  }
  let ways: { installation?: string } | undefined;
  try {
    const answer = await fetchImpl(`${control}/api/boxes/register`, { signal: AbortSignal.timeout(15_000) });
    ways = answer.ok ? ((await answer.json()) as { installation?: string }) : undefined;
  } catch (error) {
    io.err(`Could not reach ${control}: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const refusal = connectRefusal(ways, io.home, runner === "");
  if (refusal !== undefined) {
    io.err(refusal);
    return 1;
  }
  let token: string;
  try {
    token = readFileSync(tokenFile, "utf8").trim();
  } catch {
    io.err(`Cannot read the daemon token at ${tokenFile}.`);
    return 1;
  }
  const body = runner !== "" ? { runner, name, baseUrl, token, version: io.version } : { code, name, baseUrl, token, version: io.version, ...(text("kind") === "host" ? { kind: "host" } : {}) };
  let response: Response;
  try {
    response = await fetchImpl(`${control}/api/boxes/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    io.err(`Could not reach ${control}: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const reply = (await response.json().catch(() => ({}))) as { error?: string; boxId?: string; name?: string; runner?: string; connected?: boolean; detail?: string; state?: string };
  if (!response.ok) {
    io.err(`Registration refused (${response.status}): ${reply.error ?? "no reason given"}`);
    return 1;
  }
  if (reply.runner !== undefined) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(stateFile, `${JSON.stringify({ control, boxId: reply.boxId, name: reply.name, runner: reply.runner }, null, 2)}\n`, { mode: 0o600 });
  }
  io.out(`${reply.name ?? name} is registered at ${control} as ${reply.boxId} — ${reply.state ?? (reply.connected ? "connected" : "offline")}: ${reply.detail ?? ""}`);
  if (reply.runner !== undefined) io.out(`runner credential saved to ${stateFile}; reconnect with the same command without --code`);
  return 0;
}
