/**
 * Poppy on this host: whether it is on, and the manager a turn's Poppy tools use.
 *
 * Nothing here touches ordinary web use. WebFetch and the browser carry no Poppy header and ask no
 * site for poppy.json: a Company is discovered when an agent asks (PoppyDiscover, or the first
 * PoppyRequest or PoppyConverse naming it), and signed requests go only through those tools, to
 * that Company's destinations (poppy/destinations.ts). Browser Join happens only for a Company
 * already discovered.
 */

import { PoppyManager } from "./poppy/manager.ts";

/** What a turn takes from Poppy: the manager its tools use. */
export interface PoppyDeps {
  poppyManager: PoppyManager;
}

/** Poppy on this host, made once: the manager, and the deps for one agent's turn. */
export interface Poppy {
  poppyManager: PoppyManager;
  forAgent(agentId: string): PoppyDeps;
}

/**
 * Poppy for this host, or undefined when it is off — which is unless AGENTBOX_POPPY=1, and only
 * with an https:// AGENTBOX_PUBLIC_URL, because a Company cannot verify a session signed by a host
 * it cannot reach (it fetches the agent's keys and UCP profile from there). Off, no key is made and
 * no tool is offered (docs/poppy.md); on, the key is made the first time a Poppy tool runs.
 */
export function poppyFor(env: Readonly<Record<string, string | undefined>>, home: string, log: (line: string) => void): Poppy | undefined {
  const origin = env.AGENTBOX_PUBLIC_URL?.trim().replace(/\/+$/, "");
  if (env.AGENTBOX_POPPY !== "1" || origin?.startsWith("https://") !== true) return undefined;
  // Made lazily: nothing is written until a Poppy tool first needs the identity.
  const manager = new PoppyManager({ home, origin });
  log(`poppy: on, as ${origin}/poppy/agent.json`);
  return { poppyManager: manager, forAgent: () => ({ poppyManager: manager }) };
}
