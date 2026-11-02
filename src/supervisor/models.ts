/**
 * Which model a supervisor run talks to (INV-1528): a provider from the app's catalog and a model
 * id, both from Settings → Supervision. The key is the provider's own (`keyEnv`), read by the
 * caller that is allowed to read the environment. OpenAI's own endpoint with a gpt-6 model goes
 * through the Responses API; everything else through the Messages adapter.
 */

import { createClient, providerNames, resolveProvider, type ProviderProfile } from "../host/provider.ts";
import { messagesAdapter } from "./messages.ts";
import { type ModelAsk, openaiResponses } from "./openai.ts";

export interface SupervisorModel {
  provider: string;
  model: string;
}

export function usesResponses(profile: Pick<ProviderProfile, "baseUrl">, model: string): boolean {
  return (profile.baseUrl ?? "").startsWith("https://api.openai.com") && /^(gpt-6|o\d)/.test(model);
}

/** The catalog as the settings page shows it: which providers have a key, and their default model. */
export function supervisorProviders(keyFor: (env: string) => string | undefined): { name: string; label: string; hasKey: boolean; defaultModel: string }[] {
  return providerNames().filter(name => name !== "custom").map(name => {
    const profile = resolveProvider(name);
    return { name, label: profile.label, hasKey: (keyFor(profile.keyEnv) ?? "") !== "", defaultModel: profile.model };
  });
}

/** The model for a run, or why there is none. */
export function supervisorModel(choice: SupervisorModel, keyFor: (env: string) => string | undefined): { ask: ModelAsk } | { error: string } {
  if (!providerNames().includes(choice.provider)) return { error: `no provider named ${choice.provider}` };
  const profile = { ...resolveProvider(choice.provider), model: choice.model };
  const key = keyFor(profile.keyEnv);
  if (key === undefined || key === "") return { error: `no key for ${profile.label} (${profile.keyEnv}); set it in Settings → Model` };
  if (usesResponses(profile, choice.model)) return { ask: openaiResponses({ token: key, model: choice.model }) };
  try {
    return { ask: messagesAdapter(createClient(profile), choice.model) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
