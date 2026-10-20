/**
 * The `agentbox egress relay` flags, read into relay options — here rather than in cli.ts, which
 * the architecture ratchet (INV-1225) holds at its length. Pure: flags and an environment in,
 * options out, so the reading is testable without a process.
 */
export interface RelayCliOptions {
  port?: number;
  host?: string;
  allow?: string[];
  /** Host ports a box may reach through the relay (INV-1224): the web port by default; the relay adds its own. */
  channelPorts: number[];
  /** Where decisions are written; undefined means the default path. */
  eventsPath?: string;
}

export function relayOptionsFromFlags(flags: Map<string, unknown>, env: NodeJS.ProcessEnv): RelayCliOptions {
  const text = (name: string) => (typeof flags.get(name) === "string" ? (flags.get(name) as string) : undefined);
  const list = (value: string | undefined) => value?.split(",").map(entry => entry.trim()).filter(Boolean);
  const hostPorts = list(text("--host-ports"))?.map(Number).filter(port => Number.isInteger(port) && port > 0);
  return {
    ...(text("--port") !== undefined ? { port: Number(text("--port")) } : {}),
    ...(text("--host") !== undefined ? { host: text("--host")! } : {}),
    ...(list(text("--allow")) !== undefined ? { allow: list(text("--allow"))! } : {}),
    // The web port is where the MCP face and the model relay live; everything else on the
    // host, and every cloud metadata address, is refused before the allow list (hard-deny.ts).
    channelPorts: hostPorts !== undefined && hostPorts.length > 0 ? hostPorts : [Number(env.AGENTBOX_PORT ?? 7777)],
    ...(text("--events") !== undefined ? { eventsPath: text("--events")! } : {}),
  };
}
