/**
 * The watchdog as a resident service (INV-1517, docs/91): installed once, started at login,
 * restarted when it exits, removed with its token.
 *
 * `install` mints a side-door token for the person it runs for — the installation's one admin
 * unless `--principal` names another — through the web's own token endpoint, with the local UI
 * token. The secret goes to a 0600 file and nowhere else: not the plist, not a log, not the
 * terminal. The plist runs the same agentbox that ran `install` (the program, its node flags, its
 * script), so an app install runs the app's copy and a checkout runs the checkout's. `uninstall`
 * stops the service, revokes the token by its creation time, and deletes what install wrote.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_LABEL = "com.lumenbox.watchdog";

export interface InstallOptions {
  url: string;
  principal?: string;
  judge: boolean;
  stallMinutes?: number;
  pausedMinutes?: number;
  onDown?: string;
  label?: string;
}

export interface InstallDeps {
  home: string;
  launchAgentsDir: string;
  uid: number;
  platform: string;
  uiToken: () => string;
  fetch: typeof fetch;
  run: (command: string, args: string[]) => { code: number; stdout: string };
  /** What runs: this process's program, flags and script; plus what it needs in its environment. */
  program: { execPath: string; execArgv: string[]; script: string; env: Record<string, string> };
  sleep?: (ms: number) => Promise<void>;
}

interface InstallRecord {
  label: string;
  url: string;
  principalId: string;
  createdAt: string;
  plist: string;
  installedAt: string;
}

const dirOf = (deps: Pick<InstallDeps, "home">) => join(deps.home, "watchdog");
const tokenPath = (deps: Pick<InstallDeps, "home">) => join(dirOf(deps), "token");
const recordPath = (deps: Pick<InstallDeps, "home">) => join(dirOf(deps), "install.json");
const logPath = (deps: Pick<InstallDeps, "home">) => join(dirOf(deps), "watchdog.log");

const xml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The launchd job: the arguments, the log, restart on exit, and never the token itself. */
export function plistFor(label: string, args: string[], env: Record<string, string>, log: string): string {
  const strings = (items: string[]) => items.map(item => `    <string>${xml(item)}</string>`).join("\n");
  const envEntries = Object.entries(env).map(([key, value]) => `    <key>${xml(key)}</key>\n    <string>${xml(value)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${strings(args)}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${envEntries}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
</dict>
</plist>
`;
}

/** Whose token: the one named, or the installation's single admin. */
export function principalFor(deps: Pick<InstallDeps, "home">, named?: string): string {
  const file = join(deps.home, "principals.json");
  const people = existsSync(file) ? ((JSON.parse(readFileSync(file, "utf8")) as { principals?: { id: string; name: string; role: string }[] }).principals ?? []) : [];
  if (named !== undefined) {
    const match = people.find(person => person.id === named || person.name === named);
    if (match === undefined) throw new Error(`No person ${named} on this installation.`);
    return match.id;
  }
  const admins = people.filter(person => person.role === "admin");
  if (admins.length !== 1) throw new Error(`Name whose token this is with --principal: the installation has ${admins.length} admins.`);
  return admins[0]!.id;
}

export function readRecord(deps: Pick<InstallDeps, "home">): InstallRecord | undefined {
  return existsSync(recordPath(deps)) ? (JSON.parse(readFileSync(recordPath(deps), "utf8")) as InstallRecord) : undefined;
}

export async function installWatchdog(options: InstallOptions, deps: InstallDeps): Promise<string[]> {
  const label = options.label ?? DEFAULT_LABEL;
  const already = readRecord(deps);
  if (already !== undefined) return [`The watchdog is already installed (${already.label}, watching ${already.url}). agentbox watchdog uninstall first to change it.`];
  const principalId = principalFor(deps, options.principal);
  const response = await deps.fetch(`${options.url.replace(/\/+$/, "")}/api/mcp/tokens`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${deps.uiToken()}` },
    body: JSON.stringify({ principalId, label: "watchdog" }),
  });
  if (!response.ok) throw new Error(`The web at ${options.url} refused to issue a token (HTTP ${response.status}). Is LumenBox running?`);
  const minted = (await response.json()) as { token: string; createdAt: string };
  mkdirSync(dirOf(deps), { recursive: true, mode: 0o700 });
  writeFileSync(tokenPath(deps), `${minted.token}\n`, { mode: 0o600 });
  chmodSync(tokenPath(deps), 0o600);
  const args = [
    deps.program.execPath, ...deps.program.execArgv, deps.program.script, "watchdog",
    "--url", options.url, "--token-file", tokenPath(deps),
    ...(options.judge ? ["--judge"] : []),
    ...(options.stallMinutes !== undefined ? ["--stall-minutes", String(options.stallMinutes)] : []),
    ...(options.pausedMinutes !== undefined ? ["--paused-minutes", String(options.pausedMinutes)] : []),
    "--on-down", options.onDown ?? `osascript -e 'display notification "The LumenBox door is not answering" with title "LumenBox watchdog"'`,
  ];
  const plist = join(deps.launchAgentsDir, `${label}.plist`);
  const record: InstallRecord = { label, url: options.url, principalId, createdAt: minted.createdAt, plist, installedAt: new Date().toISOString() };
  writeFileSync(recordPath(deps), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  const body = plistFor(label, args, deps.program.env, logPath(deps));
  if (deps.platform !== "darwin") {
    return [`Token issued and saved to ${tokenPath(deps)}. Not macOS, so nothing was registered; a systemd user unit runs:`, args.join(" ")];
  }
  mkdirSync(deps.launchAgentsDir, { recursive: true });
  writeFileSync(plist, body);
  const loaded = deps.run("launchctl", ["bootstrap", `gui/${deps.uid}`, plist]);
  if (loaded.code !== 0) throw new Error(`launchctl bootstrap failed (${loaded.code}): ${loaded.stdout.trim()}`);
  return [`Installed ${label}: it starts at login, restarts when it exits, and watches ${options.url}${options.judge ? " with the decision model as a second opinion" : ""}.`, `Its token is in your name (${principalId}), labelled "watchdog" in Settings → Mine → Your MCP tokens. Log: ${logPath(deps)}.`];
}

export async function uninstallWatchdog(deps: InstallDeps): Promise<string[]> {
  const record = readRecord(deps);
  if (record === undefined) return ["The watchdog is not installed."];
  const lines: string[] = [];
  if (deps.platform === "darwin") {
    deps.run("launchctl", ["bootout", `gui/${deps.uid}/${record.label}`]);
    // bootout returns before the job is gone; say "stopped" only once launchd no longer has it.
    const sleep = deps.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
    let gone = false;
    for (let i = 0; i < 20 && !gone; i++) {
      gone = deps.run("launchctl", ["print", `gui/${deps.uid}/${record.label}`]).code !== 0;
      if (!gone) await sleep(250);
    }
    rmSync(record.plist, { force: true });
    lines.push(gone ? `Stopped and removed ${record.label}.` : `Removed ${record.label}'s job file, but launchd still lists it after five seconds; check launchctl print gui/${deps.uid}/${record.label}.`);
  }
  try {
    const response = await deps.fetch(`${record.url.replace(/\/+$/, "")}/api/mcp/tokens/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${deps.uiToken()}` },
      body: JSON.stringify({ createdAt: record.createdAt }),
    });
    lines.push(response.ok ? "Its token is revoked." : `The token was not revoked (HTTP ${response.status}); revoke "watchdog" in Settings → Mine → Your MCP tokens.`);
  } catch (error) {
    lines.push(`The web did not answer, so the token was not revoked (${error instanceof Error ? error.message : String(error)}); revoke "watchdog" in Settings → Mine → Your MCP tokens.`);
  }
  rmSync(tokenPath(deps), { force: true });
  rmSync(recordPath(deps), { force: true });
  return lines;
}

export function watchdogStatus(deps: InstallDeps): string[] {
  const record = readRecord(deps);
  if (record === undefined) return ["The watchdog is not installed."];
  const printed = deps.platform === "darwin" ? deps.run("launchctl", ["print", `gui/${deps.uid}/${record.label}`]) : { code: 1, stdout: "" };
  const state = /\bstate = (\w+)/.exec(printed.stdout)?.[1] ?? (printed.code === 0 ? "loaded" : "not loaded");
  const pid = /\bpid = (\d+)/.exec(printed.stdout)?.[1];
  const log = existsSync(logPath(deps)) ? readFileSync(logPath(deps), "utf8").trim().split("\n") : [];
  const lastFlag = [...log].reverse().find(line => /watchdog: (stalled|stopped-unattended|verification-failing) /.test(line));
  return [
    `${record.label}: ${state}${pid !== undefined ? ` (pid ${pid})` : ""}, watching ${record.url} since ${record.installedAt}`,
    `last flag: ${lastFlag ?? "none yet"}`,
    "recent log:",
    ...log.slice(-20).map(line => `  ${line}`),
  ];
}
