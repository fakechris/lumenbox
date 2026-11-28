#!/usr/bin/env node
/**
 * A new user's first run, on the published artifacts (INV-1447).
 *
 * The releases that broke for new people broke on the first run, never in the suite: installers
 * missing their dependencies (0.3.0), an app published before its image tag, an image with no
 * engines (0.3.7), a person with no Docker told nothing they could act on. release:check and the
 * smoke test each see one part. This walks the whole path the way a person does, on what they
 * download: the release DMG from GitHub, checked against SHA256SUMS, the app copied out of it and
 * launched; then, through the window itself (Chrome DevTools Protocol), the Settings key, Start the
 * box — a real pull if the image is not on this machine — the green dot, and a first message
 * answered by the first agent. Every step is timed and photographed.
 *
 * It never touches what already runs on the machine. The app gets its own AGENTBOX_HOME, port,
 * user-data dir and box container (with its own volumes and network); its environment is built
 * from nothing, so no key or AGENTBOX_* setting from the operator's shell leaks in — the key is
 * typed into Settings like a person would, read from the variable named by --key-env, and never
 * written anywhere. Nothing is deleted: the run ends by listing what it created, and `--cleanup`
 * removes exactly that list, only with `--yes` after a person has read it.
 *
 *   node scripts/onboarding-e2e.mjs --version 0.3.8 [--phases nodocker,full] [--provider minimax]
 *        [--key-env MINIMAX_API_KEY] [--port 7796] [--cdp-port 9341] [--run-dir DIR] [--dmg FILE]
 *        [--box-timeout-min 40] [--reply-timeout-min 6] [--allow-unnotarized]
 *   node scripts/onboarding-e2e.mjs --version 0.4.12 --dmg FILE --sums FILE --upgrade-from 0.4.11 [--downgrade-check]
 *        [--from-dmg FILE --from-sums FILE] …
 *   node scripts/onboarding-e2e.mjs --cleanup DIR [--yes] [--remove-image]
 *
 * `--upgrade-from` walks an upgrade instead of a first run: the previous release used, then the
 * candidate (`--version`, `--dmg`) started on what it wrote (scripts/onboarding-upgrade.mjs, INV-2209).
 *
 * Runbook: docs/86-onboarding-acceptance.md.
 */

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readlinkSync, realpathSync, statfsSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { assess } from "./notarization.mjs";
import { compareVersions, phaseUpgrade, requiredFreeGb } from "./onboarding-upgrade.mjs";

export const REPO = "fakechris/lumenbox";
export const IMAGE_REPO = "fakechris/lumenbox";

// ── pure parts (tested) ───────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const out = { phases: ["nodocker", "full"], provider: "minimax", port: 7796, cdpPort: 9341, boxTimeoutMin: 40, replyTimeoutMin: 6, yes: false, removeImage: false, allowUnnotarized: false, downgradeCheck: false };
  let phasesGiven = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };
    switch (arg) {
      case "--version": out.version = next(); break;
      case "--phases": out.phases = next().split(",").map(p => p.trim()).filter(Boolean); phasesGiven = true; break;
      case "--upgrade-from": out.upgradeFrom = next(); break;
      case "--downgrade-check": out.downgradeCheck = true; break;
      case "--from-dmg": out.fromDmg = next(); break;
      case "--from-sums": out.fromSums = next(); break;
      case "--provider": out.provider = next(); break;
      case "--key-env": out.keyEnv = next(); break;
      case "--port": out.port = Number(next()); break;
      case "--cdp-port": out.cdpPort = Number(next()); break;
      case "--run-dir": out.runDir = next(); break;
      case "--dmg": out.dmg = next(); break;
      case "--sums": out.sums = next(); break;
      case "--box-timeout-min": out.boxTimeoutMin = Number(next()); break;
      case "--reply-timeout-min": out.replyTimeoutMin = Number(next()); break;
      case "--cleanup": out.cleanup = next(); break;
      case "--yes": out.yes = true; break;
      case "--remove-image": out.removeImage = true; break;
      case "--allow-unnotarized": out.allowUnnotarized = true; break;
      default: throw new Error(`unknown argument ${arg}`);
    }
  }
  if (out.cleanup === undefined) {
    if (!/^\d+\.\d+\.\d+$/.test(out.version ?? "")) throw new Error("--version X.Y.Z is required");
    for (const phase of out.phases) if (!["nodocker", "full"].includes(phase)) throw new Error(`unknown phase ${phase}`);
    for (const [name, value] of [["--port", out.port], ["--cdp-port", out.cdpPort]]) if (!Number.isInteger(value) || value < 1024 || value > 65535) throw new Error(`${name} must be a port above 1023`);
    if (out.port === 7777) throw new Error("--port 7777 is the default app's port; pick another so a running LumenBox is never touched");
    if ((out.fromDmg !== undefined || out.fromSums !== undefined) && out.upgradeFrom === undefined) throw new Error("--from-dmg / --from-sums are the previous release's; they need --upgrade-from");
    if (out.downgradeCheck && out.upgradeFrom === undefined) throw new Error("--downgrade-check starts the previous app on the upgraded home; it needs --upgrade-from");
    if (out.upgradeFrom !== undefined) {
      if (!/^\d+\.\d+\.\d+$/.test(out.upgradeFrom)) throw new Error("--upgrade-from X.Y.Z names the previous release");
      if (phasesGiven) throw new Error("--upgrade-from walks its own phases (previous, candidate); leave out --phases");
      const order = compareVersions(out.upgradeFrom, out.version);
      if (order > 0) throw new Error(`--upgrade-from ${out.upgradeFrom} is newer than --version ${out.version}; that is a downgrade`);
      if (order === 0 && out.dmg === undefined) throw new Error(`--upgrade-from ${out.upgradeFrom} is the published ${out.version}; an upgrade to the same release needs a candidate --dmg`);
      out.phases = ["upgrade"];
    }
  }
  return out;
}

/** The DMG a person on this architecture downloads. */
export function dmgName(version, arch) {
  return arch === "arm64" ? `LumenBox-${version}-arm64.dmg` : `LumenBox-${version}.dmg`;
}

/** The digest SHA256SUMS lists for a file, or undefined. */
export function expectedDigest(sums, file) {
  for (const line of sums.split("\n")) {
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim());
    if (match && match[2] === file) return match[1];
  }
  return undefined;
}

/** Everything a run's box creates, named from its container; what --cleanup may remove. */
export function boxResources(container) {
  return { container, volumes: [`${container}-work`, `${container}-config`], network: `${container}-net` };
}

/**
 * The app's environment, built from nothing: what a freshly logged-in person's GUI session has,
 * plus the isolation. No provider key, no AGENTBOX_* from the operator's shell.
 */
export function cleanEnv(base, extra) {
  const keep = ["HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "PATH"];
  const env = {};
  for (const name of keep) if (base[name] !== undefined) env[name] = base[name];
  env.PATH = [env.PATH ?? "", "/usr/local/bin", "/opt/homebrew/bin"].filter(Boolean).join(":");
  return { ...env, ...extra };
}

/**
 * What an app the run starts is given: the clean environment, its own home, box container and
 * port, and its own logs directory — the shell otherwise writes server.log, supervision.log and
 * memguard.log into ~/Library/Logs/LumenBox, the owner's, and can rotate the owner's server.log.1
 * away (INV-2307). `where`: `{ home, logs, container, port }` (no port for a server given --port).
 */
export function appEnv(base, where, extra = {}) {
  return cleanEnv(base, { AGENTBOX_HOME: where.home, LUMENBOX_LOGS_DIR: where.logs, AGENTBOX_CONTAINER: where.container, ...(where.port !== undefined ? { LUMENBOX_PORT: String(where.port) } : {}), ...extra });
}

/** What changed among containers that existed before the run: anything removed or restarted. */
export function disturbed(before, after) {
  const now = new Map(after.map(c => [c.name, c]));
  return before.filter(c => now.get(c.name)?.id !== c.id || now.get(c.name)?.startedAt !== c.startedAt).map(c => c.name);
}

/** The apps a run installs, which only it starts: the candidate in the run directory, the previous release (an upgrade run) in `previous/`. */
export function runBundles(dir) {
  return [join(dir, "LumenBox.app"), join(dir, "previous", "LumenBox.app")];
}

/**
 * Whether a process the manifest recorded may be stopped (INV-2306). The run stopped its apps
 * itself, so by the time a person runs --cleanup the number may belong to anything they run — the
 * real LumenBox included. Only a process that is provably the run's own is signalled: its
 * executable inside one of the run's own bundles, and, when the run recorded when it started the
 * process and the start time can be read, started no later than that (a later start is the number
 * reused). The executable is the proof; the time only ever refuses.
 * `entry`: `{ pid, startedAt }` as the run records it, or a bare PID (a manifest written before INV-2306).
 * `now`: `{ executable, startedAt }` (ms) of whatever holds that PID now; undefined when nothing does.
 */
export function ownProcess(entry, now, bundles) {
  const pid = typeof entry === "number" ? entry : entry?.pid;
  const recordedAt = typeof entry === "object" && entry?.startedAt !== undefined ? Date.parse(entry.startedAt) : undefined;
  if (now === undefined) return { pid, stop: false, why: "no longer running" };
  if (now.executable === undefined) return { pid, stop: false, why: "not ours, left alone: what it runs could not be read" };
  if (!bundles.some(bundle => now.executable.startsWith(`${bundle}/`))) return { pid, stop: false, why: `not ours, left alone: it runs ${now.executable}, outside this run's apps` };
  if (recordedAt !== undefined && now.startedAt !== undefined && now.startedAt > recordedAt) {
    return { pid, stop: false, why: `not ours, left alone: it started ${new Date(now.startedAt).toISOString()}, after the run recorded it` };
  }
  const unknown = recordedAt !== undefined && now.startedAt === undefined ? "; its start time could not be read, so the executable alone decides" : "";
  return { pid, stop: true, why: `this run's app (${now.executable})${unknown}; stopped with --yes` };
}

/** One line per step for the report; a step passes or says why not. */
export function summarize(steps) {
  const failed = steps.filter(step => step.status === "fail");
  return { passed: failed.length === 0 && steps.length > 0, failed: failed.map(step => step.name) };
}

// ── machine parts ─────────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

function sh(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options }).trim();
}

function shOk(command, args) {
  try {
    sh(command, args);
    return true;
  } catch {
    return false;
  }
}

/** Every container on the machine (any state) with its id and start time; [] when Docker is not running. */
function containers() {
  try {
    const ids = sh("docker", ["ps", "-aq"]).split("\n").filter(Boolean);
    if (ids.length === 0) return [];
    return JSON.parse(sh("docker", ["inspect", ...ids])).map(c => ({ name: c.Name.replace(/^\//, ""), id: c.Id, startedAt: c.State.StartedAt }));
  } catch {
    return [];
  }
}

/** Processes whose command line runs from this bundle; never this script itself. */
function processesOf(bundle) {
  try {
    return sh("pgrep", ["-f", bundle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")]).split("\n").map(Number).filter(pid => pid > 0 && pid !== process.pid);
  } catch {
    return [];
  }
}

/** What holds a PID now: the executable the kernel ran (not argv[0], which a process sets itself) and when it started; undefined when nothing does. */
function processNow(pid) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code !== "EPERM") return undefined;
  }
  // ps is setuid on macOS, and a sandbox (the test suite's) refuses to run it: then the start time is unknown.
  let startedAt;
  try {
    startedAt = Date.parse(sh("ps", ["-o", "lstart=", "-p", String(pid)], { env: { ...process.env, LC_ALL: "C" } }));
  } catch {}
  let executable;
  try {
    executable = process.platform === "linux" ? readlinkSync(`/proc/${pid}/exe`) : sh("lsof", ["-a", "-p", String(pid), "-d", "txt", "-Fn"]).split("\n").find(line => line.startsWith("n"))?.slice(1);
  } catch {}
  return { executable, startedAt: Number.isNaN(startedAt) ? undefined : startedAt };
}

function portInUse(port) {
  return new Promise(done => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => { socket.destroy(); done(true); });
    socket.once("error", () => done(false));
    socket.setTimeout(1500, () => { socket.destroy(); done(false); });
  });
}

class Run {
  constructor(options) {
    this.options = options;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    this.dir = resolve(options.runDir ?? join(homedir(), "lumenbox-onboarding", `${options.upgradeFrom !== undefined ? `${options.upgradeFrom}-to-` : ""}${options.version}-${stamp}`));
    this.container = `lumenbox-onboard-${stamp.slice(5, 16).replace(/[-T]/g, "").toLowerCase()}`;
    this.steps = [];
    this.manifest = { createdAt: new Date().toISOString(), version: options.version, runDir: this.dir, box: boxResources(this.container), image: `${IMAGE_REPO}:${options.version}`, imageWasCached: undefined, appProcesses: [], logs: [], ...(options.upgradeFrom !== undefined ? { upgradeFrom: options.upgradeFrom, previousImage: `${IMAGE_REPO}:${options.upgradeFrom}`, previousImageWasCached: undefined } : {}) };
  }

  async step(name, fn) {
    const started = Date.now();
    process.stdout.write(`… ${name}\n`);
    try {
      const detail = (await fn()) ?? "";
      this.steps.push({ name, status: "pass", ms: Date.now() - started, detail: String(detail) });
      process.stdout.write(`✔ ${name} (${((Date.now() - started) / 1000).toFixed(1)}s) ${detail}\n`);
      return true;
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      this.steps.push({ name, status: "fail", ms: Date.now() - started, detail: why });
      process.stdout.write(`✘ ${name}: ${why}\n`);
      return false;
    }
  }

  /** A logs directory an app of the run was given, for the report. */
  recordLogs(dir) {
    if (!this.manifest.logs.includes(dir)) this.manifest.logs.push(dir);
  }

  /** A process the run started, with when, so --cleanup can tell it from a later holder of the number. */
  recordProcess(pid) {
    if (pid !== undefined) this.manifest.appProcesses.push({ pid, startedAt: new Date().toISOString() });
  }

  note(name, detail) {
    this.steps.push({ name, status: "note", ms: 0, detail });
    process.stdout.write(`• ${name}: ${detail}\n`);
  }

  save() {
    writeFileSync(join(this.dir, "manifest.json"), JSON.stringify(this.manifest, null, 2));
    const summary = summarize(this.steps);
    writeFileSync(join(this.dir, "report.json"), JSON.stringify({ ...summary, version: this.options.version, logs: this.manifest.logs, steps: this.steps }, null, 2));
    const md = [
      `# ${this.options.upgradeFrom !== undefined ? `Upgrade acceptance — LumenBox ${this.options.upgradeFrom} → ${this.options.version}` : `Onboarding acceptance — LumenBox ${this.options.version}`}`,
      "",
      `Machine: ${sh("sw_vers", ["-productVersion"])} ${sh("uname", ["-m"])} · run ${this.dir}`,
      `Result: **${summary.passed ? "PASS" : `FAIL (${summary.failed.join(", ")})`}**`,
      "",
      "| step | result | time | detail |",
      "|---|---|---|---|",
      ...this.steps.map(s => `| ${s.name} | ${s.status} | ${(s.ms / 1000).toFixed(1)}s | ${s.detail.replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 300)} |`),
      "",
      "Created (nothing was deleted; see the runbook before running --cleanup):",
      `- box container ${this.manifest.box.container}, volumes ${this.manifest.box.volumes.join(", ")}, network ${this.manifest.box.network}`,
      `- image ${this.manifest.image} (${this.manifest.imageWasCached ? "was already on this machine" : "pulled by this run"})`,
      ...(this.manifest.previousImage !== undefined && this.manifest.previousImage !== this.manifest.image ? [`- image ${this.manifest.previousImage} (${this.manifest.previousImageWasCached ? "was already on this machine" : "pulled by this run"})`] : []),
      `- run directory ${this.dir}`,
      "",
      `Logs of the apps it started (server.log, supervision.log, memguard.log): ${this.manifest.logs.length === 0 ? "none started" : this.manifest.logs.join(", ")}`,
    ].join("\n");
    writeFileSync(join(this.dir, "report.md"), `${md}\n`);
    return summary;
  }
}

/** A launched app and the window's DevTools session. */
class App {
  /** `where`: which installed app (`appRoot`, default the run dir) and, for an upgrade, the home and user-data it shares with another. */
  constructor(run, phase, extraEnv, where = {}) {
    this.run = run;
    this.phase = phase;
    this.extraEnv = extraEnv;
    this.appRoot = where.appRoot ?? run.dir;
    this.home = where.home ?? join(run.dir, phase, "home");
    this.userData = where.userData ?? join(run.dir, phase, "user-data");
    this.logs = join(run.dir, phase, "logs");
    mkdirSync(this.home, { recursive: true });
    mkdirSync(this.userData, { recursive: true });
    mkdirSync(join(run.dir, phase), { recursive: true });
  }

  start() {
    const { options } = this.run;
    const binary = join(this.appRoot, "LumenBox.app", "Contents", "MacOS", "LumenBox");
    const env = appEnv(process.env, { home: this.home, logs: this.logs, container: this.run.container, port: options.port }, this.extraEnv);
    this.run.recordLogs(this.logs);
    const log = join(this.run.dir, this.phase, "app.log");
    this.child = spawn(binary, [`--user-data-dir=${this.userData}`, `--remote-debugging-port=${options.cdpPort}`], { env, stdio: ["ignore", "pipe", "pipe"], detached: false });
    this.run.recordProcess(this.child.pid);
    const out = [];
    this.child.stdout.on("data", chunk => out.push(chunk));
    this.child.stderr.on("data", chunk => out.push(chunk));
    this.child.on("exit", () => writeFileSync(log, Buffer.concat(out)));
    this.flushLog = () => writeFileSync(log, Buffer.concat(out));
    this.output = () => Buffer.concat(out).toString("utf8");
  }

  token() {
    const file = join(this.home, "ui-token");
    return existsSync(file) ? readFileSync(file, "utf8").trim() : undefined;
  }

  async api(path, init = {}) {
    const token = this.token();
    const response = await fetch(`http://127.0.0.1:${this.run.options.port}${path}`, { ...init, headers: { ...(init.headers ?? {}), ...(token ? { authorization: `Bearer ${token}` } : {}) } });
    if (!response.ok) throw new Error(`${path} answered ${response.status}${await response.json().then(body => (body?.error ? `: ${String(body.error).slice(0, 200)}` : ""), () => "")}`);
    return response.json();
  }

  async waitFor(what, test, timeoutMs, everyMs = 1000) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      try {
        const value = await test();
        if (value) return value;
      } catch (error) {
        last = error;
      }
      await sleep(everyMs);
    }
    throw new Error(`timed out waiting for ${what}${last ? ` (last: ${last.message})` : ""}`);
  }

  /**
   * A new machine is first asked what it is for (the shell's own page, before any server runs). A
   * person setting up their own computer picks "personal" and continues; so does this.
   */
  async firstRun() {
    const target = await this.waitFor("the first window", async () => {
      const list = await (await fetch(`http://127.0.0.1:${this.run.options.cdpPort}/json`)).json();
      return list.find(t => t.type === "page" && (t.url.startsWith("data:text/html") || t.url.startsWith(`http://127.0.0.1:${this.run.options.port}`)));
    }, 120_000);
    if (!target.url.startsWith("data:text/html")) return "no question asked";
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((ok, fail) => { ws.addEventListener("open", ok); ws.addEventListener("error", fail); });
    const expression = "(function(){ var r = document.querySelector('input[name=use][value=personal]'); if (!r) return 'no personal choice on the page'; r.checked = true; document.getElementById('go').click(); return 'personal chosen'; })()";
    const answer = await new Promise(done => {
      ws.addEventListener("message", event => { const message = JSON.parse(event.data); if (message.id === 1) done(message.result?.result?.value); });
      ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
    });
    ws.close();
    if (answer !== "personal chosen") throw new Error(`the first-run question could not be answered: ${answer}`);
    return answer;
  }

  async connect() {
    const targets = await this.waitFor("the app window", async () => {
      const list = await (await fetch(`http://127.0.0.1:${this.run.options.cdpPort}/json`)).json();
      return list.find(t => t.type === "page" && t.url.startsWith(`http://127.0.0.1:${this.run.options.port}`));
    }, 120_000);
    this.ws = new WebSocket(targets.webSocketDebuggerUrl);
    await new Promise((ok, fail) => { this.ws.addEventListener("open", ok); this.ws.addEventListener("error", fail); });
    this.nextId = 0;
    this.pending = new Map();
    this.ws.addEventListener("message", event => {
      const message = JSON.parse(event.data);
      const waiter = this.pending.get(message.id);
      if (waiter) { this.pending.delete(message.id); waiter(message); }
    });
    await this.send("Page.enable");
  }

  send(method, params = {}) {
    return new Promise(done => {
      this.nextId += 1;
      this.pending.set(this.nextId, done);
      this.ws.send(JSON.stringify({ id: this.nextId, method, params }));
    });
  }

  /** Evaluates an expression in the app window over DevTools (Runtime.evaluate); throws with the page's own error. */
  async inPage(expression) {
    const answer = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    const result = answer.result;
    if (result?.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result?.result?.value;
  }

  /** Opens Settings on a tab and waits until the dialog has loaded the saved config (it fills itself after a fetch). */
  async openSettings(tab) {
    await this.inPage(`openSettingsPane(${JSON.stringify(tab)}), true`);
    await this.waitFor(`Settings → ${tab}`, () => this.inPage("document.querySelectorAll('#view section.setting').length > 0 && (document.getElementById('set-provider') === null || document.getElementById('set-provider').options.length > 0)"), 30_000, 500);
  }

  async shot(name) {
    const answer = await this.send("Page.captureScreenshot", { format: "png" });
    const file = join(this.run.dir, "shots", `${this.phase}-${name}.png`);
    mkdirSync(join(this.run.dir, "shots"), { recursive: true });
    writeFileSync(file, Buffer.from(answer.result.data, "base64"));
    return file;
  }

  async stop() {
    try { this.ws?.close(); } catch {}
    if (this.child && this.child.exitCode === null) {
      this.child.kill("SIGTERM");
      for (let i = 0; i < 30 && this.child.exitCode === null; i += 1) await sleep(500);
      if (this.child.exitCode === null) this.child.kill("SIGKILL");
    }
    this.flushLog?.();
    // The shell's server is its own process. An upgrade starts the next app on the same port, so
    // what this app left running is stopped — only processes of this run's own installed app.
    const bundle = join(this.appRoot, "LumenBox.app", "Contents");
    for (let i = 0; i < 20; i += 1) {
      const left = processesOf(bundle);
      if (left.length === 0) break;
      for (const pid of left) { try { process.kill(pid, i < 10 ? "SIGTERM" : "SIGKILL"); } catch {} }
      await sleep(500);
    }
  }
}

async function preflight(run) {
  const { options } = run;
  await run.step("preflight", async () => {
    if (process.platform !== "darwin") throw new Error("macOS only: this installs the macOS app");
    if (existsSync(run.dir)) throw new Error(`${run.dir} already exists; pass a new --run-dir`);
    for (const port of [options.port, options.cdpPort]) if (await portInUse(port)) throw new Error(`port ${port} is in use; pick another`);
    if (shOk("docker", ["inspect", run.container])) throw new Error(`a container named ${run.container} exists`);
    if (options.phases.includes("full") || options.phases.includes("upgrade")) {
      if (options.keyEnv === undefined) throw new Error("--key-env names the variable holding the provider key the run types into Settings");
      if ((process.env[options.keyEnv] ?? "").trim() === "") throw new Error(`${options.keyEnv} is empty in this shell`);
    }
    mkdirSync(run.dir, { recursive: true });
    const free = statfsSync(run.dir);
    const freeGb = (free.bavail * free.bsize) / 1e9;
    const needGb = requiredFreeGb(options);
    if (freeGb < needGb) throw new Error(`only ${freeGb.toFixed(1)} GB free; ${options.upgradeFrom !== undefined ? `an upgrade run holds two apps, the home's copies and maybe a second image: ${needGb} GB` : "a first pull needs about 4 GB plus room"}`);
    run.before = containers();
    run.manifest.containersBefore = run.before.map(c => c.name);
    run.manifest.imageWasCached = shOk("docker", ["image", "inspect", run.manifest.image]);
    if (run.manifest.previousImage !== undefined) run.manifest.previousImageWasCached = shOk("docker", ["image", "inspect", run.manifest.previousImage]);
    return `${freeGb.toFixed(0)} GB free; ${run.manifest.image} ${run.manifest.imageWasCached ? "IS already on this machine — the pull will not be a first pull" : "is not on this machine — Start the box pulls it"}`;
  });
}

/**
 * Downloads (or takes `--dmg`), checks against SHA256SUMS and installs one release into `into`.
 * `which`: `{ version, dmg, sums, into, label }` — the label prefixes the step names ("previous: download").
 */
async function fetchArtifacts(run, which = { version: run.options.version, dmg: run.options.dmg, sums: run.options.sums, into: run.dir, label: "" }) {
  const { options } = run;
  const { version, into } = which;
  const named = step => (which.label ? `${which.label}: ${step}` : step);
  mkdirSync(into, { recursive: true });
  const arch = sh("uname", ["-m"]) === "arm64" ? "arm64" : "x64";
  const dmg = which.dmg ? resolve(which.dmg) : join(into, dmgName(version, arch));
  if (!(await run.step(named("download"), async () => {
    const base = `https://github.com/${REPO}/releases/download/v${version}`;
    // Before publishing there are no published sums: --sums FILE checks a candidate DMG against the ones about to be published.
    if (which.sums) writeFileSync(join(into, "SHA256SUMS"), readFileSync(resolve(which.sums)));
    else sh("curl", ["-fsSL", "--retry", "3", "-o", join(into, "SHA256SUMS"), `${base}/SHA256SUMS`]);
    if (!which.dmg) sh("curl", ["-fsSL", "--retry", "3", "-o", dmg, `${base}/${dmgName(version, arch)}`], { timeout: 1_800_000 });
    const want = expectedDigest(readFileSync(join(into, "SHA256SUMS"), "utf8"), dmgName(version, arch));
    if (want === undefined) throw new Error(`SHA256SUMS does not list ${dmgName(version, arch)}`);
    const got = createHash("sha256").update(readFileSync(dmg)).digest("hex");
    if (got !== want) throw new Error(`${dmgName(version, arch)} sha256 ${got} is not the published ${want}`);
    return `${dmgName(version, arch)} matches SHA256SUMS`;
  }))) return false;
  if (!(await run.step(named("install"), async () => {
    const mount = join(into, "mnt");
    mkdirSync(mount, { recursive: true });
    sh("hdiutil", ["attach", dmg, "-nobrowse", "-readonly", "-mountpoint", mount]);
    try {
      sh("ditto", [join(mount, "LumenBox.app"), join(into, "LumenBox.app")]);
    } finally {
      sh("hdiutil", ["detach", mount]);
    }
    sh("codesign", ["--verify", "--deep", "--strict", join(into, "LumenBox.app")]);
    const stamped = JSON.parse(readFileSync(join(into, "LumenBox.app", "Contents", "Resources", "app", "package.json"), "utf8"));
    if (stamped.version !== version) throw new Error(`the app says ${stamped.version}, not ${version}`);
    return `signed; version ${stamped.version}, build ${stamped.buildCommit ?? "unknown"}`;
  }))) return false;
  // A browser download is quarantined, and Gatekeeper opens it only if Apple notarized it
  // (INV-1450); stapled, so it opens offline too. Releases through 0.3.8 were not.
  const verdicts = [["dmg", dmg], ["app", join(into, "LumenBox.app")]].map(([kind, path]) => [kind, assess({ kind, path })]);
  const refused = verdicts.filter(([, v]) => !v.ok).map(([kind, v]) => `${kind}: ${v.problems.join("; ")}`);
  if (options.allowUnnotarized) {
    run.note(named("gatekeeper"), refused.length === 0 ? "dmg and app notarized and stapled" : `${refused.join(" · ")} — allowed by --allow-unnotarized; a browser download of this release is blocked on first open`);
  } else {
    await run.step(named("gatekeeper opens a downloaded copy"), async () => {
      if (refused.length > 0) throw new Error(`${refused.join(" · ")}. A browser download is blocked on first open (pass --allow-unnotarized to check a release from before notarization)`);
      return "dmg and app notarized and stapled";
    });
  }
  return true;
}

async function phaseNoDocker(run) {
  const app = new App(run, "nodocker", { DOCKER_HOST: "unix:///nonexistent/onboarding-e2e.sock" });
  try {
    app.start();
    await run.step("nodocker: app starts", async () => {
      await app.firstRun();
      await app.waitFor("the server", async () => (await app.api("/api/setup")) !== undefined, 120_000);
      await app.connect();
      await app.shot("01-first-launch");
      return "server answers, window open";
    });
    await run.step("nodocker: Settings says what to do", async () => {
      const state = await app.waitFor("a docker diagnosis", async () => (await app.api("/api/state")).box?.docker, 60_000);
      // The rebuilt page says it beside the agents, where the silence is: the notice above the list.
      const text = await app.waitFor("the box notice", () => app.inPage("(function(){ var n = document.getElementById('box-notice'); return n && !n.hidden && n.innerText.length > 0 ? n.innerText : undefined; })()"), 30_000);
      await app.shot("02-box-without-docker");
      if (state.state !== "no-engine") throw new Error(`diagnosis is ${state.state}, expected no-engine`);
      if (!/docker|orbstack/i.test(text ?? "")) throw new Error(`the Box section does not mention Docker: "${text}"`);
      return `no-engine; Box says: ${(text ?? "").replace(/\s+/g, " ").slice(0, 160)}`;
    });
  } finally {
    await app.stop();
  }
}

async function phaseFull(run) {
  const app = new App(run, "full", {});
  try {
    app.start();
    await firstUse(run, app, "full");
  } finally {
    await app.stop();
  }
}

/**
 * A new person's first use, on a started app: set-up card, key in Settings, Start the box, the
 * notice gone, a first reply. Step names begin with `label`. True when every step passed; the
 * app is left running for whatever comes next.
 */
async function firstUse(run, app, label) {
  const { options } = run;
  if (!(await run.step(`${label}: first launch shows the set-up card`, async () => {
    await app.firstRun();
    await app.waitFor("the server", async () => (await app.api("/api/setup")) !== undefined, 120_000);
    await app.connect();
    const setup = await app.api("/api/setup");
    const visible = await app.waitFor("the set-up card", () => app.inPage("document.querySelectorAll('#view .card-plain .setup-step').length > 0"), 30_000);
    await app.shot("01-first-launch");
    if (setup.key || setup.box) throw new Error(`a fresh home already has ${setup.key ? "a key" : ""} ${setup.box ? "a box" : ""}`);
    return `card shown (${visible}); key=${setup.key} box=${setup.box}`;
  }))) return false;
  if (!(await run.step(`${label}: key saved in Settings`, async () => {
    const key = process.env[options.keyEnv];
    await app.openSettings("model");
    const chosen = await app.inPage(`(function(){ var p = document.getElementById('set-provider'); p.value = ${JSON.stringify(options.provider)}; p.dispatchEvent(new Event('change')); return p.value; })()`);
    if (chosen !== options.provider) throw new Error(`Settings has no provider ${options.provider}`);
    await app.inPage(`(function(){ var k = document.getElementById('set-key'); k.value = ${JSON.stringify(key)}; k.dispatchEvent(new Event('input')); return true; })()`);
    await app.inPage("document.getElementById('set-save').click(), true");
    await app.waitFor("the key to count", async () => (await app.api("/api/setup")).key === true, 30_000);
    await app.shot("02-key-saved");
    // The pane is redrawn from what the server holds: the key field comes back empty, which is checked rather than done.
    const leftBehind = await app.waitFor("the key field to be cleared", () => app.inPage("(function(){ var k = document.getElementById('set-key'); return k && k.value === '' ? 'cleared' : undefined; })()"), 15_000);
    const status = (await app.inPage("(document.getElementById('set-note') || {}).innerText")) + " · key field " + leftBehind;
    return `provider ${options.provider}; ${(status ?? "").replace(/\s+/g, " ").slice(0, 120)}`;
  }))) return false;
  let pullSeconds;
  if (!(await run.step(`${label}: Start the box`, async () => {
    await app.inPage("openChat(Object.keys(next.agents)[0] || ''), true");
    await app.waitFor("the Start button", () => app.inPage("!!document.getElementById('box-start')"), 30_000);
    await app.shot("03-box-before-start");
    const started = Date.now();
    await app.inPage("document.getElementById('box-start').click(), true");
    let lastLog = "";
    try {
      await app.waitFor("the box to connect", async () => {
        lastLog = (await app.inPage("boxes.log.join(String.fromCharCode(10))")) || lastLog;
        return (await app.api("/api/state")).box?.ok === true;
      }, options.boxTimeoutMin * 60_000, 5000);
    } catch (error) {
      writeFileSync(join(run.dir, label, "box-start.log"), lastLog);
      await app.shot("04-box-failed");
      throw new Error(`${error.message}; the page shows: ${lastLog.trim().split("\n").pop()?.slice(0, 240) ?? ""}`);
    }
    pullSeconds = Math.round((Date.now() - started) / 1000);
    writeFileSync(join(run.dir, label, "box-start.log"), lastLog);
    await app.shot("04-box-started");
    const cached = label === "previous" ? run.manifest.previousImageWasCached : run.manifest.imageWasCached;
    return `connected after ${pullSeconds}s (${cached ? "image was cached" : "including the first pull"})`;
  }))) return false;
  if (!(await run.step(`${label}: green dot`, async () => {
    // The rebuilt page has no dot: a computer that is up says nothing, and the notice that it is not goes away.
    const dot = await app.waitFor("the box notice to go", () => app.inPage("document.getElementById('box-notice').hidden === true ? 'no notice: the box is up' : undefined"), 60_000);
    await app.shot("05-green-dot");
    return dot;
  }))) return false;
  if (!(await run.step(`${label}: first message answered`, async () => {
    const text = "你好，请用一句话介绍你自己。Hello — one sentence about yourself, please.";
    await app.inPage(`(function(){ var i = document.getElementById('composer-text'); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input')); document.getElementById('composer-send').click(); return true; })()`);
    const reply = await app.waitFor("a reply from the agent", async () => {
      const setup = await app.api("/api/setup");
      if (!setup.agentTurn) return undefined;
      // An agent's words are the bubbles of class "msg" in the thread (a person's are "msg-me").
      return app.inPage("(function(){ var all = document.querySelectorAll('#view .thread .msg'); var last = all[all.length - 1]; return last && last.innerText.trim().length > 0 ? last.innerText.trim() : undefined; })()");
    }, options.replyTimeoutMin * 60_000, 3000);
    await app.shot("06-first-reply");
    return `reply: ${reply.replace(/\s+/g, " ").slice(0, 160)}`;
  }))) return false;
  return true;
}

/**
 * Lists what a run created and, with `--yes`, removes it. `io` is the Docker side (`sh`, `shOk`)
 * and where the list goes (`log`); the processes are always the machine's own.
 */
export async function cleanup(options, io = {}) {
  const { sh: run = sh, shOk: ok = shOk, log = console.log } = io;
  const dir = resolve(options.cleanup);
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  const { container, volumes, network } = manifest.box;
  const bundles = runBundles(realpathSync(dir));
  const processes = () => (manifest.appProcesses ?? []).map(entry => ownProcess(entry, processNow(typeof entry === "number" ? entry : entry.pid), bundles));
  const list = [
    `container ${container}${ok("docker", ["inspect", container]) ? "" : " (absent)"}`,
    ...volumes.map(v => `volume    ${v}${ok("docker", ["volume", "inspect", v]) ? "" : " (absent)"}`),
    `network   ${network}${ok("docker", ["network", "inspect", network]) ? "" : " (absent)"}`,
    ...(options.removeImage ? [`image     ${manifest.image}${manifest.imageWasCached ? " — WAS ALREADY ON THIS MACHINE before the run; it is not this run's to remove" : ""}`] : []),
    ...(options.removeImage && manifest.previousImage !== undefined && manifest.previousImage !== manifest.image ? [`image     ${manifest.previousImage}${manifest.previousImageWasCached ? " — WAS ALREADY ON THIS MACHINE before the run; it is not this run's to remove" : ""}`] : []),
    ...processes().map(entry => `process   ${entry.pid} — ${entry.why}`),
    `directory ${dir}`,
  ];
  log(`This run created:\n  ${list.join("\n  ")}`);
  if (!options.yes) {
    log("\nNothing removed. A person reads the list above; then run again with --yes.");
    return 0;
  }
  if (!container.startsWith("lumenbox-onboard-")) throw new Error(`refusing: ${container} is not a name this script makes`);
  // Read again at the moment of the signal: the list may have been read hours ago.
  for (const entry of processes()) {
    if (!entry.stop) continue;
    try { process.kill(entry.pid, "SIGTERM"); log(`Stopped process ${entry.pid}.`); } catch {}
  }
  if (ok("docker", ["container", "inspect", container])) run("docker", ["stop", container]);
  if (ok("docker", ["container", "inspect", container])) run("docker", ["container", "rm", container]);
  for (const volume of volumes) if (ok("docker", ["volume", "inspect", volume])) run("docker", ["volume", "rm", volume]);
  if (ok("docker", ["network", "inspect", network])) run("docker", ["network", "rm", network]);
  if (options.removeImage && !manifest.imageWasCached) run("docker", ["image", "rm", manifest.image]);
  if (options.removeImage && manifest.previousImage !== undefined && manifest.previousImage !== manifest.image && !manifest.previousImageWasCached && ok("docker", ["image", "inspect", manifest.previousImage])) run("docker", ["image", "rm", manifest.previousImage]);
  log("Removed the run's box resources. The run directory is kept; delete it yourself once the report is filed.");
  return 0;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.cleanup !== undefined) return cleanup(options);
  const run = new Run(options);
  await preflight(run);
  if (run.steps.some(step => step.status === "fail")) {
    console.log("Preflight failed; nothing was started.");
    return 1;
  }
  try {
    // Both apps are fetched first, so a missing or tampered DMG fails before half an hour of use.
    const previousReady = options.upgradeFrom === undefined || (await fetchArtifacts(run, { version: options.upgradeFrom, dmg: options.fromDmg, sums: options.fromSums, into: join(run.dir, "previous"), label: "previous" }));
    // Gatekeeper refusing the download does not stop the walk: what happens after it is still worth knowing.
    if (previousReady && (await fetchArtifacts(run))) {
      if (options.phases.includes("nodocker")) await phaseNoDocker(run);
      if (options.phases.includes("full")) await phaseFull(run);
      if (options.phases.includes("upgrade")) await phaseUpgrade({ run, App, firstUse, sh, appEnv });
    }
  } finally {
    await run.step("nothing else touched", async () => {
      const changed = disturbed(run.before ?? [], containers());
      if (changed.length > 0) throw new Error(`containers that existed before the run were removed or restarted: ${changed.join(", ")}`);
      return `${(run.before ?? []).length} pre-existing containers unchanged`;
    });
    const summary = run.save();
    console.log(`\n${summary.passed ? "PASS" : `FAIL: ${summary.failed.join(", ")}`} — report ${join(run.dir, "report.md")}`);
    console.log(`Created and kept: container ${run.container} (+ volumes, network), run dir ${run.dir}. Clean up with --cleanup ${run.dir} after reading the list.`);
  }
  return summarize(run.steps).passed ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(code => process.exit(code), error => { console.error(error instanceof Error ? error.message : error); process.exit(2); });
}
