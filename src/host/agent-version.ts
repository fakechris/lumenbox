/**
 * Which version of the agent a turn ran under (INV-1474): a hash per standing file, per skill
 * the prompt offered, and per built-in prompt part — written on the turn ledger's begin record,
 * never the text itself.
 *
 * A transcript already says what the agent did; to say whether a change to its prompt helped,
 * the trace has to say what the prompt was. `promptFingerprint` hashes the assembled prompt, which
 * answers "did it change"; this answers "which of the things a person edits changed" — SOUL.md,
 * a skill's description, an overridden rule — so an eval case can be replayed against the version
 * it was recorded under, and a regression can be read back to the edit that caused it.
 */

import { createHash } from "node:crypto";
import { partViews } from "./prompt-parts.ts";
import type { StandingName, StandingSnapshot } from "./standing.ts";

export interface AgentVersion {
  /** AGENTS, SOUL, USER, HEARTBEAT — by name without the extension, each a hash of its content. */
  standing: Partial<Record<"AGENTS" | "SOUL" | "USER" | "HEARTBEAT", string>>;
  /** The skills the prompt listed, by slug — a hash of the description the index carried. */
  skills: Record<string, string>;
  /** The built-in prompt parts, by key — the override's base when one is on file, else the default's hash. */
  parts: Record<string, string>;
}

export const versionHash = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 16);

export function agentVersionOf(
  standing: StandingSnapshot | undefined,
  skills: readonly { slug: string; description: string }[],
  parts: readonly { key: string; defaultHash: string; override?: { base: string } }[] = partViews()
): AgentVersion {
  const standingHashes: AgentVersion["standing"] = {};
  for (const [name, text] of Object.entries(standing ?? {})) standingHashes[(name as StandingName).replace(/\.md$/, "") as keyof AgentVersion["standing"]] = versionHash(text);
  return {
    standing: standingHashes,
    skills: Object.fromEntries(skills.map(skill => [skill.slug, versionHash(skill.description)])),
    parts: Object.fromEntries(parts.map(part => [part.key, part.override?.base ?? part.defaultHash])),
  };
}

/** The names of what differs between two versions, for a replay's note: "SOUL, skill research-brief, part conduct". */
export function versionDiff(before: AgentVersion, after: AgentVersion): string[] {
  const changed: string[] = [];
  const keys = (a: Record<string, string | undefined>, b: Record<string, string | undefined>) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(key => a[key] !== b[key]);
  changed.push(...keys(before.standing, after.standing));
  changed.push(...keys(before.skills, after.skills).map(slug => `skill ${slug}`));
  changed.push(...keys(before.parts, after.parts).map(key => `part ${key}`));
  return changed;
}
