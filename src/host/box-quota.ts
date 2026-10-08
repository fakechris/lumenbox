import type { BoxEntry } from "../box/boxes.ts";
import type { AgentboxConfig } from "../config.ts";

export interface DirectoryQuotaContext { eligible: boolean; departmentKeys: readonly string[] }

export function personalQuotaFor(principalId: string, config: AgentboxConfig, directory?: DirectoryQuotaContext): number | undefined {
  if (directory?.eligible === false) return 0;
  if (Object.hasOwn(config.personBoxQuotas ?? {}, principalId)) return config.personBoxQuotas![principalId];
  const quotas = (directory?.departmentKeys ?? []).filter(key => Object.hasOwn(config.departmentBoxQuotas ?? {}, key))
    .map(key => config.departmentBoxQuotas![key]!);
  return quotas.length ? Math.min(...quotas) : config.personalBoxQuota;
}

export function personalBoxesOf(entries: readonly BoxEntry[], principalId: string): BoxEntry[] {
  return entries.filter(entry => Array.isArray(entry.members) && entry.members.length === 1 && entry.members[0] === principalId);
}

/** Applied before membership changes, without taking away an existing allocation. */
export function personalAllocationRefusal(entries: readonly BoxEntry[], box: BoxEntry, members: "everyone" | string[], config: AgentboxConfig, directory?: DirectoryQuotaContext): string | undefined {
  if (members === "everyone") return;
  const unique = [...new Set(members)];
  if (unique.length !== 1) return;
  const owner = unique[0]!;
  const held = personalBoxesOf(entries, owner);
  if (held.some(entry => entry.id === box.id)) return;
  const quota = personalQuotaFor(owner, config, directory);
  if (quota !== undefined && held.length >= quota) return `Personal-box quota ${quota} reached (${held.length} held). An admin must change the quota before allocating another box.`;
}
