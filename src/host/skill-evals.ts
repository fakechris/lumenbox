/**
 * Behavioural cases a skill carries with it: does it get picked up when it should, and left alone
 * when it should not (INV-693).
 *
 * `scenario.ts` tests the orchestra — forks, questions, recovery — with a scripted model. It cannot
 * test a skill's *description*, because whether a description is chosen is the model's judgement,
 * and a scripted model has none. A description written too wide is read into requests it has
 * nothing to do with; one written too narrow is never used. Neither shows up anywhere until a
 * person notices, so each skill states both halves here and a live run checks them.
 *
 * "Picked up" is observable and mechanical: the agent opened the skill's own SKILL.md with
 * `read_file`. The prompt carries only an index of skills, never their bodies, so a skill that was
 * used was read. That is the whole judgement — no grading of the answer.
 *
 * A case that cannot be run honestly says why in `na`, and is reported as N/A, never as a pass.
 */

export type SkillEvalKind = "trigger" | "no-trigger";

export interface SkillEval {
  /** Short and unique within the skill: what the case is about. */
  name: string;
  /** `trigger` — the skill must be opened. `no-trigger` — it must not be. */
  kind: SkillEvalKind;
  /** What the person says first. Written as a person would say it, in their language. */
  says: string;
  /** Files the box starts with, by absolute path under /home/box, when the request refers to them. */
  files?: Record<string, string>;
  /** For a no-trigger case: the neighbouring skill the request actually belongs to, when there is one. Reported, not required. */
  instead?: string;
  /** Why this case cannot be run, when it cannot. Reported as N/A and never counted as passing. */
  na?: string;
}

export type SkillEvalVerdict = "pass" | "fail" | "na";

/** Every problem with one skill's cases; empty when they are sound. `known` is every skill slug that exists. */
export function validateSkillEvals(slug: string, cases: readonly SkillEval[], known: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  const names = new Set<string>();
  for (const one of cases) {
    const where = `${slug}/${one.name || "(unnamed)"}`;
    if (one.name.trim() === "") problems.push(`${where}: a case needs a name`);
    if (names.has(one.name)) problems.push(`${where}: two cases share this name`);
    names.add(one.name);
    if (one.kind !== "trigger" && one.kind !== "no-trigger") problems.push(`${where}: kind must be trigger or no-trigger`);
    if (one.says.trim() === "") problems.push(`${where}: says is empty; a case starts with what the person says`);
    if (one.instead !== undefined && one.kind !== "no-trigger") problems.push(`${where}: instead only means something on a no-trigger case`);
    if (one.instead !== undefined && !known.has(one.instead)) problems.push(`${where}: instead names ${one.instead}, which is not a skill`);
    if (one.instead === slug) problems.push(`${where}: instead cannot be the skill itself`);
    for (const path of Object.keys(one.files ?? {})) {
      if (!path.startsWith("/home/box/")) problems.push(`${where}: preset file ${path} is outside /home/box`);
    }
    if (one.na !== undefined && one.na.trim() === "") problems.push(`${where}: na needs the reason`);
  }
  if (!cases.some(one => one.kind === "trigger")) problems.push(`${slug}: no trigger case — nothing checks that it is ever used`);
  if (!cases.some(one => one.kind === "no-trigger")) problems.push(`${slug}: no no-trigger case — nothing checks that it stays out of requests it does not own`);
  return problems;
}

/** The files a run opened with `read_file`, read off the transcript's tool calls. */
export function filesRead(entries: readonly unknown[]): string[] {
  const read: string[] = [];
  for (const entry of entries) {
    const blocks = (entry as { kind?: string; blocks?: unknown[] }).kind === "blocks" ? (entry as { blocks: unknown[] }).blocks : [];
    for (const block of blocks) {
      const use = block as { type?: string; name?: string; input?: { path?: unknown } };
      if (use.type === "tool_use" && use.name === "read_file" && typeof use.input?.path === "string") read.push(use.input.path);
    }
  }
  return read;
}

/** Whether a run did what the case asked of the skill at `skillPath`. */
export function judgeSkillEval(one: SkillEval, skillPath: string, read: readonly string[]): SkillEvalVerdict {
  if (one.na !== undefined) return "na";
  const opened = read.includes(skillPath);
  return (one.kind === "trigger") === opened ? "pass" : "fail";
}
