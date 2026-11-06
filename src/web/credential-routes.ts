/**
 * The web's half of the check before work starts (INV-1666): the events behind the "before this can
 * start" card, and the "needed by" column of Settings → Team → Secrets. The check itself is
 * host/credential-coverage.ts; this file only shapes what it found for the page.
 */

import type { Coverage, CoverageItem, CoverageSkill } from "../host/credential-coverage.ts";
import { neededBy } from "../host/credential-coverage.ts";
import type { CredentialChecks, WaitEvent } from "../host/credential-waits.ts";
import { parseSkillFile, SKILL_FILENAME, skillNeedsFrom } from "../host/skills.ts";
import type { TemplateSkill } from "../host/template.ts";

/** What the page hears: a start that waits (a card in that agent's thread), and its release (the card settles). */
export type CredentialEvent =
  | { type: "credentials_needed"; key: string; agentId: string; agentName: string; title: string; items: CoverageItem[] }
  | { type: "credentials_covered"; key: string; agentId: string };

/** A waiting task's event, keyed by the task so the release settles the same card. */
export function taskCredentialEvent(event: WaitEvent): CredentialEvent {
  const key = `task:${event.taskId}`;
  return event.kind === "needed"
    ? { type: "credentials_needed", key, agentId: event.agentId, agentName: event.agentName, title: `${event.taskId} ${event.title}`, items: missingFirst(event.coverage) }
    : { type: "credentials_covered", key, agentId: event.agentId };
}

/** After a template import: the new agent's setup can run, but what its work needs and lacks is said now, before anyone asks it for anything. */
export function templateCredentialEvent(agent: { id: string; name: string }, template: string, coverage: Coverage): CredentialEvent | undefined {
  if (coverage.ok) return undefined;
  return { type: "credentials_needed", key: `template:${agent.id}`, agentId: agent.id, agentName: agent.name, title: `the work it was imported for (${template})`, items: missingFirst(coverage) };
}

/** A template's skills and routines as the check reads them: what each one's SKILL.md frontmatter says it needs. */
export function templateSkillNeeds(skills: readonly TemplateSkill[]): CoverageSkill[] {
  return skills.map(skill => {
    const needs = skillNeedsFrom(parseSkillFile(skill.files[SKILL_FILENAME] ?? "").meta);
    return { slug: skill.slug, name: skill.name, ...(needs !== undefined ? { needs } : {}) };
  });
}

function missingFirst(coverage: Coverage): CoverageItem[] {
  const rank = { missing: 0, expiring: 1, present: 2 } as const;
  return [...coverage.items].sort((a, b) => rank[a.state] - rank[b.state]);
}

/**
 * Which agents and skills need each vault secret, for the Secrets list — every agent here with what
 * it carries, and every skill in every box that states a need.
 */
export function secretsNeededBy(checks: CredentialChecks, agentIds: readonly string[], skills: readonly CoverageSkill[]): Record<string, string[]> {
  return neededBy(checks.everyone(agentIds), skills.filter(skill => skill.needs !== undefined));
}
