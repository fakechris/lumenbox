/**
 * Box lifecycle over the Docker CLI.
 *
 * The CLI rather than the Engine API on purpose: it already resolves
 * DOCKER_HOST, `docker context`, TLS material, and `ssh://` endpoints, which is
 * exactly the "remote docker" surface we want and a meaningful amount of code to
 * reimplement. Every call is execFile with an argument array — no shell.
 */

import { envNumber } from "../config.ts";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { BOXD_PORT, UI_PORT } from "../protocol/index.ts";
import { BoxClient } from "./client.ts";

const execFileAsync = promisify(execFile);

/**
 * Paths a volume archive leaves behind, as `tar --exclude` patterns.
 *
 * A backup exists so nothing that cannot be rebuilt is lost. The spool can be rebuilt —
 * it is a 24-hour buffer of command output that `reapSpool` deletes — and it is the one
 * directory in the volume whose whole purpose is to hold text the transcript decided not
 * to keep. Copying it out of the box on every upgrade converts an expiring buffer into a
 * permanent copy, in a directory whose contents nobody reviews. Exported so a test can
 * assert the list rather than trust the command line it is spliced into.
 */
export const BACKUP_EXCLUDES: readonly string[] = ["./.spool"];

/**
 * What a volume archive carries, said at the moment one is written.
 *
 * `/home/box/.config` is a volume so that a browser login survives a rebuild — that is
 * the feature the whole semantic-browser design rests on, and it is why this directory
 * must *not* be excluded the way the spool was. The consequence, which nothing said out
 * loud until docs/15 measured it: **an archive contains whatever the agent logged into.**
 * A session cookie, a `gh auth login`, an `aws configure` — each survives the rebuild it
 * is meant to survive, and each rides along into every copy of the archive.
 *
 * Said here rather than in the preflight, because the preflight only speaks when it has a
 * complaint, and this is not a complaint. It is what a person needs before they decide to
 * copy a backup somewhere.
 */
export const BACKUP_CARRIES =
  "These archives contain whatever the agent is logged into — browser sessions, and any " +
  "credential a tool in the box wrote to ~/.config. That is deliberate: it is how a login " +
  "survives a rebuild. Treat a copy of one as you would treat those logins.";

export const DEFAULT_IMAGE = "agentbox/box:latest";
export const DEFAULT_CONTAINER = "agentbox-box";

/**
 * The private network a box lives on. One per container, named after it.
 *
 * Derived rather than stored, so the name is the same from create, from teardown and
 * from a person reading `docker network ls` — a network whose name has to be looked up
 * somewhere is a network that gets orphaned.
 */
export function networkNameFor(containerName: string): string {
  return `${containerName}-net`;
}

export interface BoxConfig {
  /**
   * Run the orchestrator inside the box, instead of on this machine.
   *
   * The production shape: the only thing outside the container is a browser. Off by
   * default, because a developer wants the orchestrator where their editor is.
   */
  withHost?: boolean;
  containerName: string;
  image: string;
  /** Host port for the daemon. 0 lets Docker pick an ephemeral one. */
  boxdPort: number;
  token: string;
  /**
   * Where the daemon is reachable from the host. Usually 127.0.0.1, but for a
   * remote engine it is that engine's address — published ports live there,
   * not on this machine.
   */
  host: string;
  displayWidth: number;
  displayHeight: number;
  /**
   * The UI token to give this box, when the orchestrator runs inside it.
   *
   * Omitted means "this machine's own", which is right for the single-box CLI and wrong for a
   * fleet: one token across every tenant would let anyone who reached one box's UI drive
   * everyone's. The control plane issues one per box and passes it here.
   */
  uiToken?: string;
  /**
   * Host port for the UI. Omitted means 7777, which is right for one box on a laptop; 0 lets
   * Docker pick, which is what a second box on the same host needs.
   */
  uiPort?: number;
  /**
   * True when this box reaches its model through a relay.
   *
   * Stops this machine's provider credentials being passed in. Without it the relay is decoration:
   * the box would have both a relay token and the real key, and an agent with a shell would find the
   * second one.
   */
  relayed?: boolean;
  /** Extra `docker run` arguments, e.g. volume mounts. */
  runArgs: string[];
}

/**
 * The box token, resolved the same way from every entry point.
 *
 * This lives here rather than in the CLI because it has to: the CLI's `box`
 * commands and the orchestrator's `connectBox` both need it, and when only one of
 * them knew where to look the other authenticated with an empty string and every
 * call came back `Unauthorized` — with nothing to suggest the token was the cause.
 *
 * Created on first use and then stable, so a container started earlier keeps
 * matching.
 */
/**
 * Where one box's token lives. One file per container, because a token is a key to a
 * box and not to the installation.
 *
 * It used to be a single `~/.agentbox/token` shared by every box this host started —
 * harmless while there was only ever one, and exactly the failure the control plane
 * already warns about in its own allocator: "one token across the fleet would mean
 * anyone who reached one tenant's box could reach another". A box that belongs to one
 * person is the whole of the identity design, and a shared key would make that boundary
 * a wish.
 */
/**
 * Said once per process, so an operator who reopened something learns of it — and so the
 * log is not one line per box created.
 */
const warned = new Set<string>();
function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  console.error(`[box] ${message}`);
}

/**
 * Where the daemon is published. Loopback unless somebody deliberately moved it.
 *
 * The override exists for a remote Docker engine, where the published port lives on that
 * engine rather than here. It is also the one way to undo the fix that closed a live
 * exposure — the daemon was reachable from the LAN and its desktop socket was
 * unauthenticated — so taking it says so out loud. A deviation nobody can see is
 * indistinguishable from the default that was never applied.
 */
function publishAddress(): string {
  const configured = process.env.AGENTBOX_BOXD_PUBLISH_ADDRESS;
  if (configured === undefined || configured === "" || configured === "127.0.0.1") {
    return "127.0.0.1";
  }
  warnOnce(
    `the box daemon is published on ${configured}, not loopback. Anything that can reach ` +
      "that address can reach the daemon; its desktop socket is authenticated by the box " +
      "token and nothing else."
  );
  return configured;
}

export function boxTokenPath(containerName: string): string {
  const home = process.env.AGENTBOX_HOME ?? join(homedir(), ".agentbox");
  return join(home, "tokens", containerName);
}

/** The legacy single token, from before a host could run more than one box. */
function legacyTokenPath(): string {
  const home = process.env.AGENTBOX_HOME ?? join(homedir(), ".agentbox");
  return join(home, "token");
}

export function loadBoxToken(containerName: string = DEFAULT_CONTAINER): string {
  const existing = readBoxToken(containerName);
  if (existing) return existing;

  const path = boxTokenPath(containerName);
  const token = generateToken();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  return token;
}

/**
 * The token as configured, without inventing one.
 *
 * Minting is right when this process is about to start the box — the two agree by
 * construction. It is wrong when attaching to a box someone else started: a freshly
 * minted token cannot match theirs, so every call would come back Unauthorized with the
 * cause looking like a network problem.
 */
export function readBoxToken(containerName: string = DEFAULT_CONTAINER): string | undefined {
  // An explicit token still wins: it is how somebody attaches to a box this host did not
  // start, and inventing one for that case would be worse than failing. But it applies to
  // *every* box, which is the fan-out this file otherwise exists to prevent — so it says
  // so, once, rather than quietly making every box share a key.
  if (process.env.AGENTBOX_TOKEN) {
    warnOnce(
      "AGENTBOX_TOKEN is set, so every box on this host shares one key. That is right for " +
        "attaching to a box somebody else runs and wrong for running several: a box that " +
        "belongs to one person is not private while its key opens the others."
    );
    return process.env.AGENTBOX_TOKEN;
  }

  const own = boxTokenPath(containerName);
  if (existsSync(own)) {
    const value = readFileSync(own, "utf8").trim();
    if (value) return value;
  }

  // The legacy shared token, and only for the default container: the box running right
  // now was started with it and its environment cannot be edited in place, so reading it
  // is what keeps that box reachable across this change. A *new* box never inherits it —
  // which is the whole point, since inheriting is how one key came to open every door.
  if (containerName === DEFAULT_CONTAINER && existsSync(legacyTokenPath())) {
    const value = readFileSync(legacyTokenPath(), "utf8").trim();
    if (value) return value;
  }
  return undefined;
}

export function defaultBoxConfig(overrides: Partial<BoxConfig> = {}): BoxConfig {
  const containerName = overrides.containerName ?? process.env.AGENTBOX_CONTAINER ?? DEFAULT_CONTAINER;
  return {
    containerName,
    image: process.env.AGENTBOX_IMAGE ?? DEFAULT_IMAGE,
    boxdPort: envNumber("AGENTBOX_BOXD_PORT", 0),
    // Keyed by the container it is for, so two boxes never share a key.
    token: loadBoxToken(containerName),
    host: process.env.AGENTBOX_BOX_HOST ?? resolveDockerHostAddress(),
    displayWidth: envNumber("AGENTBOX_WIDTH", 1280),
    displayHeight: envNumber("AGENTBOX_HEIGHT", 800),
    runArgs: [],
    withHost: process.env.AGENTBOX_HOST_ENABLED === "1",
    ...overrides,
  };
}

/**
 * Where published container ports actually land.
 *
 * With a local engine that is loopback. With DOCKER_HOST pointing elsewhere the
 * ports are published on *that* machine, so we take its hostname.
 */
export function resolveDockerHostAddress(
  dockerHost = process.env.DOCKER_HOST
): string {
  if (!dockerHost) return "127.0.0.1";
  // unix:// and npipe:// are local sockets.
  if (/^(unix|npipe):/.test(dockerHost)) return "127.0.0.1";
  try {
    // tcp://, ssh://, http(s):// all parse as URLs once the scheme is normalized.
    const url = new URL(dockerHost.replace(/^tcp:/, "http:"));
    return url.hostname || "127.0.0.1";
  } catch {
    return "127.0.0.1";
  }
}

export function generateToken(): string {
  return randomBytes(32).toString("hex");
}

export class DockerError extends Error {
  constructor(
    message: string,
    readonly stderr = ""
  ) {
    super(message);
    this.name = "DockerError";
  }
}

async function docker(
  args: readonly string[],
  timeoutMs = 120_000
): Promise<string> {
  try {
    const { stdout } = await execFileAsync("docker", [...args], {
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (error) {
    const stderr = String((error as { stderr?: string }).stderr ?? "").trim();
    const message = stderr || (error as Error).message;
    throw new DockerError(`docker ${args[0]} failed: ${message}`, stderr);
  }
}

export type ContainerState =
  | "missing"
  | "created"
  | "running"
  | "paused"
  | "restarting"
  | "exited"
  | "dead"
  | "removing";

export interface BoxStatus {
  state: ContainerState;
  containerName: string;
  /** Host-side URL for the daemon, once the port mapping is known. */
  boxdUrl?: string;
  /** Host-side URL for the in-box UI, when one is published. */
  uiUrl?: string;
  health?: string;
}

/**
 * The credentials the in-box orchestrator needs, passed through from this environment.
 *
 * Only the ones that are actually set, so the container's environment does not fill up
 * with empty strings that then look like a configured provider with a blank key.
 *
 * These land in the container, which is the honest cost of running the orchestrator in
 * here: `box` has passwordless sudo, so an agent that goes looking can find them. The uid
 * split keeps them out of the agent's way rather than out of its reach; putting them
 * behind a relay is what would make that a boundary.
 */
/**
 * The UI token for an in-box orchestrator.
 *
 * Persisted next to the box token so a recreate keeps the same URL working, rather than
 * invalidating whatever tab the user has open.
 */
export function uiToken(): string {
  const home = process.env.AGENTBOX_HOME ?? join(homedir(), ".agentbox");
  const path = join(home, "ui-token");
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8").trim();
    if (existing) return existing;
  }
  const token = generateToken();
  mkdirSync(home, { recursive: true });
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  return token;
}

function hostCredentialArgs(): string[] {
  const names = [
    "ANTHROPIC_API_KEY",
    "MINIMAX_CODE_CN_API_KEY",
    "AGENTBOX_API_KEY",
    "AGENTBOX_BASE_URL",
    "AGENTBOX_MODEL",
    "AGENTBOX_PROVIDER",
    "AGENTBOX_KEY_ENV",
    "AGENTBOX_AUTH",
  ];
  return names.flatMap(name => {
    const value = process.env[name];
    return value ? ["--env", `${name}=${value}`] : [];
  });
}

export class BoxManager {
  constructor(readonly config: BoxConfig) {}

  async dockerAvailable(): Promise<boolean> {
    try {
      await docker(["version", "--format", "{{.Server.Version}}"], 15_000);
      return true;
    } catch {
      return false;
    }
  }

  async state(): Promise<ContainerState> {
    try {
      const out = await docker(
        [
          "inspect",
          "--format",
          "{{.State.Status}}",
          this.config.containerName,
        ],
        20_000
      );
      return (out || "missing") as ContainerState;
    } catch (error) {
      if (error instanceof DockerError && /No such object|no such container/i.test(error.stderr)) {
        return "missing";
      }
      throw error;
    }
  }

  /** Resolves the host port Docker assigned to a container port. */
  private async publishedPort(containerPort: number): Promise<number | undefined> {
    try {
      const out = await docker(
        ["port", this.config.containerName, `${containerPort}/tcp`],
        20_000
      );
      // Output lines look like "0.0.0.0:49173" or "[::]:49173".
      const match = /:(\d+)\s*$/m.exec(out);
      return match ? Number(match[1]) : undefined;
    } catch {
      return undefined;
    }
  }

  async status(): Promise<BoxStatus> {
    const state = await this.state();
    const status: BoxStatus = { state, containerName: this.config.containerName };
    if (state !== "running") return status;

    const boxdPort = await this.publishedPort(BOXD_PORT);
    if (boxdPort) status.boxdUrl = `http://${this.config.host}:${boxdPort}`;
    // Only present when the orchestrator runs inside; a box driven from this machine publishes
    // nothing here, and reporting a URL for it would be a link to nothing.
    const port = await this.publishedPort(UI_PORT);
    if (port) status.uiUrl = `http://${this.config.host}:${port}`;
    return status;
  }

  async imageExists(): Promise<boolean> {
    try {
      await docker(["image", "inspect", this.config.image], 20_000);
      return true;
    } catch {
      return false;
    }
  }

  /** Builds the box image from the given context directory. */
  async build(contextDir: string, onOutput?: (line: string) => void): Promise<void> {
    onOutput?.(`building ${this.config.image} from ${contextDir}`);
    // Delegated engines ride in as pinned build args (docs/25): OPENCODE_VERSION in the
    // environment turns the Dockerfile's dormant opencode layer on at exactly that
    // version. Unset builds stay engine-free, which is what they always were.
    const engineArgs: string[] = [];
    const opencode = process.env.OPENCODE_VERSION;
    if (opencode !== undefined && opencode !== "") {
      engineArgs.push("--build-arg", `OPENCODE_VERSION=${opencode}`);
      onOutput?.(`opencode pinned at ${opencode}`);
    }
    // Build output is large and streaming it needs spawn, but the CLI already
    // prints progress to stderr; we surface only the outcome.
    await docker(
      ["build", ...engineArgs, "-t", this.config.image, contextDir],
      20 * 60_000
    );
    onOutput?.(`built ${this.config.image}`);
  }

  /** Exposed for the test that pins where the daemon is published. */
  runArguments(): string[] {
    const { config } = this;
    /**
     * The same thing, bound to one address.
     *
     * The empty middle field is load-bearing: `127.0.0.1::7777` means "this address, a port of
     * Docker's choosing", while `127.0.0.1:7777` means "host port 127.0.0.1" and is rejected. A
     * real two-tenant run found this; the unit tests could not, because Docker was faked there.
     */
    const publishOn = (address: string, hostPort: number, containerPort: number) =>
      hostPort > 0
        ? `${address}:${hostPort}:${containerPort}`
        : `${address}::${containerPort}`;

    return [
      "run",
      "--detach",
      "--name",
      config.containerName,
      // Only the daemon is published, and only to loopback. It proxies every desktop's
      // noVNC, so the number of desktops is not fixed by port mappings chosen at create
      // time — but that also makes this one port the way into every desktop in the box.
      //
      // It was published on all interfaces. Measured on a running installation before
      // the fix: from the machine's LAN address, `/health` answered and a WebSocket
      // upgrade to `/vnc/1/websockify` returned 101 and streamed the desktop — no token,
      // because the RFB upgrade is deliberately unauthenticated on the reasoning that
      // only the host's loopback proxy can reach it. That reasoning was sound and the
      // publication contradicted it: anyone on the same network could watch and drive
      // the agents' screens. The daemon's bearer token never entered it.
      //
      // A remote Docker engine is the one case that needs a routable publication, and it
      // is opt-in: AGENTBOX_BOXD_PUBLISH_ADDRESS, set by someone who has read this.
      "--publish",
      publishOn(publishAddress(), config.boxdPort, BOXD_PORT),
      // Its own bridge, so a box is not on the same subnet as every other container.
      //
      // Worth having and **not sufficient**, which is measured rather than assumed.
      // Docker's default bridge puts every container on one subnet, so a box was
      // reachable from any container by address. Giving each box its own network is the
      // usual answer and is widely believed to isolate them — on Docker 29 with OrbStack
      // it does not: a container on the default bridge reached this box's daemon at its
      // private-network address, because DOCKER-FORWARD accepts forwarding out of every
      // bridge. Tested by running a container and fetching /health; it answered.
      //
      // So this is one layer of several, kept because it costs nothing and does isolate
      // on engines that implement the isolation chains — and the daemon's own upgrade
      // path was authenticated (src/boxd/main.ts) rather than left resting on it.
      // Enforcing the property here would mean writing host firewall rules for an engine
      // whose rules live inside a VM, which is a promise this process cannot keep.
      //
      // The host reaches the daemon through its published loopback port, and the box
      // reaches the internet through this network's own gateway.
      "--network",
      networkNameFor(config.containerName),
      "--env",
      `BOXD_TOKEN=${config.token}`,
      "--env",
      `DISPLAY_WIDTH=${config.displayWidth}`,
      "--env",
      `DISPLAY_HEIGHT=${config.displayHeight}`,
      // Chrome and friends need more than Docker's default 64MB of /dev/shm.
      "--shm-size",
      "1g",
      // The services inside are supervised and restarted in place; this is for the case
      // where one of them cannot be kept alive at all, and for the engine restarting.
      // unless-stopped rather than always, so `box down` stays down.
      "--restart",
      "unless-stopped",
      // The box runs a desktop and a browser; without this a runaway page can
      // starve the engine host.
      "--memory",
      process.env.AGENTBOX_MEMORY ?? "4g",
      // A ceiling, if one is wanted. Unset by default: the split that matters is inside
      // the box — the desktop ahead of the agent's work — and a wrong number here just
      // makes the agent slow for no reason. Set it when a box shares a machine.
      ...(process.env.AGENTBOX_CPUS ? ["--cpus", process.env.AGENTBOX_CPUS] : []),
      // Egress, when a relay was named. host.docker.internal resolves on Docker Desktop
      // already; the mapping is what makes the same name work on a Linux engine, so the
      // relay address does not have to change per platform.
      // Always, not only with the egress relay: the MCP face (docs/33) reaches this host by
      // the same name, and on a Linux engine the name exists only through this mapping.
      "--add-host",
      "host.docker.internal:host-gateway",
      ...(process.env.AGENTBOX_EGRESS_RELAY
        ? [
            "--env",
            `AGENTBOX_EGRESS_RELAY=${process.env.AGENTBOX_EGRESS_RELAY}`,
            ...(process.env.AGENTBOX_EGRESS_TOKEN
              ? ["--env", `AGENTBOX_EGRESS_TOKEN=${process.env.AGENTBOX_EGRESS_TOKEN}`]
              : []),
          ]
        : []),
      // Two named volumes, because everything else in the container is disposable and
      // these two things are not: what the agents made, and what they logged into.
      // Without them, `box up --recreate` — which is also what upgrading the image
      // means — silently destroys both.
      //
      // The system layer stays ephemeral on purpose, so a rebuilt image really does
      // deliver a fresh box. The image's own config files are re-seeded into the
      // config volume on every start (see entrypoint.sh), or an old volume would
      // shadow them forever.
      "--volume",
      `${config.containerName}-work:/home/box/work`,
      "--volume",
      `${config.containerName}-config:/home/box/.config`,
      ...(config.withHost
        ? [
            // The orchestrator's own state — transcripts, agent profiles, owner tokens —
            // on its own volume, so it outlives the container like the agents' work does.
            "--volume",
            `${config.containerName}-hostd:/home/hostd/.agentbox`,
            "--env",
            "AGENTBOX_HOST_ENABLED=1",
            // Generated here rather than in the container, so the CLI can print a URL that
            // works. Inside the box the UI binds 0.0.0.0 — Docker's publish address is all
            // that keeps it local — so it must not be open.
            "--env",
            `AGENTBOX_UI_TOKEN=${config.uiToken ?? uiToken()}`,
            // Published to loopback only. The UI has no authentication — the assumption
            // has always been that anything able to reach it can already drive the
            // agents — so it must not be reachable from the network.
            "--publish",
            publishOn("127.0.0.1", config.uiPort ?? UI_PORT, UI_PORT),
            // Suppressed when a relay is configured, which is the entire point of having one. This
            // was found by looking: the relay worked, usage was measured, and the provider key was
            // still sitting in the container because this passthrough was unconditional. A fix that
            // leaves the credential in place while claiming to have removed it is worse than none.
            ...(config.relayed === true ? [] : hostCredentialArgs()),
          ]
        : []),
      ...config.runArgs,
      config.image,
    ];
  }

  /**
   * Brings the box up and waits for the daemon to answer.
   *
   * Idempotent: an already-running container is reused, a stopped one is started.
   */
  async up(
    options: { recreate?: boolean; onOutput?: (line: string) => void } = {}
  ): Promise<{ client: BoxClient; status: BoxStatus }> {
    const { onOutput } = options;

    if (!this.config.token) {
      throw new DockerError(
        "No box token configured. Set AGENTBOX_TOKEN, or let `agentbox box up` generate one."
      );
    }
    if (!(await this.dockerAvailable())) {
      throw new DockerError(
        "Cannot reach a Docker engine. Check `docker version`, DOCKER_HOST, and your docker context."
      );
    }

    let state = await this.state();

    if (options.recreate && state !== "missing") {
      onOutput?.(`removing existing container ${this.config.containerName}`);
      await this.down({ remove: true });
      state = "missing";
    }

    if (state === "missing") {
      if (!(await this.imageExists())) {
        throw new DockerError(
          `Image ${this.config.image} not found. Run \`agentbox box build\` first.`
        );
      }
      onOutput?.(`starting container ${this.config.containerName}`);
      await this.ensureNetwork();
      await docker(this.runArguments(), 120_000);
    } else if (state === "exited" || state === "created") {
      onOutput?.(`restarting container ${this.config.containerName}`);
      await docker(["start", this.config.containerName], 60_000);
    } else if (state === "paused") {
      await docker(["unpause", this.config.containerName], 30_000);
    } else if (state !== "running") {
      throw new DockerError(
        `Container ${this.config.containerName} is in state "${state}"; ` +
          "resolve it manually or re-run with --recreate."
      );
    }

    const status = await this.status();
    if (!status.boxdUrl) {
      throw new DockerError(
        `Container is running but port ${BOXD_PORT} is not published. ` +
          "It may have been created outside agentbox; re-run with --recreate."
      );
    }

    const client = new BoxClient({ baseUrl: status.boxdUrl, token: this.config.token });
    await this.waitForHealthy(client, onOutput);
    if (this.config.withHost === true && status.uiUrl !== undefined) {
      await this.waitForUi(status.uiUrl, onOutput);
    }
    return { client, status };
  }

  /**
   * Polls the in-box orchestrator's UI until it answers.
   *
   * A box whose desktop is up is not a box a person can use: the orchestrator starts after X, and
   * for a second or two the published port accepts a connection and then nothing serves it. Found
   * by allocating two boxes for real and watching the second one's UI refuse a request that the
   * first one — allocated seconds earlier — had answered.
   *
   * A 401 counts as answering, for the same reason it does in `box-healthcheck`: a UI that refuses
   * an unauthenticated request correctly is a UI that is serving.
   */
  private async waitForUi(
    uiUrl: string,
    onOutput?: (line: string) => void,
    timeoutMs = 60_000
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastError = "not yet listening";
    while (Date.now() < deadline) {
      try {
        const response = await fetch(uiUrl, {
          redirect: "manual",
          signal: AbortSignal.timeout(4000),
        });
        if (response.status < 500) {
          onOutput?.(`orchestrator answering on ${uiUrl}`);
          return;
        }
        lastError = `HTTP ${response.status}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new DockerError(
      `Box desktop is up but its orchestrator never answered on ${uiUrl} ` +
        `within ${timeoutMs / 1000}s (last: ${lastError}). ` +
        `Check \`docker logs ${this.config.containerName}\`.`
    );
  }

  /** Polls /health until the daemon reports a usable display. */
  private async waitForHealthy(
    client: BoxClient,
    onOutput?: (line: string) => void,
    timeoutMs = 90_000
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastError = "";
    let announcedWait = false;

    while (Date.now() < deadline) {
      try {
        const health = await client.health(4000);
        if (health.resolution) {
          onOutput?.(
            `box ready: display ${health.display} at ` +
              `${health.resolution.display.width}x${health.resolution.display.height}`
          );
          return;
        }
        // Daemon is up but X is still coming; keep waiting.
        lastError = "display not ready";
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      if (!announcedWait) {
        onOutput?.("waiting for the box desktop to come up");
        announcedWait = true;
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    throw new DockerError(
      `Box did not become healthy within ${timeoutMs / 1000}s (last: ${lastError}). ` +
        `Check \`docker logs ${this.config.containerName}\`.`
    );
  }

  /**
   * The box's own network, created if it is not there.
   *
   * Idempotent by inspect-then-create, and tolerant of the race between two `box up`
   * runs: "already exists" is the outcome we wanted.
   */
  private async ensureNetwork(): Promise<void> {
    const name = networkNameFor(this.config.containerName);
    const existing = await docker(["network", "inspect", name], 30_000).catch(() => undefined);
    if (existing !== undefined) return;
    try {
      await docker(["network", "create", name], 60_000);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (!/already exists/i.test(detail)) throw error;
    }
  }

  async down(options: { remove?: boolean } = {}): Promise<void> {
    const state = await this.state();
    if (state === "missing") return;
    if (state === "running" || state === "paused" || state === "restarting") {
      await docker(["stop", "--timeout", "10", this.config.containerName], 60_000);
    }
    if (options.remove) {
      await docker(["rm", "--force", this.config.containerName], 60_000);
      // The network goes with the container that owned it. Swallowed: a network still
      // holding another endpoint refuses removal, and that refusal must not fail a
      // teardown whose container is already gone. An orphan is visible in
      // `docker network ls` and is reused by name on the next `up`.
      await docker(["network", "rm", networkNameFor(this.config.containerName)], 30_000).catch(
        () => undefined
      );
    }
  }

  /**
   * Copies the box's volumes somewhere they survive the box.
   *
   * The existing backup covers `~/.agentbox` on the reasoning that the box is disposable
   * and its work lives on a volume. That is true of `docker rm` and false of
   * `docker volume rm`, a mistyped migration, and a disk — and the config volume is not
   * scratch either: it is where people's logged-in browser sessions live, and on a box
   * that has been used it is the larger of the two.
   *
   * Streamed through a container rather than read from the host, because a named volume
   * has no path on the host worth relying on: Docker Desktop and OrbStack keep it inside
   * a VM. The box image is used as the tar because it is already local — pulling a
   * separate one would make backup depend on a registry at exactly the wrong moment.
   *
   * Not stopped first, deliberately, matching the host-side backup: a browser profile
   * copied while Chromium is writing it can be inconsistent, which is the same state a
   * crash leaves and which Chromium already recovers from.
   */
  async backupVolumes(destination: string): Promise<string[]> {
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    const written: string[] = [];
    for (const suffix of ["work", "config"] as const) {
      const volume = `${this.config.containerName}-${suffix}`;
      const file = `${volume}.tar.gz`;
      await docker(
        [
          "run",
          "--rm",
          "--volume",
          `${volume}:/src:ro`,
          "--volume",
          `${destination}:/backup`,
          "--entrypoint",
          "tar",
          this.config.image,
          "czf",
          `/backup/${file}`,
          "-C",
          "/src",
          // The spool holds the *untruncated* output of every command an agent ran —
          // precisely the text the transcript deliberately keeps only 2 KB of, and the
          // likeliest place a `cat .env` or a token-bearing build log survives in full.
          // It was travelling out of the box in every upgrade archive, which turns a
          // 24-hour reaped buffer inside the container into a permanent copy outside it.
          // Excluded, not moved: the spool is meant to be reachable from the box and to
          // expire there, and nothing outside needs it. See docs/15.
          ...BACKUP_EXCLUDES.flatMap(pattern => ["--exclude", pattern]),
          ".",
        ],
        600_000
      );
      written.push(join(destination, file));
    }
    return written;
  }

  /**
   * Whether the image on disk is newer than the one this container is running.
   *
   * By image id rather than by tag, because a tag is a name and the question is about
   * identity: `:latest` points somewhere different after every build, and a container
   * started from the old one still reports the tag it was created with. Comparing names
   * would say everything is fine while the container runs an image from last month —
   * which is exactly the confusion `box down` + `box up` produces.
   */
  async upgradeAvailable(): Promise<{ available: boolean; running?: string; built?: string }> {
    const running = await docker(
      ["inspect", "--format", "{{.Image}}", this.config.containerName],
      20_000
    ).catch(() => undefined);
    const built = await docker(
      ["image", "inspect", "--format", "{{.Id}}", this.config.image],
      20_000
    ).catch(() => undefined);
    if (running === undefined || built === undefined) return { available: false };
    const from = running.trim();
    const to = built.trim();
    return {
      available: from !== to,
      running: from.slice(7, 19),
      built: to.slice(7, 19),
    };
  }

  logs(tail = 200): Promise<string> {
    return docker(["logs", "--tail", String(tail), this.config.containerName], 30_000);
  }

  /** A client for an already-running box, without touching its lifecycle. */
  async connect(): Promise<BoxClient> {
    const status = await this.status();
    if (status.state !== "running" || !status.boxdUrl) {
      throw new DockerError(
        `Box ${this.config.containerName} is not running (state: ${status.state}). ` +
          "Run `agentbox box up`."
      );
    }
    return new BoxClient({ baseUrl: status.boxdUrl, token: this.config.token });
  }
}
