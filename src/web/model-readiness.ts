import type { AgentRegistry } from "../agents/registry.ts";
import { effectiveProviderFor, modelConfigured, type ProviderProfile } from "../host/provider.ts";

export function modelReady(registry: AgentRegistry, provider: ProviderProfile, agentId: string): Promise<boolean> {
  return modelConfigured(effectiveProviderFor(registry.get(agentId).profile, provider));
}
