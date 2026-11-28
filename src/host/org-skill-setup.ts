/**
 * What an organisation's required skills ask of a box before they work (INV-2222, docs/109 §5,
 * docs/93 §2a): a tool to install, and a sign-in only the member can do.
 *
 * A skill says both in its frontmatter (`SkillSetup`): a line that does it and a line that exits 0
 * once it is done. This module is the host's half.
 *
 * - **Where the lines run.** In the skill's own directory in the box, with `LUMENBOX_WORK` set to
 *   the box's work directory — `/home/box/work` on the image, the box's own on a host box — so one
 *   skill names a kept place on every kind of box.
 * - **What is kept.** A box's work volume and its `.config` volume survive an image update
 *   (`src/box/docker.ts`, `src/control/kube-box.ts`, docs/12 §1); nothing else does, and a host
 *   box has only its work directory. `setupWarnings` reads an install for the ways it would land
 *   elsewhere — a system package manager, `sudo`, a global install, an absolute path outside the
 *   two — and says so to the Admin at publish. A warning, never a refusal: a line of shell cannot
 *   be read for certain.
 * - **Knowing what is owed.** After a box is synced, each required skill's check lines are run
 *   there (`check`). Only for a skill the box has not been told of: once told, nothing is run.
 * - **Telling the agent, once.** What is owed rides in the skills index of that box's agents
 *   (`due`, through `OrgSkillRoot.due`) until a turn a person opened has carried it; then it is
 *   written down (`org-skill-setup.jsonl`, one line per box and skill) and never said again. The
 *   skill is still in the index, and its SKILL.md still says how to sign in. An install is run by
 *   the agent; a sign-in is offered, and the password is the person's (docs/15).
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { appendLineDurably, type LedgerKind } from "./jsonl.ts";
import type { SkillFiles } from "./org-skills.ts";
import { parseSkillFile, SKILL_FILENAME, type Skill, type SkillSetup, skillSetupFrom } from "./skills.ts";

export const LEDGER_KIND: LedgerKind = "record";
export const ORG_SKILL_SETUP_LEDGER = "org-skill-setup.jsonl";

/** The variable a set-up line reads the box's work directory from. */
export const WORK_VARIABLE = "LUMENBOX_WORK";

const OUTSIDE: readonly { pattern: RegExp; why: string }[] = [
  { pattern: /(^|[\s;&|(])sudo\s/m, why: "uses sudo" },
  { pattern: /\b(apt-get|apt|dpkg|yum|dnf|apk|snap)\s+(-\S+\s+)*(install|add|-i)\b/, why: "installs with the system's package manager" },
  { pattern: /\b(npm|pnpm|yarn)\b[^\n]*\s(-g|--global|global)\b(?![^\n]*--prefix)/, why: "installs globally" },
  { pattern: /\bpip3?\s+install\b(?![^\n]*(--target|--prefix|-t\s))/, why: "installs with pip and names no --target" },
  { pattern: /(^|[\s"'=:])(\/usr|\/opt|\/etc|\/var|\/root|\/bin|\/sbin)\//m, why: "writes under a system directory" },
  { pattern: /(~|\$HOME|\$\{HOME\}|\/home\/box)\/(?!work(\/|\b)|\.config(\/|\b))[A-Za-z0-9._-]/, why: "names a place in the home directory that is neither the work volume nor .config" },
];

/**
 * What an Admin is told before a skill that declares an install is published: each way its
 * install, or the place its checks look, appears to be outside what a box keeps. The install line
 * is read, and the skill's own file when the line runs one.
 */
export function setupWarnings(files: SkillFiles): string[] {
  const setup = skillSetupFrom("", parseSkillFile(files[SKILL_FILENAME] ?? "").meta);
  if ("problem" in setup || setup.setup === undefined) return [];
  const { install, signIn } = setup.setup;
  const read: [string, string][] = [];
  if (install !== undefined) {
    read.push(["install:", install.run], ["installed:", install.check]);
    const script = Object.keys(files).find(path => path !== SKILL_FILENAME && install.run.includes(path));
    if (script !== undefined) read.push([script, files[script]!]);
  }
  if (signIn !== undefined) read.push(["signed_in:", signIn.check]);
  const warnings: string[] = [];
  for (const [where, text] of read) {
    for (const { pattern, why } of OUTSIDE) {
      if (pattern.test(text)) warnings.push(`${where} ${why}. Only the work volume ($${WORK_VARIABLE}) and ~/.config survive an image update; what is put anywhere else is gone at the next one.`);
    }
  }
  return [...new Set(warnings)];
}

/** Just enough of a box to run a check line. */
export interface SetupBox {
  exec(command: string, options?: { cwd?: string; timeoutMs?: number; actor?: string }): Promise<{ exit_code: number }>;
}

export interface OrgSkillSetupDeps {
  client: (boxId: string) => SetupBox | undefined;
  /** The box's work directory, and where the organisation's skills are in it. */
  place: (boxId: string) => { work: string; root: string };
  /** Whether the last thing said to this agent in this conversation was said by a person: only then has anybody been told. */
  personOpened: (agentId: string, conversation: string | undefined) => boolean;
  boxOf: (agentId: string) => string | undefined;
  log: (line: string) => void;
  now?: () => Date;
}

interface Owed { install: boolean; signIn: boolean }

/** A set-up line as it is run: in the skill's directory, with the work directory named. */
export function setupLine(line: string, place: { work: string; root: string }, slug: string): string {
  // Exported first, not prefixed: a prefix is not yet set when the shell expands the line's own "$LUMENBOX_WORK".
  return `cd '${place.root}/${slug}' && export ${WORK_VARIABLE}='${place.work}' && ${line}`;
}

export class OrgSkillSetup {
  /** box → slug → what its checks said was not done. Absent: not checked, so nothing is claimed. */
  private readonly owed = new Map<string, Map<string, Owed>>();
  /** `box/slug` of what has been said in a turn a person opened. */
  private readonly told = new Set<string>();
  /** box → slugs the index carried since the last turn ended there. */
  private readonly carried = new Map<string, Set<string>>();

  constructor(private readonly path: string | undefined, private readonly deps: OrgSkillSetupDeps) {
    if (path === undefined || !existsSync(path)) return;
    for (const raw of readFileSync(path, "utf8").split("\n")) {
      try {
        const line = JSON.parse(raw) as { box?: unknown; slug?: unknown };
        if (typeof line.box === "string" && typeof line.slug === "string") this.told.add(`${line.box}/${line.slug}`);
      } catch { /* an empty or torn line */ }
    }
  }

  /** Runs the check lines of each required skill this box has not been told of. Never throws: a box that does not answer owes nothing we can name. */
  async check(boxId: string, skills: readonly { slug: string; setup?: SkillSetup }[]): Promise<void> {
    const client = this.deps.client(boxId);
    const owed = new Map<string, Owed>();
    if (client !== undefined) {
      const place = this.deps.place(boxId);
      const done = (line: string, slug: string) => client.exec(setupLine(line, place, slug), { timeoutMs: 20_000, actor: "host:org-skills" }).then(result => result.exit_code === 0, () => undefined);
      for (const { slug, setup } of skills) {
        if (setup === undefined || this.told.has(`${boxId}/${slug}`)) continue;
        const installed = setup.install === undefined ? true : await done(setup.install.check, slug);
        const signedIn = setup.signIn === undefined ? true : await done(setup.signIn.check, slug);
        if (installed === undefined || signedIn === undefined) continue;
        if (!installed || !signedIn) owed.set(slug, { install: !installed, signIn: !signedIn });
      }
    }
    this.owed.set(boxId, owed);
  }

  /** What the index says of this skill in this box, while something is owed and nobody has been told. */
  due(boxId: string, skill: Pick<Skill, "slug" | "setup">): string | undefined {
    const owed = this.owed.get(boxId)?.get(skill.slug);
    if (owed === undefined || skill.setup === undefined || this.told.has(`${boxId}/${skill.slug}`)) return undefined;
    const place = this.deps.place(boxId);
    const parts: string[] = [];
    if (owed.install && skill.setup.install !== undefined) {
      parts.push(`install it with \`${setupLine(skill.setup.install.run, place, skill.slug)}\` (done when \`${skill.setup.install.check}\` exits 0 there)`);
    }
    if (owed.signIn && skill.setup.signIn !== undefined) {
      parts.push(`then offer the ${skill.setup.signIn.name} sign-in: \`${setupLine(skill.setup.signIn.start, place, skill.slug)}\` starts it (done when \`${skill.setup.signIn.check}\` exits 0 there)`);
    }
    if (parts.length === 0) return undefined;
    this.carried.set(boxId, (this.carried.get(boxId) ?? new Set()).add(skill.slug));
    return `${parts.join("; ")}.`;
  }

  /**
   * A turn ended. When a person opened it and the index of its box carried something owed, that
   * has now been said: written down, and not said again.
   */
  noteTurn(event: { type: string; agentId?: string; conversation?: string }): void {
    if (event.type !== "turn_finished" || event.agentId === undefined) return;
    const boxId = this.deps.boxOf(event.agentId);
    const carried = boxId === undefined ? undefined : this.carried.get(boxId);
    if (boxId === undefined || carried === undefined || carried.size === 0 || !this.deps.personOpened(event.agentId, event.conversation)) return;
    this.carried.delete(boxId);
    for (const slug of carried) {
      if (this.told.has(`${boxId}/${slug}`)) continue;
      this.told.add(`${boxId}/${slug}`);
      this.owed.get(boxId)?.delete(slug);
      if (this.path !== undefined) {
        mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
        appendLineDurably(this.path, JSON.stringify({ at: (this.deps.now?.() ?? new Date()).toISOString(), box: boxId, slug, agent: event.agentId }));
      }
      this.deps.log(`organisation skills: ${event.agentId} was told what ${slug} asks of ${boxId}`);
    }
  }
}
