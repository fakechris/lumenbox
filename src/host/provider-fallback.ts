/**
 * When the agent's provider is out of usage, the turn goes on with another one (INV-1578).
 *
 * On 2026-11-04 the installation's only provider ran out of its plan and every agent stopped where
 * it was. A person may name up to three fallback providers, from the ones already configured with a
 * key: for the installation (`fallbackProviders` in config.json), or for one agent (the same field
 * on its profile, which wins). When a model call answers `usage_limit` — or is refused without a
 * call because the account is resting (INV-1577) — the same round is sent to the next fallback that
 * is not resting itself and has not been tried in this turn. The turn's messages so far go with it,
 * so the fallback sees everything the turn already did. Each provider is tried at most once a turn.
 *
 * The switch is said in the chat (which provider and model answers now, and its price where one is
 * configured), spend is recorded under the provider that answered, and the next turn starts on the
 * agent's own provider again: back on it as soon as it answers.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { agentboxHome } from "../config.ts";
import { accountFor, createClient, resolveProvider, type ProviderProfile } from "./provider.ts";
import { providerRests, type ProviderRests } from "./provider-rest.ts";
import type { Rates } from "./spend.ts";

export const MAX_FALLBACKS = 3;

export interface Runtime {
  client: Anthropic;
  provider: ProviderProfile;
}

/** The names to fall back to: the agent's own list, else the installation's; at most three, never the primary. */
export function fallbackNames(agentList: readonly string[] | undefined, installationList: readonly string[] | undefined, primary: ProviderProfile): string[] {
  const names = (agentList !== undefined && agentList.length > 0 ? agentList : installationList ?? []).map(name => name.trim()).filter(Boolean);
  return [...new Set(names)].filter(name => resolveProvider(name).label !== primary.label || resolveProvider(name).model !== primary.model).slice(0, MAX_FALLBACKS);
}

/** Clients for fallback providers, built once each. A preset with no key is left out and said once. */
export class FallbackRuntimes {
  private readonly cache = new Map<string, Runtime | null>();
  constructor(private readonly log: (line: string) => void = line => console.error(line), private readonly build: (profile: ProviderProfile) => Anthropic = createClient) {}

  for(names: readonly string[]): Runtime[] {
    const runtimes: Runtime[] = [];
    for (const name of names) {
      if (!this.cache.has(name)) {
        try {
          const provider = resolveProvider(name);
          this.cache.set(name, { client: this.build(provider), provider });
        } catch (error) {
          this.log(`[fallback] ${name} is not usable as a fallback: ${error instanceof Error ? error.message : String(error)}`);
          this.cache.set(name, null);
        }
      }
      const runtime = this.cache.get(name);
      if (runtime) runtimes.push(runtime);
    }
    return runtimes;
  }
}

/** The next fallback to send this round to: not tried in this turn, not resting itself. */
export function nextFallback(fallbacks: readonly Runtime[], tried: ReadonlySet<string>, rests: ProviderRests = providerRests): Runtime | undefined {
  return fallbacks.find(runtime => !tried.has(keyOf(runtime.provider)) && !rests.resting(accountFor(runtime.provider)));
}

export function keyOf(provider: ProviderProfile): string {
  return `${provider.label}\0${provider.model}\0${provider.baseUrl ?? ""}`;
}

/** The chat line for a switch: who answers now, and at what price where one is configured. */
export function switchLine(from: ProviderProfile, to: ProviderProfile, rates: Rates = configuredRates()): string {
  const rate = rates[to.model];
  const price = rate !== undefined ? `$${rate.inputPerM}/M in · $${rate.outputPerM}/M out` : "no price configured for it";
  return `${from.label} is out of usage; this turn continues on ${to.label} ${to.model} (${price}). The next turn tries ${from.label} again.`;
}

function configuredRates(): Rates {
  try {
    return (JSON.parse(readFileSync(join(agentboxHome(), "config.json"), "utf8")) as { rates?: Rates }).rates ?? {};
  } catch {
    return {};
  }
}
