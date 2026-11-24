import { configCredentialSource } from "../config.ts";
import { OpenAIWireError } from "../host/openai-wire.ts";
import { PRESET_MODELS, providerForChoice, providerNames, resolveProviderPreset, type ProviderProfile } from "../host/provider.ts";
import { apiError } from "./api-error.ts";

export function modelPresets(active: ProviderProfile) {
  return providerNames().map(name => {
    const { label, model, keyEnv } = providerForChoice(name, active);
    const keySource = configCredentialSource(keyEnv) ??
      (keyEnv === "ANTHROPIC_API_KEY" ? configCredentialSource("ANTHROPIC_AUTH_TOKEN") : null);
    return { name, label, model, keyEnv, keySource, keyPresent: keySource !== null, models: PRESET_MODELS[name] ?? [] };
  });
}

export function modelTestError(provider: string, error: unknown) {
  const other = provider.endsWith("-global") ? provider.slice(0, -7) : provider + "-global";
  if (typeof error === "object" && error !== null && "status" in error && error.status === 401) {
    const alternate = resolveProviderPreset(other);
    if (alternate && resolveProviderPreset(provider)) return apiError("model-test-region", { provider: alternate.label });
  }
  if (error instanceof OpenAIWireError && error.parameterError) {
    return apiError("model-test-parameter");
  }
  return { error: error instanceof Error ? error.message : String(error) };
}
