#!/usr/bin/env node
/**
 * agentbox CLI.
 */

import { createInterface } from "node:readline/promises";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import {
  BoxManager,
  defaultBoxConfig,
  loadBoxToken,
  resolveDockerHostAddress,
  uiToken,
  type BoxConfig,
} from "./box/docker.ts";
import { describeControlPlane, startControlPlane } from "./control/main.ts";
import { STARTER_TEAM } from "./host/orchestrator.ts";
import { backupNow } from "./host/backup.ts";
import { AgentRegistry, defaultAgentsRoot } from "./agents/registry.ts";
import { startEgressRelay } from "./egress/relay.ts";
import { DEFAULT_DISPLAY_INDEX } from "./protocol/index.ts";
import { Orchestrator } from "./host/orchestrator.ts";
import type { TurnEvent } from "./host/turn.ts";
import type { BusEvent } from "./agents/bus.ts";
import {
  describeProvider,
  providerNames,
  resolveProvider,
  type ProviderProfile,
} from "./host/provider.ts";
import { ensureConfigFile } from "./config.ts";
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
  const { status } = await manager.up({
    recreate: argv.includes("--recreate"),
    onOutput: line => out(dim(line)),
  });
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
  const result = await client.exec(command, { display, owner: ownerFor(display) });
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
const VALUE_FLAGS = new Set([
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

  // Flags win over env so a single run can target a different endpoint.
  const providerName = flags.get("--provider");
  const modelOverride = flags.get("--model");
  if (typeof modelOverride === "string") {
    process.env.AGENTBOX_MODEL = modelOverride;
  }

  let provider: ProviderProfile;
  try {
    provider = resolveProvider(
      typeof providerName === "string" ? providerName : undefined
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
      typeof providerName === "string" ? providerName : undefined
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
  box up [--recreate]       Start the box and wait for its desktop
             --with-host    also run the orchestrator inside it (web UI on 7777)
  box status                Show container state, ports, and health
  box down [--rm]           Stop the box, optionally removing the container
  box logs [--tail N]       Container logs
  box shot [file.webp]      Save a screenshot of the box desktop
  box exec <command>        Run a shell command in the box

Agents:
  agents                    List agents
  agent new <name> [desc]   Create an agent

State:
  backup [dir]              Snapshot ~/.agentbox without stopping anything.
                            Transcripts, memory, plans and skills are the only
                            things here that cannot be rebuilt.

Chat:
  chat [agent] [message]    Talk to an agent. Omit the message for a REPL,
                            omit the agent to use the first one.
                            --no-box              run without the box tools
                            --provider <name>     anthropic | minimax | custom
                            --model <id>          override the model

The box runs wherever your Docker engine points: set DOCKER_HOST or use
\`docker context use\` to put it on a remote machine.

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
        case "build":
          return cmdBoxBuild();
        case "up":
          return cmdBoxUp(boxArgs);
        case "status":
          return cmdBoxStatus();
        case "down":
          return cmdBoxDown(boxArgs);
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

    case "where":
      out(`state:  ${agentboxHome()}`);
      out(`agents: ${defaultAgentsRoot()}`);
      return 0;

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
