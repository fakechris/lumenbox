#!/usr/bin/env node
/**
 * agentbox CLI.
 */

import { createInterface } from "node:readline/promises";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";
import {
  BACKUP_CARRIES,
  BoxManager,
  defaultBoxConfig,
  loadBoxToken,
  resolveDockerHostAddress,
  uiToken,
  type BoxConfig,
  type BoxStatus,
} from "./box/docker.ts";
import { describeControlPlane, startControlPlane } from "./control/main.ts";
import { STARTER_TEAM } from "./host/orchestrator.ts";
import { randomUUID } from "node:crypto";
import { backupNow, backupRoot } from "./host/backup.ts";
import { describePreflight, isQuiet, preflight, verifyBox } from "./box/preflight.ts";
import { DockerBoxProvisioner } from "./box/provisioner.ts";
import { decideUpgrade } from "./host/upgrade.ts";
import { AgentRegistry, defaultAgentsRoot } from "./agents/registry.ts";
import { attachedBox } from "./box/boxes.ts";
import { startEgressRelay } from "./egress/relay.ts";
import { DEFAULT_DISPLAY_INDEX } from "./protocol/index.ts";
import { Orchestrator } from "./host/orchestrator.ts";
import type { TurnEvent } from "./host/turn.ts";
import type { BusEvent } from "./agents/bus.ts";
import {
  describeProvider,
  providerNames,
  resolveProvider,
  resolveSummaryProvider,
  createClient,
  type ProviderProfile,
} from "./host/provider.ts";
import { applyConfigEnv, ensureConfigFile, loadConfig } from "./config.ts";
import { describeAbsences } from "./host/absences.ts";
import { startWebServer } from "./web/server.ts";

const here = dirname(fileURLToPath(import.meta.url));

function agentboxHome(): string {
  return process.env.AGENTBOX_HOME ?? join(homedir(), ".agentbox");
}

function boxConfig(overrides: Partial<BoxConfig> = {}): BoxConfig {
  // The token comes from defaultBoxConfig, which every caller shares.
  return defaultBoxConfig(overrides);
}

const out = (line = "") => process.stdout.write(`${line}\n`);
const err = (line: string) => process.stderr.write(`${line}\n`);

function dim(text: string): string {
  return process.stdout.isTTY ? `\x1b[2m${text}\x1b[0m` : text;
}
function bold(text: string): string {
  return process.stdout.isTTY ? `\x1b[1m${text}\x1b[0m` : text;
}

// --- box commands ---------------------------------------------------------

async function cmdBoxBuild(): Promise<number> {
  const config = boxConfig();
  const manager = new BoxManager(config);

  // The bundle is built into the Docker context by `npm run build:boxd`.
  const context = resolve(here, "..", "docker", "box");
  const bundle = join(context, "boxd.cjs");
  if (!existsSync(bundle)) {
    err(
      `Daemon bundle missing at ${bundle}.\n` +
        "Run `npm run build:boxd` first — the image copies the bundle in."
    );
    return 1;
  }

  out(`Building ${config.image}. This takes a few minutes the first time.`);
  await manager.build(context, line => out(dim(line)));
  out("Done. Start it with `agentbox box up`.");
  return 0;
}

async function cmdBoxUp(argv: string[]): Promise<number> {
  // --with-host puts the orchestrator in the container: the production shape, where the
  // only thing outside the box is a browser. Without it the box is driven from here.
  const withHost = argv.includes("--with-host");
  const manager = new BoxManager(boxConfig({ withHost }));
  const recreate = argv.includes("--recreate");

  // Recreating destroys everything not on a volume, so it asks before it does — but only
  // when there is something to lose, because a confirmation that always appears is one
  // that is always dismissed.
  if (recreate && (await manager.state()) !== "missing") {
    const findings = await inspectBeforeUpgrade(manager);
    if (findings !== undefined) {
      out("");
      out(bold("Upgrading recreates the box. Before it does:"));
      out(findings);
      out("");
      if (!argv.includes("--yes")) {
        err("Re-run with --yes to go ahead, or deal with the above first.");
        return 1;
      }
      out(dim("--yes given; continuing."));
    }
    if (!argv.includes("--no-backup")) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const destination = join(backupRoot(), `${stamp}-volumes`);
      out(dim(`Backing up volumes to ${destination} …`));
      try {
        for (const file of await manager.backupVolumes(destination)) out(dim(`  ${file}`));
        out(dim(`  ${BACKUP_CARRIES}`));
      } catch (error) {
        // A failed backup stops the upgrade. The whole point of taking it here is that
        // the next step is the irreversible one.
        err(`Backup failed, so the box was not upgraded: ${error instanceof Error ? error.message : error}`);
        return 1;
      }
    }
  }

  let { status } = await manager.up({
    recreate,
    onOutput: line => out(dim(line)),
  });

  // Only after a recreate. A plain start returns the same container that was working a
  // moment ago, and rolling *that* back would be inventing a problem.
  if (recreate) {
    out(dim("checking the box that came back …"));
    const broken = await verifyBox(await manager.connect());
    if (broken !== undefined) {
      err("");
      err(`The upgraded box does not work: ${broken}`);
      const rolled = await rollBack(withHost, line => out(dim(line)));
      if (rolled === undefined) {
        err("");
        err(
          "There is no `agentbox/box:previous` to go back to, so the box has been left as " +
            "it is. Rebuild a working image and run `agentbox box up --recreate` again. " +
            "Your data is in the backup taken a moment ago."
        );
        return 1;
      }
      status = rolled;
      out("");
      out(bold("Rolled back to the previous image."));
      // Said plainly: a rollback that reports success looks like an upgrade that worked,
      // and the broken image is still what the next build starts from.
      out("The box is running the image it had before. The new one is still broken.");
    }
  }
  out("");
  out(`${bold("Box running")} (${status.containerName})`);
  if (status.boxdUrl) out(`  daemon:  ${status.boxdUrl}`);
  if (withHost) {
    out(`  web UI:  http://127.0.0.1:7777/?token=${uiToken()}`);
    out("");
    out("The orchestrator runs inside the box. Nothing here drives it.");
  } else {
    out("");
    out("Each agent gets its own desktop inside the box. Run `agentbox web` to see them.");
  }
  return 0;
}

/**
 * What the box would lose, as text, or undefined when it would lose nothing.
 *
 * Best-effort by design: a box too broken to answer is a box somebody may well be
 * upgrading in order to fix, and a preflight that refuses to look is not a reason to
 * block the repair.
 */
/**
 * Puts the box back on the image it had before, if there is one.
 *
 * `:previous` is moved by the image build rather than tracked here, so this needs no state
 * of its own — which matters, because the state would have to survive exactly the failure
 * it exists for.
 */
async function rollBack(
  withHost: boolean,
  onOutput: (line: string) => void
): Promise<BoxStatus | undefined> {
  const image = `${process.env.AGENTBOX_IMAGE_REPO ?? "agentbox/box"}:previous`;
  const manager = new BoxManager(boxConfig({ withHost, image }));
  if (!(await manager.imageExists())) return undefined;
  onOutput(`going back to ${image}`);
  const { status } = await manager.up({ recreate: true, onOutput });
  return status;
}

async function inspectBeforeUpgrade(manager: BoxManager): Promise<string | undefined> {
  try {
    const box = await manager.connect();
    const findings = await preflight(box);
    if (isQuiet(findings)) return undefined;
    return describePreflight(findings);
  } catch {
    return undefined;
  }
}

async function cmdBoxStatus(): Promise<number> {
  const manager = new BoxManager(boxConfig());

  if (!(await manager.dockerAvailable())) {
    err("Cannot reach a Docker engine. Check `docker version` and DOCKER_HOST.");
    return 1;
  }

  const status = await manager.status();
  out(`container: ${status.containerName}`);
  out(`state:     ${status.state}`);
  out(`engine:    ${process.env.DOCKER_HOST ?? "local"} (ports on ${resolveDockerHostAddress()})`);

  if (status.state !== "running") {
    out("");
    out("Start it with `agentbox box up`.");
    return 0;
  }

  out(`daemon:    ${status.boxdUrl ?? "port not published"}`);

  try {
    const client = await manager.connect();
    const health = await client.health();
    const size = health.resolution
      ? `${health.resolution.display.width}x${health.resolution.display.height}`
      : "no display detected";
    out(
      `health:    ok, display ${health.display} at ${size}, ` +
        `up ${health.uptime_seconds}s`
    );
    if (health.resolution) {
      out(
        `api space: ${health.resolution.api.width}x${health.resolution.api.height} ` +
          "(what the model sees)"
      );
    }
    const running = health.displays ?? [];
    out(
      `desktops:  ${running.length === 0 ? "none yet" : running.map(d => d.index).join(", ")}`
    );
  } catch (error) {
    out(`health:    ${error instanceof Error ? error.message : String(error)}`);
  }
  return 0;
}

async function cmdBoxDown(argv: string[]): Promise<number> {
  const manager = new BoxManager(boxConfig());
  await manager.down({ remove: argv.includes("--rm") });
  out(argv.includes("--rm") ? "Box stopped and removed." : "Box stopped.");
  return 0;
}

/**
 * Puts the box back on its previous image, for when it breaks later rather than during
 * the upgrade. The automatic rollback only covers the minutes right after one.
 */
/**
 * Decides whether to upgrade, and does it when the answer is yes.
 *
 * This is the unattended path: put it on a timer and it upgrades a box that nobody is
 * using, at the hour you chose, and refuses to touch one where somebody would lose
 * something. The judgement lives in decideUpgrade so it is testable; this only supplies
 * the situation and acts on the verdict.
 */
async function cmdBoxUpgrade(argv: string[]): Promise<number> {
  const withHost = argv.includes("--with-host");
  const manager = new BoxManager(boxConfig({ withHost }));

  const availability = await manager.upgradeAvailable();
  if (!availability.available) {
    out(`The box is already running the image on disk (${availability.built ?? "unknown"}).`);
    out(dim("Build a new one with `npm run build:image`."));
    return 0;
  }
  out(`An upgrade is available: ${availability.running} -> ${availability.built}`);

  // Both are best-effort. A box that cannot be reached is a box that is failing, which is
  // itself an answer — and the decision handles that case rather than crashing on it.
  let findings = { runningJobs: [], strayFiles: [], moreStrayFiles: false } as Awaited<
    ReturnType<typeof preflight>
  >;
  let failing: string | undefined;
  try {
    const box = await manager.connect();
    findings = await preflight(box);
    failing = await verifyBox(box);
  } catch (error) {
    failing = error instanceof Error ? error.message : String(error);
  }

  const config = loadConfig();
  const decision = decideUpgrade({
    preflight: findings,
    // Nobody is counted as watching from here: this command is the operator's, and the
    // web server is what knows who is connected. Announcing is its job, not this one's.
    watching: 0,
    ...(failing !== undefined ? { boxFailing: failing } : {}),
    ...(config.upgradeHour !== undefined ? { quietHour: config.upgradeHour } : {}),
    hour: new Date().getHours(),
  });

  out("");
  out(`${bold(decision.action)}: ${decision.why}`);
  if (decision.action === "ask") {
    out("");
    out(decision.detail);
    if (!argv.includes("--yes")) {
      out("");
      err("Not upgrading. Re-run with --yes once you have decided.");
      return 1;
    }
    out(dim("--yes given; continuing."));
  }
  if (decision.action === "wait" && !argv.includes("--yes")) return 0;

  out("");
  return cmdBoxUp([...argv, "--recreate", "--yes"]);
}

async function cmdBoxRollback(argv: string[]): Promise<number> {
  const withHost = argv.includes("--with-host");
  const status = await rollBack(withHost, line => out(dim(line)));
  if (status === undefined) {
    err("There is no `agentbox/box:previous` image, so there is nothing to go back to.");
    return 1;
  }
  out("");
  out(`${bold("Box running")} (${status.containerName}) on the previous image.`);
  out("Rebuild with `npm run build:image` when you have a fix; that moves :previous again.");
  return 0;
}

async function cmdBoxLogs(argv: string[]): Promise<number> {
  const manager = new BoxManager(boxConfig());
  const tailIndex = argv.indexOf("--tail");
  const tail = tailIndex >= 0 ? Number(argv[tailIndex + 1] ?? 200) : 200;
  out(await manager.logs(tail));
  return 0;
}

/**
 * The claim for a desktop, so a person is never locked out of their own box.
 *
 * Desktops are bound to the agent that owns them, and the box refuses input without the
 * matching token. Every token lives on this side, so the CLI can always produce the right
 * one — which is the point of keeping them out of the container.
 */
function ownerFor(displayIndex: number | undefined): string | undefined {
  if (displayIndex === undefined) return undefined;
  try {
    return new AgentRegistry().boxOwnerTokenForDisplay(displayIndex);
  } catch {
    return undefined;
  }
}

/** Which desktop a bare `box` command means: the default one, unless --display says. */
function displayArg(argv: string[]): number {
  const at = argv.indexOf("--display");
  const value = at >= 0 ? Number(argv[at + 1]) : NaN;
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_DISPLAY_INDEX;
}

async function cmdBoxShot(argv: string[]): Promise<number> {
  const target = argv.find(arg => !arg.startsWith("-")) ?? "box-screenshot.webp";
  const manager = new BoxManager(boxConfig());
  const client = await manager.connect();

  const display = displayArg(argv);
  const result = await client.computer([{ action: "screenshot" }], {
    display,
    owner: ownerFor(display),
  });
  if (!result.screenshot) {
    err("The box returned an empty screenshot.");
    return 1;
  }
  writeFileSync(target, Buffer.from(result.screenshot, "base64"));
  out(`Wrote ${target} (${result.duration_ms}ms).`);
  return 0;
}

async function cmdBoxExec(argv: string[]): Promise<number> {
  const command = argv.join(" ").trim();
  if (!command) {
    err("Usage: agentbox box exec <command>");
    return 1;
  }
  const manager = new BoxManager(boxConfig());
  const client = await manager.connect();
  const display = displayArg(argv);
  const result = await client.exec(command, {
    display,
    owner: ownerFor(display),
    actor: "console:box-run",
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.exit_code;
}

// --- agent commands -------------------------------------------------------

function cmdBackup(args: string[]): number {
  const to = args[0];
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const result = backupNow({ stamp, ...(to !== undefined ? { to } : {}) });
    out(`${result.files} files (${Math.round(result.bytes / 1024)}KB) -> ${result.path}`);
    // Said, because a backup that silently deleted the copy someone was relying on is worse than
    // no backup at all.
    if (result.pruned.length > 0) {
      out(dim(`pruned ${result.pruned.length} older: ${result.pruned.join(", ")}`));
    }
    out(dim("Taken without stopping anything: these files tolerate a torn last line, and so do"));
    out(dim("their readers — which is what a crash leaves behind too."));
    return 0;
  } catch (error) {
    err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function cmdAgents(): number {
  const registry = new AgentRegistry();
  const agents = registry.list();

  if (agents.length === 0) {
    out("No agents yet. `agentbox chat` creates a coordinator to start with,");
    out("or make one directly: agentbox agent new <name> <description>");
    return 0;
  }

  out(`${agents.length} agent(s) in ${registry.root}:`);
  out("");
  for (const agent of agents) {
    const title = agent.profile.title ? ` — ${agent.profile.title}` : "";
    const hidden = agent.profile.hidden ? dim(" (hidden)") : "";
    out(`${bold(agent.profile.name)}${title}${hidden}`);
    out(dim(`  id: ${agent.id}`));
    if (agent.profile.description) {
      const summary = agent.profile.description.replace(/\s+/g, " ").slice(0, 140);
      out(dim(`  ${summary}${agent.profile.description.length > 140 ? "..." : ""}`));
    }
    out("");
  }
  return 0;
}

function cmdAgentNew(argv: string[]): number {
  const [name, ...rest] = argv;
  if (!name) {
    err("Usage: agentbox agent new <name> [description]");
    return 1;
  }
  const registry = new AgentRegistry();
  const created = registry.create({ name, description: rest.join(" ") });
  out(`Created ${created.profile.name} (id: ${created.id})`);
  out(dim(`  ${created.dir}`));
  return 0;
}

// --- boxes (docs/30) ----------------------------------------------------------

/**
 * Through the running web server when there is one, so the box is connected at once and the
 * page shows it; straight into the registry otherwise, where the next start picks it up.
 */
async function viaWeb(path: string, body: unknown): Promise<Record<string, unknown> | undefined> {
  const base = process.env.AGENTBOX_WEB_URL ?? "http://127.0.0.1:7777";
  try {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${uiToken()}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    // A running server from before boxes were plural answers 404; the record is written for
    // its next start, the same as no server at all.
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(String(json.error ?? `web server answered ${response.status}`));
    return json;
  } catch (error) {
    if (error instanceof Error && /ECONNREFUSED|fetch failed|timeout/i.test(error.message)) return undefined;
    throw error;
  }
}

async function cmdBoxAttach(argv: string[]): Promise<number> {
  const [name, baseUrl, ...flagList] = argv;
  const { flags } = parseArgs(flagList);
  const tokenFile = flags.get("--token-file");
  if (!name || !baseUrl || typeof tokenFile !== "string") {
    err("Usage: agentbox box attach <name> <url> --token-file F [--display-floor N] [--work-dir D]");
    return 1;
  }
  const floor = flags.get("--display-floor");
  const workDir = flags.get("--work-dir");
  try {
    const record = attachedBox({
      name,
      baseUrl,
      tokenFile: resolve(tokenFile),
      ...(typeof floor === "string" ? { displayFloor: Number(floor) } : {}),
      ...(typeof workDir === "string" ? { workDir } : {}),
    });
    const replace = flags.get("--replace") === true;
    const payload = { name, baseUrl, tokenFile: resolve(tokenFile), ...(typeof floor === "string" ? { displayFloor: Number(floor) } : {}), ...(typeof workDir === "string" ? { workDir } : {}) };
    const live = await viaWeb(replace ? "/api/boxes/update" : "/api/boxes/attach", payload);
    if (live !== undefined) {
      out(`${bold(name)} ${replace ? "moved" : "attached"}${live.connected === true ? " and connected" : ""}: ${String(live.detail ?? "")}`);
      return 0;
    }
    const registry = new AgentRegistry();
    if (replace) {
      registry.updateBox(name, { endpoint: { baseUrl: record.endpoint!.baseUrl, tokenFile: record.endpoint!.tokenFile }, ...(typeof floor === "string" ? { displayFloor: Number(floor) } : {}) });
      out(`${bold(name)} moved to ${baseUrl}; the web server was not running, so it reconnects on the next start.`);
      return 0;
    }
    registry.attachBox(record);
    out(`${bold(name)} attached (${record.id}); the web server was not running, so it connects on the next start.`);
    return 0;
  } catch (error) {
    err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function cmdBoxDetach(argv: string[]): Promise<number> {
  const [name] = argv;
  if (!name) {
    err("Usage: agentbox box detach <name>");
    return 1;
  }
  try {
    const live = await viaWeb("/api/boxes/detach", { name });
    if (live === undefined) new AgentRegistry().detachBox(name);
    out(`${bold(name)} detached.`);
    return 0;
  } catch (error) {
    err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function cmdBoxList(): number {
  const registry = new AgentRegistry();
  for (const entry of registry.listBoxes()) {
    const residents = registry.agentsIn(entry.id).map(record => record.profile.name);
    const where = entry.kind === "docker" ? "docker (this machine)" : `attached ${entry.endpoint?.baseUrl ?? ""}`;
    out(`${bold(entry.name)}${entry.id === registry.box.id ? dim("  (own)") : ""}  ${dim(where)}  displays from :${entry.displayFloor}`);
    out(dim(`  ${residents.length === 0 ? "no agents" : residents.join(", ")}`));
  }
  return 0;
}

// --- templates (docs/29) ------------------------------------------------------

/**
 * Templates go through the running web server rather than a second orchestrator in this
 * process: importing starts a turn on a box that is already someone's, and two hosts on one
 * state directory is the collision docs/17 forbids. The token is the UI's own.
 */
async function cmdTemplate(argv: string[]): Promise<number> {
  const [sub, ...args] = argv;
  const base = process.env.AGENTBOX_WEB_URL ?? "http://127.0.0.1:7777";
  const headers = { "content-type": "application/json", authorization: `Bearer ${uiToken()}` };
  const call = async (path: string, body?: unknown): Promise<{ ok: boolean; status: number; json: Record<string, unknown>; text: string }> => {
    const response = await fetch(`${base}${path}`, body === undefined ? { headers } : { method: "POST", headers, body: JSON.stringify(body) });
    const text = await response.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // A download is not JSON; the caller reads `text`.
    }
    return { ok: response.ok, status: response.status, json, text };
  };
  const agentIdOf = async (nameOrId: string): Promise<string | undefined> => {
    const registry = new AgentRegistry();
    try {
      return registry.resolve(nameOrId).id;
    } catch {
      return undefined;
    }
  };
  try {
    if (sub === "import") {
      const [file, ...flags] = args;
      if (!file) {
        err("Usage: agentbox template import <file> [--name N]");
        return 1;
      }
      const nameAt = flags.indexOf("--name");
      const name = nameAt >= 0 ? flags[nameAt + 1] : undefined;
      const template = readFileSync(file, "utf8");
      const result = await call("/api/templates/import", { template, ...(name !== undefined ? { name } : {}) });
      if (!result.ok) {
        err(String(result.json.error ?? `import failed (${result.status})`));
        return 1;
      }
      out(`Created ${bold(String(result.json.name))} (id: ${String(result.json.id)}). It is installing its recipe now.`);
      const pending = result.json.pending as { fillIns?: { label: string }[]; connectors?: string[] } | undefined;
      const asks = [...(pending?.fillIns ?? []).map(fillIn => fillIn.label), ...(pending?.connectors ?? []).map(name => `${name} (not connected here)`)];
      if (asks.length > 0) out(dim(`  It will ask you for: ${asks.join("; ")}`));
      return 0;
    }
    if (sub === "share") {
      const [agent] = args;
      const id = agent === undefined ? undefined : await agentIdOf(agent);
      if (id === undefined) {
        err("Usage: agentbox template share <agent>");
        return 1;
      }
      const result = await call("/api/templates/share", { agent: id });
      if (!result.ok) {
        err(String(result.json.error ?? `share failed (${result.status})`));
        return 1;
      }
      out(`Asked ${bold(agent!)}: "${String(result.json.sent)}"`);
      out(dim(`  Watch the chat; when it has staged a version, run: agentbox template download ${agent}`));
      return 0;
    }
    if (sub === "download") {
      const [agent, ...flags] = args;
      const id = agent === undefined ? undefined : await agentIdOf(agent);
      if (id === undefined) {
        err("Usage: agentbox template download <agent> [-o file]");
        return 1;
      }
      const result = await call(`/api/templates/download?agent=${encodeURIComponent(id)}`);
      if (!result.ok) {
        err(String(result.json.error ?? `download failed (${result.status})`));
        return 1;
      }
      const outAt = flags.indexOf("-o");
      const target = outAt >= 0 && flags[outAt + 1] !== undefined ? flags[outAt + 1]! : `${agent}.lumenbox-template.json`;
      writeFileSync(target, result.text);
      out(`Saved ${bold(target)} (${result.text.length} bytes). Hand it to someone; they import it the same way.`);
      return 0;
    }
    err(`Unknown template command: ${sub ?? "(none)"}. One of: import, share, download.`);
    return 1;
  } catch (error) {
    err(`Could not reach the web server at ${base}: ${error instanceof Error ? error.message : String(error)}. Is \`agentbox web\` running?`);
    return 1;
  }
}

// --- chat -----------------------------------------------------------------

/** Renders turn and bus events as a readable transcript. */
function makeRenderer() {
  let streaming = false;
  let lastAgent = "";

  const endStream = () => {
    if (streaming) {
      process.stdout.write("\n");
      streaming = false;
    }
  };

  const onTurnEvent = (event: TurnEvent) => {
    switch (event.type) {
      case "text": {
        if (!streaming || lastAgent !== event.agentName) {
          endStream();
          process.stdout.write(`${bold(event.agentName)}: `);
          lastAgent = event.agentName;
          streaming = true;
        }
        process.stdout.write(event.delta);
        return;
      }
      case "tool_start": {
        endStream();
        const detail =
          event.tool === "bash"
            ? String((event.input as { command?: string }).command ?? "")
            : event.tool === "SendToAgent"
              ? String((event.input as { target_id?: string }).target_id ?? "")
              : "";
        out(dim(`  ${event.agentName} → ${event.tool}${detail ? ` ${detail}` : ""}`));
        return;
      }
      case "tool_end": {
        if (event.summary) out(dim(`    ${event.summary}`));
        return;
      }
      case "aborted": {
        endStream();
        out(dim("  (turn superseded by a priority message)"));
        return;
      }
      default:
        return;
    }
  };

  const onBusEvent = (event: BusEvent) => {
    if (event.type === "message_sent") {
      endStream();
      const flag = event.priority ? " (priority)" : "";
      out(dim(`  ✉ ${event.fromName} → ${event.toName}${flag}`));
    } else if (event.type === "turn_failed") {
      endStream();
      err(`  ! turn failed for ${event.agentId}: ${event.error}`);
    }
  };

  return { onTurnEvent, onBusEvent, endStream };
}

/** Flags that consume the following argument. */
/**
 * Flags that take a value.
 *
 * An allow-list rather than a rule, which means a flag missing from here does not fail — its value
 * silently becomes a positional and the flag reads as `true`. That has now cost time twice: once
 * when `web --host` was ignored and the published port reached nothing, and once when
 * `control up --sweep-seconds 5` printed "every 15s". Adding a value flag means adding it here.
 */
const VALUE_FLAGS = new Set(["--token-file", "--display-floor", "--work-dir", 
  "--provider",
  "--model",
  "--effort",
  "--port",
  "--host",
  "--token",
  "--allow",
  "--allocator",
  "--image",
  "--sweep-seconds",
  "--relay-port",
]);

/**
 * Splits argv into flags and positionals.
 *
 * Filtering on a leading dash is not enough: the *value* of `--provider minimax`
 * has no dash, so a naive filter leaves it in the positionals and it ends up
 * concatenated into the user's message. That is how "minimax " came to be
 * prepended to every prompt.
 */
function parseArgs(argv: string[]): {
  positional: string[];
  flags: Map<string, string | true>;
} {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("-")) {
      positional.push(arg);
      continue;
    }
    if (VALUE_FLAGS.has(arg)) {
      const value = argv[i + 1];
      if (value !== undefined && !value.startsWith("-")) {
        flags.set(arg, value);
        i++; // consume the value so it never reaches the positionals
        continue;
      }
    }
    flags.set(arg, true);
  }

  return { positional, flags };
}

async function cmdChat(argv: string[]): Promise<number> {
  const { positional, flags } = parseArgs(argv);

  // Flags win over env, and env wins over the config file, so a single run can
  // target a different endpoint while the configured default holds otherwise.
  const providerName = flags.get("--provider");
  const modelOverride = flags.get("--model");
  if (typeof modelOverride === "string") {
    process.env.AGENTBOX_MODEL = modelOverride;
  }
  const config = loadConfig(line => err(dim(line)));
  applyConfigEnv(config);

  let provider: ProviderProfile;
  try {
    provider = resolveProvider(
      typeof providerName === "string" ? providerName : undefined,
      config.provider
    );
  } catch (error) {
    err(error instanceof Error ? error.message : String(error));
    return 1;
  }

  if (
    provider.keyEnv === "ANTHROPIC_API_KEY" &&
    !process.env.ANTHROPIC_API_KEY &&
    !process.env.ANTHROPIC_AUTH_TOKEN
  ) {
    // The SDK also reads an `ant auth login` profile, so this is a hint, not a gate.
    out(
      dim(
        "No ANTHROPIC_API_KEY set — relying on an `ant auth login` profile. " +
          "Run `ant auth status` if requests fail."
      )
    );
  }

  const noBox = flags.has("--no-box");
  const agentArg = positional[0];
  const oneShot = positional.slice(1).join(" ").trim();

  const renderer = makeRenderer();
  let orchestrator: Orchestrator;
  try {
    orchestrator = new Orchestrator({
      provider,
      useBox: !noBox,
      onTurnEvent: renderer.onTurnEvent,
      onBusEvent: renderer.onBusEvent,
    });
  } catch (error) {
    err(error instanceof Error ? error.message : String(error));
    return 1;
  }

  out(dim(`model: ${describeProvider(provider)}`));
  // After applyConfigEnv, so a key set in config counts as present.
  for (const line of describeAbsences()) out(dim(line));

  const box = await orchestrator.connectBox();
  out(box.connected ? dim(`box: ${box.detail}`) : dim(`box: unavailable — ${box.detail}`));

  const agent = agentArg
    ? orchestrator.registry.resolve(agentArg)
    : orchestrator.ensureDefaultAgent();
  out(dim(`talking to ${agent.profile.name} (${agent.id})`));
  out("");

  /** Returns true when the turn (and any it woke) completed without error. */
  const runOne = async (text: string): Promise<boolean> => {
    let ok = true;
    try {
      await orchestrator.prompt(agent.id, text);
      // Teammates woken during that turn are still working; let them finish so
      // their messages land before the next prompt.
      await orchestrator.settle();
    } catch (error) {
      renderer.endStream();
      err(`error: ${error instanceof Error ? error.message : String(error)}`);
      ok = false;
    }
    renderer.endStream();
    return ok;
  };

  // One-shot mode is scriptable, so a failed turn has to be a non-zero exit.
  if (oneShot) {
    return (await runOne(oneShot)) ? 0 : 1;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  out(dim("Type a message. Ctrl-C or an empty line with 'exit' to quit."));
  try {
    for (;;) {
      const line = (await rl.question(`\n${bold("you")}: `)).trim();
      if (!line) continue;
      if (line === "exit" || line === "quit") break;
      out("");
      await runOne(line);
    }
  } finally {
    rl.close();
  }
  return 0;
}

/**
 * The relay that carries the box's traffic out through this machine.
 *
 * Runs in the foreground: it is a network service someone starts deliberately, and one that
 * exits when they stop watching it is better than one that lingers.
 */
/**
 * The control plane: many people, one box each.
 *
 * A separate command from `web` because it is a different deployment, not a different flag. `web`
 * drives one box for one person; this authenticates people, gives each their own box, and proxies
 * them to it.
 */
async function cmdControl(argv: string[]): Promise<number> {
  const [sub = "up", ...rest] = argv;

  if (sub === "status") {
    for (const line of describeControlPlane()) out(line);
    return 0;
  }
  if (sub !== "up") {
    err(`Unknown control command: ${sub}. Try \`up\` or \`status\`.`);
    return 1;
  }

  const { flags } = parseArgs(rest);
  const allocatorFlag = flags.get("--allocator");
  const allocator = allocatorFlag === "static" ? "static" : "compose";
  if (allocatorFlag !== undefined && allocatorFlag !== "static" && allocatorFlag !== "compose") {
    err(`Unknown allocator: ${String(allocatorFlag)}. Use compose or static.`);
    return 1;
  }
  const portFlag = flags.get("--port");
  const hostFlag = flags.get("--host");
  const imageFlag = flags.get("--image");
  const sweepFlag = flags.get("--sweep-seconds");
  const relayPortFlag = flags.get("--relay-port");

  try {
    const running = await startControlPlane({
      port: typeof portFlag === "string" ? Number(portFlag) : 8080,
      // Loopback by default, like everything else here: this has no TLS, and the session cookie is
      // the whole session.
      host: typeof hostFlag === "string" ? hostFlag : "127.0.0.1",
      allocator,
      image: typeof imageFlag === "string" ? imageFlag : defaultBoxConfig().image,
      users: process.env.AGENTBOX_CONTROL_USERS,
      sweepSeconds: typeof sweepFlag === "string" ? Number(sweepFlag) : undefined,
      relay: flags.get("--relay") === true,
      relayPort: typeof relayPortFlag === "string" ? Number(relayPortFlag) : undefined,
      relayProvider: typeof flags.get("--provider") === "string" ? String(flags.get("--provider")) : undefined,
      secureCookies: process.env.AGENTBOX_SECURE_COOKIES === "1",
      ...(typeof flags.get("--public-url") === "string" ? { publicUrl: String(flags.get("--public-url")) } : process.env.AGENTBOX_PUBLIC_URL ? { publicUrl: process.env.AGENTBOX_PUBLIC_URL } : {}),
      out: line => out(line === "" ? "" : dim(line)),
    });
    out("");
    out(`${bold("sign in")} at ${running.url}/gateway/login`);
    out(dim("Ctrl-C to stop. Boxes keep running: they are not children of this process."));
    await new Promise<void>(resolve => {
      const stop = () => {
        void running.close().then(resolve);
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    return 0;
  } catch (error) {
    err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function cmdEgress(argv: string[]): Promise<number> {
  const { flags } = parseArgs(argv);
  const portFlag = flags.get("--port");
  const hostFlag = flags.get("--host");
  const allowFlag = flags.get("--allow");

  try {
    const server = startEgressRelay({
      // The box token by default, so a box started by this CLI can already authenticate.
      token: loadBoxToken(),
      port: typeof portFlag === "string" ? Number(portFlag) : undefined,
      host: typeof hostFlag === "string" ? hostFlag : undefined,
      allow:
        typeof allowFlag === "string"
          ? allowFlag.split(",").map(entry => entry.trim()).filter(Boolean)
          : undefined,
      log: line => out(dim(line)),
    });
    out("");
    out(`${bold("egress relay")} running. Point a box at it with:`);
    out(dim("  AGENTBOX_EGRESS_RELAY=host.docker.internal:8790 agentbox box up --recreate"));
    out(dim("Ctrl-C to stop."));
    await new Promise<void>(resolve => server.on("close", resolve));
    return 0;
  } catch (error) {
    err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function cmdWeb(argv: string[]): Promise<number> {
  const { flags } = parseArgs(argv);
  const providerName = flags.get("--provider");
  const modelOverride = flags.get("--model");
  if (typeof modelOverride === "string") process.env.AGENTBOX_MODEL = modelOverride;
  // The configured default provider and its key, so a restart that forgot the flag
  // does not silently become a different company's model with no credential.
  const webConfig = loadConfig(line => err(dim(line)));
  applyConfigEnv(webConfig);

  const portFlag = flags.get("--port");
  const port = typeof portFlag === "string" ? Number(portFlag) : 7777;

  // Loopback by default, because the UI has no authentication and the assumption has
  // always been that anything able to reach it can already drive the agents. Overridable
  // for the case that changes it: inside the box, where the container's own loopback is
  // not reachable from anywhere and Docker publishes the port to the host's instead.
  // A token makes the UI need one; without it the loopback justification applies.
  const tokenFlag = flags.get("--token");
  const hostFlag = flags.get("--host");
  const host = typeof hostFlag === "string" ? hostFlag : "127.0.0.1";

  let provider: ProviderProfile;
  try {
    provider = resolveProvider(
      typeof providerName === "string" ? providerName : undefined,
      webConfig.provider
    );
  } catch (error) {
    err(error instanceof Error ? error.message : String(error));
    return 1;
  }

  // Make sure there is somebody to talk to before opening a page with an empty
  // sidebar and no explanation.
  //
  // Through STARTER_TEAM rather than a copy of it. There used to be a second definition of Ada
  // inline here, and the two drifted the moment the team grew: `agentbox web` — which is what the
  // box itself runs — kept seeding one agent while the orchestrator's own path seeded four. One
  // definition, used by both.
  const registry = new AgentRegistry();
  if (registry.list().length === 0) {
    const created = STARTER_TEAM.map(profile => registry.create(profile));
    out(dim(`created ${created.map(record => record.profile.name).join(", ")} to start with`));
  }

  out(dim(`model: ${describeProvider(provider)}`));
  // Written on first run so the settings are visible in an editor, not just in docs.
  out(dim(`config: ${ensureConfigFile()}`));
  // After applyConfigEnv, so a key set in config counts as present.
  for (const line of describeAbsences()) out(dim(line));

  try {
    await startWebServer({
      port,
      host,
      token: typeof tokenFlag === "string" ? tokenFlag : undefined,
      provider,
      useBox: !flags.has("--no-box"),
      onLog: line => out(dim(line)),
      onReady: url => {
        out("");
        out(`${bold("agentbox web")} on ${url}`);
        out(dim("Open it in a browser. Ctrl-C to stop."));
      },
    });
  } catch (error) {
    err(error instanceof Error ? error.message : String(error));
    return 1;
  }

  // Hold the process open; the server owns the lifetime from here.
  await new Promise<void>(resolve => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.on(signal, () => resolve());
    }
  });
  out("\nstopped");
  return 0;
}

// --- dispatch -------------------------------------------------------------

const USAGE = `agentbox — multi-agent orchestrator with a Docker box and Linux computer-use

Usage: agentbox <command> [args]

Box:
  box build                 Build the box image (needs \`npm run build:boxd\` first)
  box upgrade [--yes]       Upgrade if it costs nobody anything; explain if not.
                            Safe to run on a timer.
  box rollback              Put the box back on agentbox/box:previous
  box up [--recreate]       Start the box and wait for its desktop
                            --recreate upgrades: destroys and rebuilds the
                            container from the image. Only the work and config
                            volumes survive. It backs them up first and refuses
                            if anything would be lost; --yes goes ahead anyway,
                            --no-backup skips the copy.
             --with-host    also run the orchestrator inside it (web UI on 7777)
  box status                Show container state, ports, and health
  box attach <name> <url> --token-file F [--display-floor N] [--work-dir D] [--replace]
                            Drive another machine's boxd as a second box (docs/30).
                            Agents are created into a box and stay there; --replace
                            moves an attached box to a new address.
  box detach <name>         Forget an attached box (refused while agents live in it)
  box list                  Every box: own first, then attached, with who lives where
  box down [--rm]           Stop the box, optionally removing the container
  box logs [--tail N]       Container logs
  box shot [file.webp]      Save a screenshot of the box desktop
  box exec <command>        Run a shell command in the box

Agents:
  agents                    List agents
  agent new <name> [desc]   Create an agent

Templates (through the running web server; docs/29):
  template import <file> [--name N]
                            Create a bot from a template file; it installs the
                            recipe on its first turn and asks for what it needs.
  template share <agent>    Ask a bot to draft a template of itself (watch the chat).
  template download <agent> [-o file]
                            Save the latest staged template as a file to share.

State:
  backup [dir]              Snapshot ~/.agentbox without stopping anything.
                            Transcripts, memory, plans and skills are the only
                            things here that cannot be rebuilt.
  usage [--day D] [--work ID] [--task tNN]
                            What the model cost, from the records. A day, one
                            piece of work across every attempt at it, or one
                            task through the turns its board history names.
  scan-records              What credential-shaped text is in the records, and
                            whether any value you hold appears verbatim. Values
                            are compared, never printed. A pattern match is not
                            a secret — each needs your verdict. See docs/15.

Chat:
  chat [agent] [message]    Talk to an agent. Omit the message for a REPL,
                            omit the agent to use the first one.
                            --no-box              run without the box tools
                            --provider <name>     anthropic | minimax | custom
                            --model <id>          override the model

The box runs wherever your Docker engine points: set DOCKER_HOST or use
\`docker context use\` to put it on a remote machine.

  probe [provider...]      Live conformance probes against an endpoint: tool
                           calls and their round trip, parallel calls,
                           streaming, vision, long output, caching. Run before
                           trusting a new provider, and after a vendor update.
  mcp                      Bridge this installation to an MCP client over stdio.
                           Needs AGENTBOX_MCP_TOKEN from Settings; the client
                           gets a box, a desktop and a team, billed to whoever
                           the token belongs to.

Quality:
  golden [provider...]     End-to-end golden tasks through a real orchestrator
                           in a throwaway state directory, graded against the
                           harness's own records. --box includes the box tasks.
                           Nightly per model is the intended cadence.

Providers:
  anthropic (default)      claude-opus-5; full vision, caching, thinking
  minimax                  MiniMax-M3 via its Anthropic-compatible endpoint.
                           M3 can see screenshots; M2 accepts and silently
                           discards them, so it loses the computer tool.
  custom                   Set AGENTBOX_BASE_URL, AGENTBOX_MODEL, and
                           AGENTBOX_KEY_ENV. Every optional capability
                           defaults off; opt in with AGENTBOX_VISION=1,
                           AGENTBOX_CACHING=1, AGENTBOX_THINKING=1.

Control plane (many people, one box each):
  control up                Authenticate people and give each their own box
                            --allocator compose|static   one container per tenant,
                                                         or one existing box (dev)
                            --port <n>       default 8080, loopback only
                            --image <tag>    box image for new boxes
                            --sweep-seconds  collector interval; 0 disables it
                            --relay          run a model relay, so no provider
                                             key enters a box (see below)
                            --relay-port <n> default 8788
                            --provider <name>  which provider relayed boxes use
  control status            Tenants, their boxes, spend and recent actions

  There is no TLS here. The session cookie is the whole session, so put a TLS
  terminator in front of it before anyone signs in over a network.

  Without --relay, every box carries a provider key in its environment, and \`box\`
  has passwordless sudo — so an agent that goes looking finds it. With --relay the
  key stays in this process, each box gets a token of its own, and usage is
  measured where the request passes rather than reported by the box.

Environment:
  ANTHROPIC_API_KEY         API credentials (or run \`ant auth login\`)
  AGENTBOX_PROVIDER         Which provider to use (see above)
  AGENTBOX_HOME             State directory (default ~/.agentbox)
  AGENTBOX_CONFIG           Config file (default <state>/config.json)
  AGENTBOX_IMAGE            Box image tag (default agentbox/box:latest)
  AGENTBOX_BOX_HOST         Override where published ports are reachable
  AGENTBOX_WIDTH/HEIGHT     Box display size (default 1280x800)
  AGENTBOX_CONTROL_USERS    user:password:tenant,... for \`control up\`
                            (one is generated and printed when unset)
  AGENTBOX_CONTROL_KEY      64 hex chars; encrypts stored box tokens. Minted
                            beside the database when unset — which means a
                            backup of that directory holds both.
  AGENTBOX_SESSION_SECRET   Shared by two gateways so sessions survive either
  AGENTBOX_SECURE_COOKIES   1 when TLS terminates in front of the gateway`;

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const [command, ...rest] = argv;

  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      out(USAGE);
      return 0;

    case "box": {
      const [sub, ...boxArgs] = rest;
      switch (sub) {
        case "attach":
          return cmdBoxAttach(boxArgs);
        case "detach":
          return cmdBoxDetach(boxArgs);
        case "list":
          return cmdBoxList();
        case "build":
          return cmdBoxBuild();
        case "up":
          return cmdBoxUp(boxArgs);
        case "status":
          return cmdBoxStatus();
        case "down":
          return cmdBoxDown(boxArgs);
        case "upgrade":
          return cmdBoxUpgrade(boxArgs);
        case "rollback":
          return cmdBoxRollback(boxArgs);
        case "logs":
          return cmdBoxLogs(boxArgs);
        case "shot":
          return cmdBoxShot(boxArgs);
        case "exec":
          return cmdBoxExec(boxArgs);
        default:
          err(`Unknown box command: ${sub ?? "(none)"}`);
          out(USAGE);
          return 1;
      }
    }

    case "backup":
      return cmdBackup(rest);

    case "agents":
      return cmdAgents();

    case "agent": {
      const [sub, ...agentArgs] = rest;
      if (sub === "new") return cmdAgentNew(agentArgs);
      err(`Unknown agent command: ${sub ?? "(none)"}`);
      return 1;
    }

    case "template":
      return cmdTemplate(rest);

    case "chat":
      return cmdChat(rest);

    case "control":
      return cmdControl(rest);

    case "egress":
      return cmdEgress(rest);

    case "web":
      return cmdWeb(rest);

    case "providers": {
      for (const name of providerNames()) {
        const profile = resolveProvider(name);
        const key = process.env[profile.keyEnv] ? "key set" : `needs ${profile.keyEnv}`;
        out(`${bold(name)}  ${dim(`${key}`)}`);
        out(dim(`  ${describeProvider(profile)}`));
      }
      return 0;
    }

    // Live conformance probes: does this endpoint behave like the wire the turn
    // engine assumes? Run before trusting a new provider, and after a vendor "update".
    case "probe": {
      const { runConformance } = await import("./host/conformance.ts");
      const names = rest.filter(argument => !argument.startsWith("--"));
      const targets = names.length > 0 ? names : [undefined];
      let anyFailed = false;
      for (const name of targets) {
        const profile = resolveProvider(name);
        if (process.env[profile.keyEnv] === undefined) {
          err(`${profile.label}: needs ${profile.keyEnv}`);
          anyFailed = true;
          continue;
        }
        out(`${bold(profile.label)}  ${dim(profile.model)}`);
        const results = await runConformance(profile, result => {
          const mark =
            result.status === "ok"
              ? "✓"
              : result.status === "degraded"
                ? "~"
                : result.status === "skipped"
                  ? "·"
                  : "✗";
          out(`  ${mark} ${result.name.padEnd(16)} ${dim(`${result.detail} (${result.ms}ms)`)}`);
        });
        if (results.some(result => result.status === "failed")) anyFailed = true;
      }
      return anyFailed ? 1 : 0;
    }

    // End-to-end golden tasks: a real orchestrator, real turns, outcomes graded
    // against the harness's own records rather than the model's account of itself.
    // Each provider runs in a throwaway state directory — a golden run must neither
    // write memories into the real installation nor read them.
    case "golden": {
      const { GOLDEN_TASKS } = await import("./host/golden.ts");
      const withBox = rest.includes("--box");
      const names = rest.filter(argument => !argument.startsWith("--"));
      const targets = names.length > 0 ? names : [undefined];
      let anyFail = false;
      for (const name of targets) {
        // The env from config, applied before anything reads it. Without this the suite
        // ran with no search key while the installation it is meant to represent had
        // three, so a task about research behaviour was measuring a system nobody uses —
        // and passed or failed for reasons that had nothing to do with the change under
        // test. `chat` and `web` have always done this; golden was the one path that did
        // not, which is the worst place for the omission to sit.
        applyConfigEnv(loadConfig(() => {}));
        const profile = resolveProvider(name, loadConfig().provider);
        if (process.env[profile.keyEnv] === undefined) {
          err(`${profile.label}: needs ${profile.keyEnv}`);
          anyFail = true;
          continue;
        }
        // Resolved before AGENTBOX_HOME moves. The box's token lives in the real home,
        // and a golden run pointed at a fresh temp home was minting a *new* one — so
        // every authenticated box route answered 401 while `GET /health` (which is
        // deliberately unauthenticated, for container health checks) still said the box
        // was ready. The run looked fine and could not touch the box at all.
        const boxProvisioner = withBox ? new DockerBoxProvisioner(defaultBoxConfig()) : undefined;

        const home = mkdtempSync(join(tmpdir(), "agentbox-golden-"));
        process.env.AGENTBOX_HOME = home;
        const registry = new AgentRegistry(join(home, "agents"));
        // Away from the desktops a running installation is using. The suite shares the
        // box with whatever else is up, and both registries counting from 1 meant both
        // claimed desktop 1 — the box then refused the suite's agent, and two tasks
        // failed for a reason that had nothing to do with what they test.
        registry.displayFloor = 20;
        const orchestrator = new Orchestrator({
          registry,
          provider: profile,
          useBox: withBox,
          ...(boxProvisioner !== undefined ? { boxProvisioner } : {}),
        });
        if (withBox) out(dim((await orchestrator.connectBox()).detail));
        const gold = registry.create({
          name: "Gold",
          description: "You are the golden-task agent. Do exactly what each message asks.",
        });
        const silver = registry.create({
          name: "Silver",
          description: "You acknowledge messages briefly.",
        });
        out(`${bold(profile.label)}  ${dim(profile.model)}  ${dim(home)}`);
        const boxReady = orchestrator.boxClient() !== undefined;

        // The judge, for the checks a program cannot make. On the summary profile rather
        // than the agent's own: a model should not grade itself, and this is exactly the
        // cheap-and-mechanical shape that profile exists for.
        const judgeProfile = resolveSummaryProvider(profile);
        const judgeClient = createClient(judgeProfile);
        const judge = async (question: string, text: string): Promise<boolean> => {
          const response = await judgeClient.messages.create({
            model: judgeProfile.model,
            max_tokens: 4,
            // Zero, because a grader that disagrees with itself between runs turns a
            // regression suite into noise.
            temperature: 0,
            messages: [
              {
                role: "user",
                content:
                  `${question}\n\nAnswer with exactly one word, "yes" or "no".\n\n` +
                  `--- the text ---\n${text}`,
              },
            ],
          });
          const said = (response.content as { type: string; text?: string }[])
            .map(block => (block.type === "text" ? (block.text ?? "") : ""))
            .join(" ")
            .trim()
            .toLowerCase();
          if (/^yes\b/.test(said)) return true;
          if (/^no\b/.test(said)) return false;
          // Neither, which means the rubric or the model failed — not the agent. Raised
          // rather than guessed, so it cannot be silently scored as a pass.
          throw new Error(`the judge answered ${JSON.stringify(said.slice(0, 40))}`);
        };
        // Quality per token, not quality alone. A model that passes one more task by
        // spending five times the tokens is not better for this product, and the
        // single number that says so is passes per 100k — the usage log already
        // counts the denominator, so this costs one division.
        let passed = 0;
        let attempted = 0;
        const spendBefore = orchestrator.usage.totalsSince(0);
        for (const task of GOLDEN_TASKS) {
          // `--only=id,id` narrows the run: the ordinary need after editing one task is
          // to re-run that task, not to pay for seventeen others to find out.
          const only = rest.find(argument => argument.startsWith("--only="))?.slice(7);
          if (only !== undefined && !only.split(",").includes(task.id)) continue;
          if (task.needsBox === true && !boxReady) {
            out(`  · ${task.id.padEnd(12)} ${dim("needs a box (--box)")}`);
            continue;
          }
          const started = Date.now();
          // New for every attempt, so nothing a previous run left behind can be mistaken
          // for work this one did.
          const token = randomUUID().slice(0, 8);
          try {
            await task.setup?.({ orchestrator, token });
            const before = registry.readTranscript(gold.id).length;
            await orchestrator.prompt(gold.id, task.prompt({ teammateName: "Silver", token }));
            await orchestrator.settle();
            const reply = orchestrator.replySince(gold.id, before);
            const verdict = await task.check({
              reply,
              agentId: gold.id,
              teammateId: silver.id,
              registry,
              orchestrator,
              judge,
              token,
            });
            const seconds = Math.round((Date.now() - started) / 1000);
            // An infrastructure failure is marked apart from a wrong answer: a red row
            // that means "the box was busy" and a red row that means "the model
            // regressed" are different news.
            const mark = verdict.pass ? "✓" : verdict.infrastructure === true ? "!" : "✗";
            out(
              `  ${mark} ${task.id.padEnd(12)} ` +
                dim(`${verdict.detail} (${seconds}s)`)
            );
            attempted += 1;
            if (verdict.pass) passed += 1;
            else anyFail = true;
          } catch (error) {
            attempted += 1;
            anyFail = true;
            const detail = error instanceof Error ? error.message : String(error);
            out(`  ✗ ${task.id.padEnd(12)} ${dim(detail)}`);
          }
        }
        // The headline number: passes per 100k tokens. Quality alone rewards a model
        // that buys one more task with five times the spend; this does not.
        const after = orchestrator.usage.totalsSince(0);
        const tokens =
          after.inputTokens - spendBefore.inputTokens +
          (after.outputTokens - spendBefore.outputTokens) +
          (after.cacheReadTokens - spendBefore.cacheReadTokens) +
          (after.cacheWriteTokens - spendBefore.cacheWriteTokens);
        const perHundredK = tokens > 0 ? (passed / tokens) * 100_000 : 0;
        out(
          `  ${bold(`${passed}/${attempted}`)} passed, ${Math.round(tokens / 1000)}k tokens` +
            (tokens > 0 ? dim(` — ${perHundredK.toFixed(1)} passes per 100k`) : "")
        );
      }
      return anyFail ? 1 : 0;
    }

    // A stdio bridge to a running installation, because that is the shape every
    // client already knows how to configure. It forwards JSON-RPC lines to /mcp and
    // writes the replies back — no protocol of its own, so nothing here can disagree
    // with the server about what MCP means.
    case "mcp": {
      const url = process.env.AGENTBOX_MCP_URL ?? "http://127.0.0.1:7777/mcp";
      const token = process.env.AGENTBOX_MCP_TOKEN;
      if (token === undefined || token === "") {
        err("Set AGENTBOX_MCP_TOKEN to a token from Settings — the side door needs a person's name on it.");
        return 1;
      }
      let buffer = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", chunk => {
        buffer += chunk;
        let at = buffer.indexOf("\n");
        while (at >= 0) {
          const line = buffer.slice(0, at).trim();
          buffer = buffer.slice(at + 1);
          at = buffer.indexOf("\n");
          if (line === "") continue;
          void fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
            body: line,
          })
            .then(async response => {
              const text = await response.text();
              // A notification gets an empty object back and has no id; writing that
              // to a client expecting nothing is noise, so it is dropped.
              if (text.trim() !== "" && text.trim() !== "{}") process.stdout.write(`${text}\n`);
            })
            .catch((error: unknown) => {
              err(`mcp bridge: ${error instanceof Error ? error.message : String(error)}`);
            });
        }
      });
      await new Promise<void>(resolve => process.stdin.on("end", () => resolve()));
      return 0;
    }

    case "where":
      out(`state:  ${agentboxHome()}`);
      out(`agents: ${defaultAgentsRoot()}`);
      return 0;

    case "usage": {
      // The re-runnable version of the fifteen throwaway scripts from 2026-08-26. The
      // reading and the arithmetic live in spend.ts, tested; this is the printer.
      const { UsageLog } = await import("./host/usage.ts");
      const { describeSpend, summariseSpend } = await import("./host/spend.ts");
      const { TaskStore } = await import("./host/tasks.ts");
      const flag = (name: string): string | undefined => {
        const at = rest.indexOf(name);
        return at === -1 ? undefined : rest[at + 1];
      };

      const log = new UsageLog();
      const records = log.since(0, Number.MAX_SAFE_INTEGER);

      // A task is costed through the turns its own history records, which is the join the
      // board was already writing down and nothing could use.
      let turnIds: string[] | undefined;
      const taskId = flag("--task");
      if (taskId !== undefined) {
        const task = new TaskStore().get(taskId);
        if (task === undefined) {
          out(`no task ${taskId}`);
          return 1;
        }
        turnIds = [...new Set(task.history.map(change => change.run).filter(run => run !== undefined))];
        if (turnIds.length === 0) {
          out(`${taskId} has no agent runs on its history — nothing to cost`);
          return 0;
        }
      }

      // Rates are configuration, never baked in: prices change and differ per account, and a
      // table in source is a number that goes quietly wrong while still looking authoritative.
      let rates = {};
      try {
        rates =
          (JSON.parse(readFileSync(join(agentboxHome(), "config.json"), "utf8")) as { rates?: object })
            .rates ?? {};
      } catch {
        // No config, or no rates in it. Tokens are still reported; money is withheld and said so.
      }

      const report = summariseSpend(records, {
        ...(flag("--day") !== undefined ? { day: flag("--day")! } : {}),
        ...(flag("--work") !== undefined ? { workId: flag("--work")! } : {}),
        ...(turnIds !== undefined ? { turnIds } : {}),
        rates,
        compacted: log.compacted(),
      });
      for (const line of describeSpend(report)) out(line);
      return 0;
    }

    case "scan-records": {
      // The measurement docs/15 turns on, as something anybody can re-run. The review's
      // sharpest finding was that the original figure came from a script typed into a
      // shell once and never kept, which makes it a claim rather than a measurement.
      const { scanRecords, describeScan } = await import("./host/secret-scan.ts");
      // Values are read here rather than through Vault, deliberately: `list()` omits
      // values on purpose, and adding a value-enumeration API would open the surface the
      // vault exists to keep closed. This runs on the operator's own machine, against
      // their own files, at the same trust level as reading the config.
      const held = new Map<string, string>();
      const collect = (source: string, object: unknown, prefix = ""): void => {
        if (object === null || typeof object !== "object") return;
        for (const [key, value] of Object.entries(object as Record<string, unknown>)) {
          if (typeof value === "string") held.set(`${source}${prefix}.${key}`, value);
          else collect(source, value, `${prefix}.${key}`);
        }
      };
      try {
        collect("config", JSON.parse(readFileSync(join(agentboxHome(), "config.json"), "utf8")));
      } catch {
        // No config is an ordinary state, not a scan failure.
      }
      try {
        const vault = JSON.parse(readFileSync(join(agentboxHome(), "vault.json"), "utf8")) as {
          secrets?: { id?: unknown; value?: unknown }[];
        };
        for (const secret of vault.secrets ?? []) {
          if (typeof secret?.id === "string" && typeof secret?.value === "string") {
            held.set(`vault:${secret.id}`, secret.value);
          }
        }
      } catch {
        // Likewise.
      }
      out(dim(`${held.size} held value(s) to compare against; values are never printed`));
      for (const line of describeScan(scanRecords(agentboxHome(), held))) out(line);
      return 0;
    }

    default:
      err(`Unknown command: ${command}`);
      out(USAGE);
      return 1;
  }
}

main()
  .then(code => process.exit(code))
  .catch(error => {
    err(`\nerror: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
