/**
 * How a box is wired to the network, and whether the relay is its only way out (INV-816).
 *
 * A box with an egress relay named used to sit on an ordinary bridge and be *pointed* at the
 * relay: boxd puts `HTTP_PROXY` in a command's environment and the browser is started with
 * `--proxy-server`. The agent has passwordless sudo, so `env -u HTTP_PROXY curl …` went
 * straight out, past the allow list and past the record of who connected. Steering is not a
 * boundary.
 *
 * Confined, the box is on an **internal** network — the engine gives it no route out and no
 * published port — and one small container, the gate, stands on that network and on an
 * ordinary one. The gate forwards a fixed list of TCP ports and nothing else: the daemon's
 * port inwards, so this machine still reaches boxd on loopback, and outwards only the relay's
 * port and the web port (where the MCP face and the model relay live). Inside the box the
 * gate answers to `host.docker.internal`, so the relay address and the face URL read the
 * same as before.
 *
 * Why this and not a firewall rule: measured on OrbStack and true of any engine, a rule in the
 * box's own network namespace is gone when the container restarts (the box would fail open,
 * silently), and a rule on the host means writing into an engine whose rules live in a VM. A
 * topology has neither problem. Root in the box has no `NET_ADMIN`, so it cannot add a route
 * (tried: EPERM), and frames handed straight to the gate's MAC for another destination are not
 * forwarded (tried; the gate also runs with forwarding off and no capabilities).
 *
 * Confinement applies when a relay is named and the orchestrator runs outside the box. A box
 * with no relay has nothing to be confined to and connects directly, as before; a box that
 * carries its own orchestrator needs the model provider and is left steered. `describeOutbound`
 * says which of these a box is, from what the engine reports rather than from what was asked.
 */

import { BOXD_PORT } from "../protocol/index.ts";
import { defaultChannelPorts } from "../egress/relay-cli.ts";

/** Runs one docker command and returns its trimmed output; throws when docker fails. */
export type DockerRunner = (args: string[], timeoutMs: number) => Promise<string>;

/** The name the box uses for this machine; the gate takes it on the box's network. */
const HOST_NAME = "host.docker.internal";

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

/** The container that forwards a confined box's few ports, and the ordinary network it reaches out on. */
export function gateNameFor(containerName: string): string {
  return `${containerName}-gate`;
}

export function gateNetworkNameFor(containerName: string): string {
  return `${containerName}-gate-net`;
}

export type OutboundPlan =
  | {
      confined: true;
      /** The relay as the operator named it; the gate dials this. */
      relay: string;
      relayPort: number;
      /** Ports on this machine the box may reach besides the relay's own. */
      hostPorts: readonly number[];
      relayToken?: string;
    }
  | {
      confined: false;
      why: "no-relay" | "opted-out" | "self-contained";
      /** Named but only steered to. */
      relay?: string;
      relayToken?: string;
    };

/**
 * What this box's outbound traffic should be, from how it is started.
 *
 * `AGENTBOX_EGRESS_ENFORCE=off` keeps a relay-named box on an ordinary network — for a tool
 * that cannot speak through an HTTP proxy — and is reported every time the box starts.
 */
export function outboundPlan(config: { isolated?: boolean; withHost?: boolean }, env: NodeJS.ProcessEnv): OutboundPlan {
  const relay = env.AGENTBOX_EGRESS_RELAY;
  if (config.isolated === true || relay === undefined || relay === "") return { confined: false, why: "no-relay" };
  const relayToken = env.AGENTBOX_EGRESS_TOKEN !== undefined && env.AGENTBOX_EGRESS_TOKEN !== "" ? env.AGENTBOX_EGRESS_TOKEN : undefined;
  const steered = (why: "opted-out" | "self-contained"): OutboundPlan => ({ confined: false, why, relay, ...(relayToken !== undefined ? { relayToken } : {}) });
  if (config.withHost === true) return steered("self-contained");
  if ((env.AGENTBOX_EGRESS_ENFORCE ?? "").trim().toLowerCase() === "off") return steered("opted-out");
  const relayPort = Number(relay.slice(relay.lastIndexOf(":") + 1));
  if (!relay.includes(":") || !Number.isInteger(relayPort) || relayPort < 1 || relayPort > 65535) {
    throw new Error(`AGENTBOX_EGRESS_RELAY must be host:port, got ${JSON.stringify(relay)}`);
  }
  const hostPorts = defaultChannelPorts(env).filter(port => port !== relayPort && port !== BOXD_PORT);
  return { confined: true, relay, relayPort, hostPorts, ...(relayToken !== undefined ? { relayToken } : {}) };
}

/**
 * The `docker run` arguments that put the box on its network.
 *
 * `publish` is the daemon's loopback publication. A confined box does not carry it — an
 * internal network publishes nothing — and the gate does instead.
 */
export function boxNetworkArguments(containerName: string, plan: OutboundPlan, publish: string): string[] {
  const token = plan.relayToken !== undefined ? ["--env", `AGENTBOX_EGRESS_TOKEN=${plan.relayToken}`] : [];
  if (plan.confined) {
    return ["--network", networkNameFor(containerName), "--env", `AGENTBOX_EGRESS_RELAY=${HOST_NAME}:${plan.relayPort}`, ...token];
  }
  return [
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
    publish,
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
    // reaches the internet through this network's own gateway — unless a relay is
    // named, when it is confined (above) and reaches only the gate.
    "--network",
    networkNameFor(containerName),
    // host.docker.internal resolves on Docker Desktop already; the mapping is what makes
    // the same name work on a Linux engine, so the relay address does not have to change
    // per platform. Always, not only with the egress relay: the MCP face (docs/33) reaches
    // this host by the same name, and on a Linux engine the name exists only through this
    // mapping.
    "--add-host",
    `${HOST_NAME}:host-gateway`,
    ...(plan.relay !== undefined ? ["--env", `AGENTBOX_EGRESS_RELAY=${plan.relay}`, ...token] : []),
  ];
}

/**
 * The gate's whole program: listen on each named port, pipe every connection to its target.
 *
 * Handed to `node -e` in the box image, with the rules (`listen=host:port,…`) as its one
 * argument, so the gate needs no image of its own and works with an image built before this
 * existed. It reads no traffic and has no other behaviour.
 */
export const GATE_SCRIPT = [
  'const net = require("net");',
  'process.on("SIGTERM", () => process.exit(0));',
  'for (const rule of (process.argv[1] || "").split(",").filter(Boolean)) {',
  '  const [listen, target] = rule.split("=");',
  '  const at = target.lastIndexOf(":");',
  "  net.createServer(inbound => {",
  "    const outbound = net.connect(Number(target.slice(at + 1)), target.slice(0, at));",
  "    const drop = () => { inbound.destroy(); outbound.destroy(); };",
  '    inbound.on("error", drop); outbound.on("error", drop);',
  "    inbound.pipe(outbound); outbound.pipe(inbound);",
  '  }).listen(Number(listen), "0.0.0.0", () => console.log("gate: :" + listen + " -> " + target));',
  "}",
].join("\n");

/** On the gate: what it forwards, so the startup line can say it without reading the program's arguments. */
const GATE_LABEL = "lumenbox.egress-gate";

/** What the gate forwards: the daemon inwards, the relay and the channel ports outwards. */
export function gateForwards(containerName: string, plan: Extract<OutboundPlan, { confined: true }>): string {
  const relayHost = plan.relay.slice(0, plan.relay.lastIndexOf(":"));
  return [
    `${BOXD_PORT}=${containerName}:${BOXD_PORT}`,
    `${plan.relayPort}=${relayHost}:${plan.relayPort}`,
    ...plan.hostPorts.map(port => `${port}=${HOST_NAME}:${port}`),
  ].join(",");
}

export function gateRunArguments(o: { containerName: string; image: string; publish: string; plan: Extract<OutboundPlan, { confined: true }> }): string[] {
  return [
    "run",
    "--detach",
    "--name",
    gateNameFor(o.containerName),
    "--label",
    `${GATE_LABEL}=${gateForwards(o.containerName, o.plan)}`,
    "--network",
    gateNetworkNameFor(o.containerName),
    // The daemon's publication, moved here from the box: same address, same port.
    "--publish",
    o.publish,
    "--add-host",
    `${HOST_NAME}:host-gateway`,
    // With the box, so an engine restart brings back both or the box has no way in or out.
    "--restart",
    "unless-stopped",
    // It pipes bytes: no capabilities, no writable filesystem, nobody's uid, and it is not a
    // router — only the listed ports cross it.
    "--cap-drop",
    "ALL",
    "--user",
    "65534:65534",
    "--read-only",
    "--sysctl",
    "net.ipv4.ip_forward=0",
    "--memory",
    "128m",
    "--entrypoint",
    "node",
    o.image,
    "-e",
    GATE_SCRIPT,
    gateForwards(o.containerName, o.plan),
  ];
}

const missing = (error: unknown) => /no such|not found/i.test(error instanceof Error ? `${error.message} ${(error as { stderr?: string }).stderr ?? ""}` : String(error));

async function inspect(run: DockerRunner, args: string[]): Promise<string | undefined> {
  try {
    return await run(args, 30_000);
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}

async function ensureNetwork(run: DockerRunner, name: string, internal: boolean): Promise<void> {
  const existing = await inspect(run, ["network", "inspect", "--format", "{{.Internal}}", name]);
  if (existing !== undefined && (existing === "true") === internal) return;
  // Left by a box that was started the other way. Nothing is on it — the box it belonged to
  // is gone, which is the only time this runs — and a network's kind cannot be changed.
  if (existing !== undefined) await run(["network", "rm", name], 30_000);
  try {
    await run(["network", "create", ...(internal ? ["--internal"] : []), name], 60_000);
  } catch (error) {
    // Two `box up` runs at once: "already exists" is the outcome we wanted.
    if (!/already exists/i.test(error instanceof Error ? error.message : String(error))) throw error;
  }
}

/**
 * The networks, and the gate when the box is to be confined, before a new box is run.
 *
 * Only called when the box does not exist, so a gate found here belonged to a box that is
 * gone and is replaced: it carries that box's image and port list.
 */
export async function prepareBoxNetwork(run: DockerRunner, o: { containerName: string; image: string; publish: string; plan: OutboundPlan }): Promise<void> {
  await removeGate(run, o.containerName);
  await ensureNetwork(run, networkNameFor(o.containerName), o.plan.confined);
  if (!o.plan.confined) return;
  await ensureNetwork(run, gateNetworkNameFor(o.containerName), false);
  await run(gateRunArguments({ ...o, plan: o.plan }), 120_000);
  // The alias is what the box resolves: the relay address and the face URL name this machine,
  // and on this network that name is the gate.
  await run(["network", "connect", "--alias", HOST_NAME, networkNameFor(o.containerName), gateNameFor(o.containerName)], 60_000);
}

/** Starts the gate of a box that is being started again. A box that has none is not confined, and nothing happens. */
export async function startGate(run: DockerRunner, containerName: string): Promise<void> {
  await inspect(run, ["start", gateNameFor(containerName)]);
}

export async function stopGate(run: DockerRunner, containerName: string): Promise<void> {
  await inspect(run, ["stop", "--timeout", "5", gateNameFor(containerName)]);
}

/** The gate and its network go with the box. Swallowed like the box's own network: a teardown whose container is gone must not fail on what is left. */
export async function removeGate(run: DockerRunner, containerName: string): Promise<void> {
  await run(["rm", "--force", gateNameFor(containerName)], 60_000).catch(() => undefined);
  await run(["network", "rm", gateNetworkNameFor(containerName)], 30_000).catch(() => undefined);
}

/**
 * One line for the startup log: what this box's outbound traffic is, as the engine has it.
 *
 * Read from the engine, not from the plan: a box created before a relay was named is still
 * on its ordinary network, and saying "confined" because the variable is set now would be
 * the silence this line exists to end.
 */
export async function describeOutbound(run: DockerRunner, containerName: string, plan: OutboundPlan): Promise<string> {
  const internal = (await inspect(run, ["network", "inspect", "--format", "{{.Internal}}", networkNameFor(containerName)])) === "true";
  const attached = (await inspect(run, ["inspect", "--format", "{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}", containerName])) ?? "";
  const only = attached.split(/\s+/).filter(Boolean);
  const gate = await inspect(run, ["inspect", "--format", `{{.State.Status}}|{{index .Config.Labels "${GATE_LABEL}"}}`, gateNameFor(containerName)]);
  const steered = "proxy variables and the browser's proxy setting point at the relay, and a command that ignores them connects directly";
  if (internal && only.length === 1 && only[0] === networkNameFor(containerName)) {
    // The first rule is the daemon's, inwards; the rest are the ways out.
    const forwards = (gate ?? "").slice((gate ?? "").indexOf("|") + 1).split(",").slice(1).map(rule => rule.slice(rule.indexOf("=") + 1));
    if (gate === undefined || !gate.startsWith("running|")) {
      return `outbound: confined, and cut off — the box is on an internal network and its gate ${gateNameFor(containerName)} is not running, so nothing gets in or out; start the box again or recreate it`;
    }
    return `outbound: confined — the box is on an internal network with no route out; only ${gateNameFor(containerName)} crosses it, forwarding to ${forwards.join(", ")}`;
  }
  if (plan.confined) {
    return `outbound: NOT confined — an egress relay is named, but this box was created on an ordinary network; ${steered}. Recreate the box (box up --recreate) to confine it`;
  }
  if (plan.why === "opted-out") return `outbound: NOT confined — AGENTBOX_EGRESS_ENFORCE=off; ${steered}`;
  if (plan.why === "self-contained") {
    return `outbound: NOT confined — the orchestrator runs inside this box and reaches its model directly; ${steered}`;
  }
  return "outbound: not confined — no egress relay is named (AGENTBOX_EGRESS_RELAY), so everything in the box connects to the internet directly and nothing records it";
}
