/**
 * What no allow list can switch on (INV-1224, after SPACE's gateway order: platform hard
 * refusals first, then explicit deny, then explicit allow, then the default).
 *
 * Two targets are refused before any list is consulted, because a list is an operator's
 * convenience and these are not conveniences:
 *
 *   - **cloud metadata**: 169.254.0.0/16 (AWS, Azure, Alibaba, Tencent IMDS), `fd00:ec2::254`,
 *     `metadata.google.internal` and `metadata` — on a cloud VM a request there returns the
 *     instance's own credentials to whatever asked;
 *   - **the host itself**: loopback, the bridge's names for the host (`host.docker.internal`,
 *     `host.lima.internal`, `gateway.docker.internal`), except the ports that are channels on
 *     purpose — the web port (the MCP face and the model relay live behind it) and the egress
 *     relay's own port, which the operator names.
 *
 * This decides for traffic that comes through the egress relay. Traffic the box sends directly
 * (not through the proxy) is not decided here; docs/06 §9 says what each platform lets through.
 */

import { classifyAddress, plainAddress } from "./address.ts";

const METADATA_NAMES = new Set(["metadata.google.internal", "metadata", "instance-data", "fd00:ec2::254", "[fd00:ec2::254]"]);
const HOST_NAMES = new Set(["localhost", "host.docker.internal", "host.lima.internal", "gateway.docker.internal", "docker.for.mac.localhost", "0.0.0.0", "::1", "[::1]", "::", "[::]"]);

function linkLocalV4(host: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  return match !== null && Number(match[1]) === 169 && Number(match[2]) === 254;
}

function loopbackV4(host: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  return match !== null && Number(match[1]) === 127;
}

export interface HardDenyOptions {
  /** Host ports that are channels on purpose: the web port and the egress relay's own port. */
  channelPorts: readonly number[];
}

/** The reason this target is refused outright, or undefined when the allow list may decide. */
export function hardDenied(host: string, port: number, options: HardDenyOptions): string | undefined {
  const name = host.trim().toLowerCase().replace(/\.$/, "");
  if (linkLocalV4(name) || METADATA_NAMES.has(name)) return "cloud metadata address";
  if (loopbackV4(name) || HOST_NAMES.has(name)) {
    if (options.channelPorts.includes(port)) return undefined;
    return `host port ${port} is not an explicit channel (channels: ${options.channelPorts.join(", ") || "none"})`;
  }
  return undefined;
}

/**
 * The same two refusals for an address a name *resolved to* (INV-1343). `hardDenied` reads the
 * host the box named; an allow-listed name whose DNS answer is 169.254.169.254 or 127.0.0.1
 * got past it, so the relay asks this about every answer before it dials one.
 */
export function hardDeniedAddress(address: string, port: number, options: HardDenyOptions): string | undefined {
  const plain = plainAddress(address);
  const kind = classifyAddress(plain);
  if (kind === "link-local" || METADATA_NAMES.has(plain)) return "cloud metadata address";
  if (kind === "loopback" || kind === "unspecified") {
    if (options.channelPorts.includes(port)) return undefined;
    return `host port ${port} is not an explicit channel (channels: ${options.channelPorts.join(", ") || "none"})`;
  }
  return undefined;
}
