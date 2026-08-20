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

/** A generic Anthropic-compatible endpoint, configured entirely by env. */
function compatible(): ProviderProfile {
  const truthy = (value: string | undefined) =>
    value === "1" || value?.toLowerCase() === "true";

  return {
    label: process.env.AGENTBOX_PROVIDER_LABEL ?? "custom",
    baseUrl: process.env.AGENTBOX_BASE_URL,
    model: process.env.AGENTBOX_MODEL ?? "unknown",
    maxTokens: Number(process.env.AGENTBOX_MAX_TOKENS ?? 32_000),
    ...(process.env.AGENTBOX_CONTEXT_WINDOW
      ? { contextWindow: Number(process.env.AGENTBOX_CONTEXT_WINDOW) }
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
  custom: compatible,
  compatible,
};

export function providerNames(): string[] {
  return ["anthropic", "minimax", "custom"];
}

/**
 * Resolves the provider from a name or the environment.
 *
 * `AGENTBOX_MODEL` overrides the preset's model, so a different model on the same
 * endpoint does not need a new preset.
 */
export function resolveProvider(name?: string): ProviderProfile {
  const requested = (name ?? process.env.AGENTBOX_PROVIDER ?? "").toLowerCase();

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
  if (process.env.AGENTBOX_MAX_TOKENS) {
    profile.maxTokens = Number(process.env.AGENTBOX_MAX_TOKENS);
  }

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

/** One line describing what is configured, and what it costs. */
export function describeProvider(profile: ProviderProfile): string {
  const missing: string[] = [];
  if (!profile.vision) missing.push("no vision (computer tool withheld)");
  if (!profile.promptCaching) missing.push("no prompt caching");
  const suffix = missing.length > 0 ? ` — ${missing.join(", ")}` : "";
  return `${profile.label} ${profile.model}${profile.baseUrl ? ` at ${profile.baseUrl}` : ""}${suffix}`;
}
