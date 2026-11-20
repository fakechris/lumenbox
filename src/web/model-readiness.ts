import type { AgentRegistry } from "../agents/registry.ts";
import { effectiveProviderFor, type ProviderProfile } from "../host/provider.ts";
import { modelConfigured } from "../host/model-readiness.ts";

export function modelReady(registry: AgentRegistry, provider: ProviderProfile, agentId: string): Promise<boolean> {
  return modelConfigured(effectiveProviderFor(registry.get(agentId).profile, provider));
}

export async function modelReadinessRoute(
  route: string,
  url: URL,
  registry: AgentRegistry,
  provider: ProviderProfile,
  refused: (agentId: string) => boolean,
  send: (body: { configured: boolean }) => void,
): Promise<boolean> {
  if (route !== "GET /api/model-readiness") return false;
  const id = url.searchParams.get("agent") ?? "";
  if (!refused(id)) send({ configured: await modelReady(registry, provider, id) });
  return true;
}
