import { loadConfig as loadAnthropicConfig } from "@anthropic-ai/sdk/core/credentials";
import { hasCredential, type ProviderProfile } from "./provider.ts";

/** Refuse only a known absence, without making a model request or refreshing a token. */
export async function modelConfigured(
  profile: ProviderProfile,
  credentialPresent = hasCredential(profile),
  defaultConfig: () => Promise<unknown> = loadAnthropicConfig,
): Promise<boolean> {
  if (credentialPresent) return true;
  if (profile.baseUrl) {
    try {
      if (["localhost", "127.0.0.1", "[::1]"].includes(new URL(profile.baseUrl).hostname)) return true;
    } catch { return true; }
  }
  if (profile.keyEnv !== "ANTHROPIC_API_KEY") return false;
  try {
    return (await defaultConfig()) !== null;
  } catch {
    return true;
  }
}
