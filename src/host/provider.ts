/**
 * Model providers.
 *
 * The Anthropic Messages API has become a de facto interface that several vendors
 * implement, so pointing agentbox at one is mostly a base URL and a key. The part
 * that is not interchangeable is *capability*: a compatible endpoint will happily
 * accept a request containing things it does not implement and return 200.
 *
 * MiniMax is the worked example. It accepts `thinking`, `output_config.effort`,
 * `cache_control`, and image content blocks without complaint — and then silently
 * discards the images. Asked what colour fills a solid red picture, MiniMax-M2
 * replies "I'm unable to view the image" while its thinking says "no image is
 * provided". Nothing in the HTTP response reveals this.
 *
 * That failure mode is why capabilities are declared here rather than probed or
 * assumed. An agent that cannot see is not given the computer tool at all, and is
 * told why, instead of being handed screenshots it will hallucinate about.
 */

import { envNumber } from "../config.ts";
import Anthropic from "@anthropic-ai/sdk";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ProviderProfile {
  /** Shown in the CLI so it is never ambiguous which endpoint is in use. */
  label: string;
  /** Omitted for first-party Anthropic, where the SDK default is correct. */
  baseUrl?: string;
  model: string;
  /** The cap on *output* tokens for one response. Not the context window; see `contextWindow`. */
  maxTokens: number;
  /**
   * How much the model can be sent, total. Drives compaction.
   *
   * Only set where it is actually known. Left undefined otherwise on purpose: a wrong number here
   * either wastes most of the context or overruns it, and both fail late and confusingly.
   * Compaction falls back to a conservative constant when this is absent, and prefers whatever the
   * endpoint reports at runtime over either — see `src/host/compaction.ts`.
   *
   * `AGENTBOX_CONTEXT_WINDOW` overrides it for a custom endpoint.
   */
  contextWindow?: number;

  /**
   * Whether the model can actually see image content blocks.
   *
   * False withholds the computer tool: a blind agent driving a desktop is worse
   * than one that knows it cannot.
   */
  vision: boolean;
  /** Claude-only request fields. Sent only where they mean something. */
  adaptiveThinking: boolean;
  effort: boolean;
  promptCaching: boolean;

  /**
   * How the key is presented. Third-party endpoints generally want
   * `Authorization: Bearer`; Anthropic wants `x-api-key`.
   */
  auth: "x-api-key" | "bearer";
  /** Env var holding the credential. */
  keyEnv: string;
}

const ANTHROPIC: ProviderProfile = {
  label: "Anthropic",
  model: "claude-opus-5",
  maxTokens: 64_000,
  contextWindow: 1_000_000,
  vision: true,
  adaptiveThinking: true,
  effort: true,
  promptCaching: true,
  auth: "x-api-key",
  keyEnv: "ANTHROPIC_API_KEY",
};

/**
 * Which MiniMax models can actually see an image.
 *
 * Vision is a property of the model, not the endpoint, and the two models on this
 * endpoint differ: M3 read a real 1280x800 WebP screenshot back correctly, while
 * M2 accepted the same image and answered "I'm unable to view the image". Both
 * returned 200. Anything not listed here is assumed blind, because that is the
 * assumption whose failure is visible.
 */
const MINIMAX_VISION_MODELS = new Set(["MiniMax-M3"]);

const MINIMAX: ProviderProfile = {
  label: "MiniMax",
  baseUrl: "https://api.minimaxi.com/anthropic",
  model: "MiniMax-M3",
  // Thinking counts against the cap, so a tight budget yields an empty response
  // with stop_reason max_tokens rather than an answer.
  maxTokens: 32_000,
  // Deliberately unset: this endpoint's window is not documented anywhere I could verify, and
  // guessing it is worse than falling back to the conservative default.
  vision: true,
  // Accepted but not implemented. Omitted so behaviour is not left to chance.
  adaptiveThinking: false,
  effort: false,
  promptCaching: false,
  auth: "bearer",
  keyEnv: "MINIMAX_CODE_CN_API_KEY",
};

/**
 * Other vendors' Anthropic-compatible endpoints.
 *
 * Each is the vendor's own documented compatibility endpoint, not a proxy. All the
 * capability flags start false for the same reason MiniMax's do: a compatible endpoint
 * accepts what it does not implement and returns 200, so a wrong "yes" fails silently
 * while a wrong "no" merely costs a feature and says so. `AGENTBOX_VISION=1` opts a
 * capable model in without a code change.
 */
const DEEPSEEK: ProviderProfile = {
  label: "DeepSeek",
  baseUrl: "https://api.deepseek.com/anthropic",
  model: "deepseek-chat",
  maxTokens: 8_000,
  vision: false,
  adaptiveThinking: false,
  effort: false,
  promptCaching: false,
  auth: "bearer",
  keyEnv: "DEEPSEEK_API_KEY",
};

const KIMI: ProviderProfile = {
  label: "Kimi",
  baseUrl: "https://api.moonshot.cn/anthropic",
  model: "kimi-k2-turbo-preview",
  maxTokens: 32_000,
  vision: false,
  adaptiveThinking: false,
  effort: false,
  promptCaching: false,
  auth: "bearer",
  keyEnv: "MOONSHOT_API_KEY",
};

const GLM: ProviderProfile = {
  label: "GLM",
  baseUrl: "https://open.bigmodel.cn/api/anthropic",
  model: "glm-4.6",
  maxTokens: 32_000,
  vision: false,
  adaptiveThinking: false,
  effort: false,
  promptCaching: false,
  auth: "bearer",
  keyEnv: "ZHIPU_API_KEY",
};

/**
 * Model suggestions per preset, for the settings dialog's picker.
 *
 * Suggestions, not a gate: the field stays free text because vendors ship models
 * faster than this list updates, and refusing a model name this file has not heard of
 * would make the product wrong the day a vendor ships.
 */
export const PRESET_MODELS: Record<string, readonly string[]> = {
  anthropic: ["claude-opus-5", "claude-sonnet-5", "claude-opus-4-6", "claude-haiku-4-5"],
  minimax: ["MiniMax-M3", "MiniMax-M2"],
  deepseek: ["deepseek-chat", "deepseek-reasoner"],
  kimi: ["kimi-k2-turbo-preview", "kimi-k2-0905-preview"],
  glm: ["glm-4.6", "glm-4.5-air"],
  custom: [],
};

/** A generic Anthropic-compatible endpoint, configured entirely by env. */
function compatible(): ProviderProfile {
  const truthy = (value: string | undefined) =>
    value === "1" || value?.toLowerCase() === "true";

  return {
    label: process.env.AGENTBOX_PROVIDER_LABEL ?? "custom",
    baseUrl: process.env.AGENTBOX_BASE_URL,
    model: process.env.AGENTBOX_MODEL ?? "unknown",
    maxTokens: envNumber("AGENTBOX_MAX_TOKENS", 32_000),
    // Zero as the fallback means "not stated", which is what an absent variable means here — and
    // now also what an unreadable one means, instead of NaN.
    ...(envNumber("AGENTBOX_CONTEXT_WINDOW", 0) > 0
      ? { contextWindow: envNumber("AGENTBOX_CONTEXT_WINDOW", 0) }
      : {}),
    // Default every optional capability off: a wrong "yes" fails silently,
    // a wrong "no" merely costs a feature and says so.
    vision: truthy(process.env.AGENTBOX_VISION),
    adaptiveThinking: truthy(process.env.AGENTBOX_THINKING),
    effort: truthy(process.env.AGENTBOX_EFFORT),
    promptCaching: truthy(process.env.AGENTBOX_CACHING),
    auth: process.env.AGENTBOX_AUTH === "x-api-key" ? "x-api-key" : "bearer",
    keyEnv: process.env.AGENTBOX_KEY_ENV ?? "AGENTBOX_API_KEY",
  };
}

const PRESETS: Record<string, () => ProviderProfile> = {
  anthropic: () => ({ ...ANTHROPIC }),
  minimax: () => ({ ...MINIMAX }),
  deepseek: () => ({ ...DEEPSEEK }),
  kimi: () => ({ ...KIMI }),
  glm: () => ({ ...GLM }),
  custom: compatible,
  compatible,
};

export function providerNames(): string[] {
  return ["anthropic", "minimax", "deepseek", "kimi", "glm", "custom"];
}

/**
 * Resolves the provider from a name, the environment, or a configured default.
 *
 * Precedence: the explicit name (a flag), then `AGENTBOX_PROVIDER`, then the config
 * file's default. The config sits under the environment for the same reason the
 * environment sits under the flag — the more deliberate, more recent choice wins.
 *
 * `AGENTBOX_MODEL` overrides the preset's model, so a different model on the same
 * endpoint does not need a new preset.
 */
export function resolveProvider(name?: string, configuredDefault?: string): ProviderProfile {
  const requested = (name ?? process.env.AGENTBOX_PROVIDER ?? configuredDefault ?? "").toLowerCase();

  // A bare base URL with no provider named is unambiguous enough to act on.
  const chosen =
    requested || (process.env.AGENTBOX_BASE_URL ? "custom" : "anthropic");

  const build = PRESETS[chosen];
  if (!build) {
    throw new Error(
      `Unknown provider "${chosen}". Known: ${providerNames().join(", ")}.`
    );
  }

  const profile = build();
  if (process.env.AGENTBOX_MODEL) profile.model = process.env.AGENTBOX_MODEL;
  if (process.env.AGENTBOX_BASE_URL) profile.baseUrl = process.env.AGENTBOX_BASE_URL;
  /**
   * Which variable holds the credential, overridable for any provider and not just `custom`.
   *
   * This is what makes the model relay work without a second provider table. Behind a relay the
   * endpoint and the credential change — to the relay's address and the box's own relay token — while
   * the *model* and everything derived from it stay whatever the tenant was issued. Before this,
   * pointing a box at a relay forced the `custom` preset, which silently switched vision, caching and
   * thinking off and produced an agent that could not see its own screen.
   */
  if (process.env.AGENTBOX_KEY_ENV) profile.keyEnv = process.env.AGENTBOX_KEY_ENV;
  // Keeps the profile's own value when the variable is absent or unreadable, rather than
  // overwriting a working setting with NaN.
  profile.maxTokens = envNumber("AGENTBOX_MAX_TOKENS", profile.maxTokens);

  // Capabilities follow the model, not the endpoint: switching model on the same
  // provider can gain or lose vision, and getting that wrong is the failure that
  // does not announce itself.
  if (chosen === "minimax") {
    profile.vision = MINIMAX_VISION_MODELS.has(profile.model);
  }

  // An explicit opt-in always wins, so a newly-capable model needs no code change.
  if (process.env.AGENTBOX_VISION === "1") profile.vision = true;
  if (process.env.AGENTBOX_VISION === "0") profile.vision = false;

  return profile;
}

export class MissingCredentialError extends Error {
  constructor(profile: ProviderProfile) {
    super(
      `No credential for ${profile.label}: set ${profile.keyEnv}.` +
        (profile.keyEnv === "ANTHROPIC_API_KEY"
          ? " Or run `ant auth login`."
          : "")
    );
    this.name = "MissingCredentialError";
  }
}

/**
 * Builds a client for the profile.
 *
 * The credential is passed in the header the endpoint expects, and the other one
 * is explicitly nulled: the SDK would otherwise pick `ANTHROPIC_API_KEY` up from
 * the environment and send both, which the API rejects.
 */
export function createClient(profile: ProviderProfile): Anthropic {
  const key = process.env[profile.keyEnv];

  // First-party Anthropic can also authenticate from an `ant auth login` profile,
  // so a missing env var is not necessarily an error there.
  if (!key && profile.keyEnv !== "ANTHROPIC_API_KEY") {
    throw new MissingCredentialError(profile);
  }

  if (profile.auth === "bearer") {
    return new Anthropic({
      baseURL: profile.baseUrl,
      authToken: key,
      apiKey: null,
    });
  }

  return new Anthropic({
    baseURL: profile.baseUrl,
    ...(key ? { apiKey: key } : {}),
  });
}

/**
 * One real round trip, so a key is known good before it is saved.
 *
 * A cheap actual request rather than a HEAD or a models listing, because compatible
 * endpoints differ in everything except the messages route itself — the only thing a
 * probe of anything else proves is that the vendor has a load balancer. The failure
 * message is passed through as the vendor wrote it: "invalid api key" from the horse's
 * mouth beats any paraphrase.
 */
export async function testProvider(
  profile: ProviderProfile,
  keyOverride?: string
): Promise<{ ok: true; latencyMs: number; model: string }> {
  const key = keyOverride ?? process.env[profile.keyEnv];
  if (!key && profile.keyEnv !== "ANTHROPIC_API_KEY") {
    throw new MissingCredentialError(profile);
  }

  const client =
    profile.auth === "bearer"
      ? new Anthropic({
          baseURL: profile.baseUrl,
          authToken: key,
          apiKey: null,
          maxRetries: 0,
          timeout: 20_000,
        })
      : new Anthropic({
          baseURL: profile.baseUrl,
          ...(key ? { apiKey: key } : {}),
          maxRetries: 0,
          timeout: 20_000,
        });

  const started = Date.now();
  const response = await client.messages.create({
    model: profile.model,
    max_tokens: 16,
    messages: [{ role: "user", content: "Reply with the single word: ok" }],
  });
  return { ok: true, latencyMs: Date.now() - started, model: response.model };
}

/** One line describing what is configured, and what it costs. */
/**
 * The model that writes summaries, which should not be the agent's own.
 *
 * Summarising is a cheap, mechanical, long-input job, and paying the agent's model to do it is
 * wrong twice: it costs the most per token of anything in the system, and it blocks the turn.
 * Measured on this box, one summarisation of a real 26,000-token history took 30 seconds on the
 * agent's own model — 30 seconds of a user watching nothing happen.
 *
 * So a separate profile, chosen in this order:
 *
 *   1. `AGENTBOX_SUMMARY_PROVIDER` / `AGENTBOX_SUMMARY_MODEL` — an explicit choice wins.
 *   2. The agent's own provider with a cheaper model, when one is named for it.
 *   3. The agent's own profile unchanged, which is what happens today.
 *
 * Falling back to the agent's own model rather than refusing matters: a deployment that has one
 * credential must still be able to compact. Better slow than stuck.
 *
 * Deliberately not a hardcoded third-party model. Reaching for a different vendor's cheap model
 * would mean a second credential nobody configured, and a summariser that fails closed on a system
 * that was working.
 */
const CHEAPER_MODEL_FOR: Record<string, string | undefined> = {
  // Same endpoint, same key, smaller model. Only listed where the smaller model is known to accept
  // the same request shape — a summarising call is plain text in, plain text out, so vision and
  // thinking do not matter here.
  anthropic: "claude-haiku-4-5",
};

export function resolveSummaryProvider(agentProfile: ProviderProfile): ProviderProfile {
  const named = process.env.AGENTBOX_SUMMARY_PROVIDER;
  if (named !== undefined && named.trim() !== "") {
    const profile = resolveProvider(named);
    if (process.env.AGENTBOX_SUMMARY_MODEL) profile.model = process.env.AGENTBOX_SUMMARY_MODEL;
    return profile;
  }

  const profile: ProviderProfile = { ...agentProfile };
  if (process.env.AGENTBOX_SUMMARY_MODEL) {
    profile.model = process.env.AGENTBOX_SUMMARY_MODEL;
    return profile;
  }

  const cheaper = CHEAPER_MODEL_FOR[agentProfile.label.toLowerCase()];
  if (cheaper !== undefined) {
    profile.model = cheaper;
    // The cheaper model is used for one plain-text call. Capabilities it may not share with the
    // agent's model are switched off rather than assumed, since a summarising request that carries
    // a field the model rejects fails the compaction it was meant to perform.
    profile.adaptiveThinking = false;
    profile.effort = false;
    profile.vision = false;
  }
  return profile;
}

export function describeProvider(profile: ProviderProfile): string {
  const missing: string[] = [];
  if (!profile.vision) missing.push("no vision (computer tool withheld)");
  if (!profile.promptCaching) missing.push("no prompt caching");
  const suffix = missing.length > 0 ? ` — ${missing.join(", ")}` : "";
  return `${profile.label} ${profile.model}${profile.baseUrl ? ` at ${profile.baseUrl}` : ""}${suffix}`;
}
