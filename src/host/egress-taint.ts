/**
 * The taint rule (INV-1309): a turn that has read private material does not get to carry it out
 * of the box unasked.
 *
 * The egress relay says which hosts a box may reach (bundles' `egressHosts`) and hard-denies
 * the dangerous ones (INV-1224); the policy gate says which actions a person must approve. The
 * two never met: "this turn just resolved a vault secret" changed nothing about whether the
 * next `curl` to a host nobody listed would be asked about. The rule fits in one line: once
 * private data was read in this chat, any call that can egress outside the allow list asks,
 * whatever the mode. This is that rule, in the shape of
 * our gate: the taint is a fact about the turn, recorded by the tool that read the secret; the
 * gate asks when a tainted turn's call would leave the box for a host outside the allow list;
 * the approval is once-only, because "always" for an exfiltration path is not a thing a card
 * should offer.
 *
 * Deliberately narrow:
 *   - **Only outside the allow list.** A tainted turn posting to the API the box exists to talk
 *     to is the job; asking there would teach people to click through.
 *   - **No whitelist means nothing is whitelisted.** The relay reads an empty list as "any host"
 *     because it has nothing to compare against; this rule reads it as "no host was named", which
 *     is the safe reading when the question is whether a secret may leave.
 *   - **Unknown is outside.** A shell command that reaches the network with a host this parser
 *     cannot see still asks: refusing to recognise a host must not be a way to pass.
 *   - **Package managers are not counted.** `pip`, `npm`, `apt` reach their registries on every
 *     install; counting them would make a tainted turn unable to build anything. A registry is
 *     an unlikely drop point and the relay still bounds where they go.
 */
import { MCP_SEPARATOR } from "./mcp.ts";
import { sideEffectOf } from "./side-effects.ts";
import { permitted } from "../egress/relay.ts";

/**
 * What a turn read that makes its outbound calls a question. `vault`: a secret, so leaving the
 * allow list asks (INV-1309). `outside`: content from outside the box (a page, a search, a
 * connector's or an MCP server's result), so the first call to a service this turn has not used
 * yet asks (INV-1366) — even a read sends its arguments, which the outside text may have chosen.
 */
export type TaintSource = "vault" | "outside";

const SOURCE_TEXT: Record<TaintSource, string> = {
  vault: "a vault secret",
  outside: "content from outside the box",
};

/** What the gate learned about a call: why the turn is tainted and where the call would go. */
export interface Taint {
  sources: TaintSource[];
  /** Where the call would reach, in the words the card and the record use. */
  target: string;
  /** Which rule asked: leaving the allow list (default) or a service's first use this turn. */
  rule?: "egress" | "first-use";
}

/** Where a call would reach: hosts the host could read off the input, or a target it could not. */
export type Outbound = { hosts: string[] } | { unknown: string };

/**
 * The turns that read private material, by turn id. In memory, bounded: a turn id is unique
 * and a turn is over within hours, so there is nothing to persist and nothing to grow.
 */
export class TurnTaint {
  private readonly turns = new Map<string, Set<TaintSource>>();
  /** The services (MCP servers, connectors) each turn has already called, for the first-use rule. */
  private readonly used = new Map<string, Set<string>>();

  /** Records that this turn called the service; a later call to it is not a first use. */
  markUsed(turnId: string, service: string): void {
    if (turnId === "") return;
    const set = this.used.get(turnId) ?? new Set<string>();
    set.add(service);
    this.used.delete(turnId);
    this.used.set(turnId, set);
    if (this.used.size > 512) this.used.delete(this.used.keys().next().value!);
  }

  hasUsed(turnId: string | undefined, service: string): boolean {
    return turnId !== undefined && (this.used.get(turnId)?.has(service) ?? false);
  }

  mark(turnId: string, source: TaintSource): void {
    if (turnId === "") return;
    const set = this.turns.get(turnId) ?? new Set<TaintSource>();
    set.add(source);
    this.turns.delete(turnId);
    this.turns.set(turnId, set);
    if (this.turns.size > 512) this.turns.delete(this.turns.keys().next().value!);
  }

  sourcesOf(turnId: string | undefined): TaintSource[] {
    if (turnId === undefined) return [];
    return [...(this.turns.get(turnId) ?? [])];
  }
}

const SCHEME_URL = /\b[a-z][a-z0-9+.-]*:\/\/(?:[^@\s'"/]+@)?([^\s'"/:?#]+)(?::(\d+))?/gi;
/** Commands that reach the network by themselves; a line with one and no readable host is "unknown". */
const NETWORK_WORDS = /(^|[\s;&|(])(curl|wget|ssh|scp|sftp|rsync|ftp|nc|ncat|telnet|socat|openssl)(\s|$)/;
const GIT_REMOTE = /(^|[\s;&|(])git\s+(push|pull|fetch|clone|ls-remote|remote\s+add)(\s|$)/;
const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[?::1\]?|0\.0\.0\.0)$/i;

function hostsInCommand(command: string): { hosts: string[]; named: boolean } {
  const hosts = new Set<string>();
  for (const match of command.matchAll(SCHEME_URL)) hosts.add(match[1]!.toLowerCase());
  // ssh/scp/rsync/sftp targets: `user@host`, `host:path`; for ssh and sftp also a bare host,
  // since their first non-flag argument is the machine (for scp and rsync it may be a local path).
  for (const match of command.matchAll(/(^|[\s;&|(])(ssh|scp|sftp|rsync)\s+([^;&|]*)/g)) {
    const verb = match[2]!;
    const args = match[3]!.split(/\s+/).filter(arg => arg !== "");
    let skip = false;
    for (const arg of args) {
      if (skip) { skip = false; continue; }
      if (arg.startsWith("-")) { skip = /^-[pPlioFJ]$/.test(arg) || /^--(port|login-name|identity|rsh)$/.test(arg); continue; }
      if (arg.includes("://") || arg.startsWith("'") || arg.startsWith('"')) continue;
      const at = arg.lastIndexOf("@");
      const target = at >= 0 ? arg.slice(at + 1) : arg;
      const colon = target.indexOf(":");
      const host = colon > 0 ? target.slice(0, colon) : at >= 0 || ((verb === "ssh" || verb === "sftp") && target.includes(".")) ? target : "";
      if (host !== "" && !host.includes("/")) hosts.add(host.toLowerCase());
      if (verb === "ssh" || verb === "sftp") break;
    }
  }
  for (const match of command.matchAll(/(^|[\s;&|(])(curl|wget|nc|ncat|telnet)\s+((?:-\S+(?:\s+\S+)?\s+)*)([a-z0-9.-]+\.[a-z]{2,}|\d{1,3}(?:\.\d{1,3}){3})(\s|:|\/|$)/gi)) {
    hosts.add(match[4]!.toLowerCase());
  }
  return { hosts: [...hosts].filter(host => !LOOPBACK.test(host)), named: hosts.size > 0 };
}

/** Where a call would reach, or undefined when it does not leave the box. */
export function outboundOf(tool: string, input: Record<string, unknown>): Outbound | undefined {
  const urlHost = (value: unknown): Outbound | undefined => {
    if (typeof value !== "string" || value.trim() === "") return undefined;
    try {
      const host = new URL(value.trim()).hostname.toLowerCase();
      return LOOPBACK.test(host) ? undefined : { hosts: [host] };
    } catch {
      return { unknown: "an address the host could not read" };
    }
  };
  switch (tool) {
    case "WebFetch":
    case "browser_open":
      return urlHost(input.url);
    case "WebSearch":
      return { unknown: "the web search provider" };
    case "bash":
    case "RunOnHost": {
      const command = typeof input.command === "string" ? input.command : "";
      const { hosts, named } = hostsInCommand(command);
      if (hosts.length > 0) return { hosts };
      // Every host it named was loopback: the box's own services, not outside.
      if (named) return undefined;
      if (NETWORK_WORDS.test(command) || GIT_REMOTE.test(command)) return { unknown: "a host this command names in a way the gate cannot read" };
      return undefined;
    }
    case "Delegate":
      return { unknown: "a delegated engine, which has a network of its own" };
    case "browser_upload":
      return { unknown: "the web page currently open" };
    // The person's own connected service, called as them: not a drop point for their own secret.
    case "connector_request":
      return undefined;
    default:
      break;
  }
  if (tool.includes(MCP_SEPARATOR)) return { unknown: `${tool.slice(0, tool.indexOf(MCP_SEPARATOR))}, a service outside the box` };
  const effect = sideEffectOf(tool, input);
  if (effect.tier === "reach") return { unknown: effect.action ?? "somewhere outside the box" };
  return undefined;
}

/** Whether every host is on the allow list. An empty list names nobody. */
export function allHostsAllowed(hosts: readonly string[], allow: readonly string[], port = 443): boolean {
  if (allow.length === 0) return false;
  return hosts.every(host => permitted({ host, port }, allow));
}

/**
 * The taint on one call, or undefined when there is nothing to ask about: the turn read
 * nothing private, the call stays in the box, or it goes only where the allow list says.
 */
export function taintOf(
  call: { tool: string; input: Record<string, unknown>; turnId?: string },
  taint: TurnTaint,
  allow: readonly string[]
): Taint | undefined {
  const sources = taint.sourcesOf(call.turnId);
  if (sources.length === 0) return undefined;
  // The egress rule is the vault's: a turn that only read a web page must still be able to browse.
  if (sources.includes("vault")) {
    const outbound = outboundOf(call.tool, call.input);
    if (outbound !== undefined) {
      if (!("hosts" in outbound)) return { sources, target: outbound.unknown };
      if (!allHostsAllowed(outbound.hosts, allow)) return { sources, target: outbound.hosts.join(", ") };
    }
  }
  if (sources.includes("outside")) {
    const service = serviceOf(call.tool, call.input);
    if (service !== undefined && !taint.hasUsed(call.turnId, service.key)) {
      return { sources: ["outside"], target: service.label, rule: "first-use" };
    }
  }
  return undefined;
}

/**
 * The outside service a call talks to, keyed for the first-use rule: an MCP server by name, a
 * connector by its id. Built-in tools that stay in the box, or reach the web through the relay's
 * own rules, are not services here.
 */
export function serviceOf(tool: string, input: Record<string, unknown>): { key: string; label: string } | undefined {
  if (tool.includes(MCP_SEPARATOR)) {
    const server = tool.slice(0, tool.indexOf(MCP_SEPARATOR));
    return { key: `mcp:${server}`, label: `the ${server} MCP server` };
  }
  if (tool === "connector_request") {
    const connector = String(input.connector ?? "").trim().toLowerCase();
    return connector === "" ? undefined : { key: `connector:${connector}`, label: `the ${connector} connector` };
  }
  return undefined;
}

/** The card's and the record's words for a taint: the kind of thing read, never its content. */
export function describeTaint(taint: Taint): string {
  const read = taint.sources.map(source => SOURCE_TEXT[source]).join(" and ");
  if (taint.rule === "first-use") return `[tainted: this turn read ${read}; this is its first call to ${taint.target}]`;
  return `[tainted: this turn read ${read}; ${taint.target} is outside the box's egress allow list]`;
}

/**
 * After a call is allowed (INV-1366): it is a use of its service, and a call that reads outside
 * content taints the turn from here on. Marked after the call's own check, so the read itself is
 * not asked about; the next first use of another service is.
 */
export function noteAllowedCall(
  taint: TurnTaint,
  call: { tool: string; input: Record<string, unknown>; turnId?: string },
  externalTool: ((tool: string) => boolean) | undefined
): void {
  if (call.turnId === undefined) return;
  const service = serviceOf(call.tool, call.input);
  if (service !== undefined) taint.markUsed(call.turnId, service.key);
  if (externalTool?.(call.tool) === true) taint.mark(call.turnId, "outside");
}
