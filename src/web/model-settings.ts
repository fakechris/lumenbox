import { configCredentialSource } from "../config.ts";
import { OpenAIWireError } from "../host/openai-wire.ts";
import { defaultUserAgent, PRESET_MODELS, providerForChoice, providerNames, resolveProviderPreset, userAgentProblem, type ProviderProfile } from "../host/provider.ts";
import { apiError, type ApiError } from "./api-error.ts";

/**
 * The variables a model save writes for the settings that are not the provider, model or key: vision, the summary
 * model, and the User-Agent every model request sends (INV-2325). The provider resolver and provider.ts read them;
 * the page offers them as settings, stored in the file's env block under their own names only. A User-Agent that is
 * not one line of printable ASCII of at most 200 characters is refused, and nothing is written.
 */
export function modelSettingsEnv(body: { vision?: unknown; summaryModel?: unknown; userAgent?: unknown }): { env: Record<string, string | null> } | { refused: ApiError } {
  const text = (value: unknown) => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);
  const env: Record<string, string | null> = {};
  if (body.vision === "on" || body.vision === "off" || body.vision === "auto") env.AGENTBOX_VISION = body.vision === "on" ? "1" : body.vision === "off" ? "0" : null;
  if (body.summaryModel !== undefined) env.AGENTBOX_SUMMARY_MODEL = text(body.summaryModel);
  if (body.userAgent !== undefined) {
    const userAgent = text(body.userAgent), problem = userAgent === null ? undefined : userAgentProblem(userAgent);
    if (problem !== undefined) return { refused: apiError(`user-agent-${problem}`) };
    env.AGENTBOX_USER_AGENT = userAgent;
  }
  return { env };
}

/** What Settings shows of the User-Agent: the saved one, if any, and LumenBox's own for the placeholder. */
export function userAgentSettings(env: Record<string, string> | undefined): { userAgent: string | null; userAgentDefault: string } {
  return { userAgent: env?.AGENTBOX_USER_AGENT ?? null, userAgentDefault: defaultUserAgent() };
}

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
