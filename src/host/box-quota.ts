import type { BoxEntry } from "../box/boxes.ts";
import type { AgentboxConfig } from "../config.ts";

export function personalQuotaFor(principalId: string, config: AgentboxConfig): number | undefined {
  // Existing installations did not have a limit. Enforce only an explicit policy.
  return Object.hasOwn(config.personBoxQuotas ?? {}, principalId)
    ? config.personBoxQuotas![principalId]
    : config.personalBoxQuota;
}

export function personalBoxesOf(entries: readonly BoxEntry[], principalId: string): BoxEntry[] {
  return entries.filter(entry => Array.isArray(entry.members) && entry.members.length === 1 && entry.members[0] === principalId);
}

/** Applied before membership changes, without taking away an existing allocation. */
export function personalAllocationRefusal(entries: readonly BoxEntry[], box: BoxEntry, members: "everyone" | string[], config: AgentboxConfig): string | undefined {
  if (members === "everyone") return;
  const unique = [...new Set(members)];
  if (unique.length !== 1) return;
  const owner = unique[0]!;
  const held = personalBoxesOf(entries, owner);
  if (held.some(entry => entry.id === box.id)) return;
  const quota = personalQuotaFor(owner, config);
  if (quota !== undefined && held.length >= quota) return `Personal-box quota ${quota} reached (${held.length} held). An admin must change the quota before allocating another box.`;
}
