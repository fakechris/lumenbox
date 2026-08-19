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
  resolveDockerHostAddress,
  type BoxConfig,
} from "./box/docker.ts";
import { AgentRegistry, defaultAgentsRoot } from "./agents/registry.ts";
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
  const manager = new BoxManager(boxConfig());
  const { status } = await manager.up({
    recreate: argv.includes("--recreate"),
    onOutput: line => out(dim(line)),
  });
  out("");
  out(`${bold("Box running")} (${status.containerName})`);
  if (status.boxdUrl) out(`  daemon:  ${status.boxdUrl}`);
  out("");
  out("Each agent gets its own desktop inside the box. Run `agentbox web` to see them.");
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
const VALUE_FLAGS = new Set(["--provider", "--model", "--effort", "--port"]);

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

async function cmdWeb(argv: string[]): Promise<number> {
  const { flags } = parseArgs(argv);
  const providerName = flags.get("--provider");
  const modelOverride = flags.get("--model");
  if (typeof modelOverride === "string") process.env.AGENTBOX_MODEL = modelOverride;

  const portFlag = flags.get("--port");
  const port = typeof portFlag === "string" ? Number(portFlag) : 7777;

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
  const registry = new AgentRegistry();
  if (registry.list().length === 0) {
    const created = registry.create({
      name: "Ada",
      title: "coordinator",
      description:
        "You coordinate this user's team of agents. You are the one they talk to first. " +
        "When a request falls squarely inside a teammate's remit, hand it to them and say " +
        "you did; when the team is missing someone the work clearly needs, propose creating " +
        "them rather than creating them unasked. Do the work yourself when it is faster than " +
        "delegating.",
    });
    out(dim(`created ${created.profile.name} to start with`));
  }

  out(dim(`model: ${describeProvider(provider)}`));
  // Written on first run so the settings are visible in an editor, not just in docs.
  out(dim(`config: ${ensureConfigFile()}`));

  try {
    await startWebServer({
      port,
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
  box status                Show container state, ports, and health
  box down [--rm]           Stop the box, optionally removing the container
  box logs [--tail N]       Container logs
  box shot [file.webp]      Save a screenshot of the box desktop
  box exec <command>        Run a shell command in the box

Agents:
  agents                    List agents
  agent new <name> [desc]   Create an agent

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

Environment:
  ANTHROPIC_API_KEY         API credentials (or run \`ant auth login\`)
  AGENTBOX_PROVIDER         Which provider to use (see above)
  AGENTBOX_HOME             State directory (default ~/.agentbox)
  AGENTBOX_CONFIG           Config file (default <state>/config.json)
  AGENTBOX_IMAGE            Box image tag (default agentbox/box:latest)
  AGENTBOX_BOX_HOST         Override where published ports are reachable
  AGENTBOX_WIDTH/HEIGHT     Box display size (default 1280x800)`;

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
