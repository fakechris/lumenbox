/** Failed requests can be billable without reporting usage. Keep their budget hold distinct. */
import type { ProviderProfile } from "./provider.ts";
import { knownContextWindow } from "./compaction.ts";
import type { SpendLimits } from "./spend-limits.ts";
import type { UsageLog, UsageRecord } from "./usage.ts";

export function reserveFailedModelSpend(profile: ProviderProfile, scope: Pick<UsageRecord, "agentId" | "agentName" | "workId" | "turnId" | "conversation" | "round">, limits?: SpendLimits, usage?: Pick<UsageLog, "record">) {
  // The model's entire window plus maximum output is a ceiling, not a token estimate.
  // Cache classes are priced at the highest configured input rate by SpendLimits.
  const bound = { inputTokens: profile.contextWindow ?? knownContextWindow(profile.model) ?? 200_000, outputTokens: profile.maxTokens, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const row = { ...scope, kind: "turn" as const, provider: profile.label, model: profile.model };
  const verdict = limits?.reserveUnreported({ ...row, ...bound, metering: "missing" });
  // Reports retain unknown usage. Budget reservations must never masquerade as a bill.
  usage?.record({ ...row, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, metering: "missing", reason: "Request failed without final usage; a conservative allowance is held separately by spend limits." });
  return { bound, verdict };
}
