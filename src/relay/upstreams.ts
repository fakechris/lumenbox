/**
 * Where the relay's real credentials live, and nowhere else.
 *
 * One upstream per provider the operator has a key for. A box's relay token names which one it may
 * use, so a box cannot reach a provider it was not issued for, and cannot move itself to a more
 * expensive model family by editing its own configuration.
 *
 * The keys come from the relay process's environment, which is the same place they used to come from
 * for the box — the difference is *which* process. Moving them one hop out is the whole point: the
 * relay has no shell, no agent, and nothing that executes model output.
 */

import { resolveProvider, providerNames, MissingCredentialError } from "../host/provider.ts";
import type { Upstream } from "./server.ts";

/**
 * Builds an upstream from a provider name, reusing the provider table.
 *
 * Reused rather than re-declared so a provider added there is available here without a second
 * definition drifting from the first — base URL and auth style are exactly the facts that must not
 * disagree between the two.
 */
export function upstreamFor(providerName: string): Upstream {
  const profile = resolveProvider(providerName);
  const key = process.env[profile.keyEnv];
  if (key === undefined || key.trim() === "") {
    throw new MissingCredentialError(profile);
  }
  return {
    label: providerName.toLowerCase(),
    // The SDK's own default when a profile names none, since the relay has to send somewhere
    // explicit and cannot fall back to a library default.
    baseUrl: (profile.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, ""),
    key: key.trim(),
    auth: profile.auth,
  };
}

/**
 * Every upstream the environment can supply, by provider name.
 *
 * Providers without a key are skipped rather than failing the relay: an operator with one credential
 * should be able to run this, and a relay that refused to start because it could not serve *every*
 * provider would be useless to them. What is skipped is logged, because a box issued a token for a
 * provider the relay cannot serve would otherwise fail at the worst moment with an unhelpful error.
 */
export function availableUpstreams(log: (line: string) => void = () => {}): Map<string, Upstream> {
  const upstreams = new Map<string, Upstream>();
  for (const name of providerNames()) {
    // `custom` is configured entirely by environment and is a description of a provider rather than
    // one: including it would mean an upstream whose identity depends on when it was read.
    if (name === "custom") continue;
    try {
      upstreams.set(name.toLowerCase(), upstreamFor(name));
    } catch (error) {
      log(`no upstream for ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return upstreams;
}
