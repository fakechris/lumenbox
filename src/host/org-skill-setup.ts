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
 * - **Nothing runs before the box's person agrees** (decided 2026-11-28). A personal box holds its
 *   member's own sign-ins, and an Admin cannot enter it; a required skill whose lines ran there by
 *   themselves would be an Admin's code running over everybody's credentials. So, per box and per
 *   skill, the host keeps a consent for one *digest of the lines* (`linesDigest`): a new version
 *   whose lines changed needs a new yes, one that changed only its text does not. Who may give it:
 *   for a personal box its owner; for any other box an Admin who may enter it (`mayConsent`). How:
 *   the person's own message "agree <slug>" or "decline <slug>" (同意 / 拒绝) — authenticated, not
 *   synthetic, not a routine's, so neither an agent nor a cue can say it for them — or the buttons
 *   on their Settings → Mine. Each yes and each no is a ledger line (who, box, skill, version,
 *   digest), and `audit export` carries the box's.
 * - **Asking, once per version.** Before a yes, the box's skills index says what the skill would run
 *   (install, check, sign-in lines), who published it and which version, and how to answer; and that
 *   nothing of it runs until then. Once a turn a person opened has carried that, it is not asked
 *   again for those lines: the person can come back to it in their settings. A no is remembered.
 * - **Knowing what is owed, after a yes.** After a box is synced, and right after a yes, each
 *   agreed skill's check lines are run there (`check`). Never before a yes, never for other lines.
 * - **Telling the agent, once.** What is owed rides in the skills index of that box's agents
 *   (`due`) until a turn a person opened has carried it; then it is written down and not said again.
 *   The skill is still listed, and its SKILL.md still says how to sign in. An install is run by the
 *   agent; a sign-in is offered, and the password is the person's (docs/15).
 */

import { createHash } from "node:crypto";
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

/** One digest for what a skill's set-up would run: what a consent is a consent to. */
export function linesDigest(setup: SkillSetup): string {
  const lines = [setup.install?.run ?? "", setup.install?.check ?? "", setup.signIn?.name ?? "", setup.signIn?.start ?? "", setup.signIn?.check ?? ""];
  return createHash("sha256").update(JSON.stringify(lines)).digest("hex").slice(0, 16);
}

/** A required skill as the box would run it: its lines, and who published which version. */
export interface DeclaredSetup {
  slug: string;
  setup?: SkillSetup;
  version?: number;
  /** Who published that version, by name. */
  publishedBy?: string;
}

/** A person's message as the host admitted it: enough to tell whether it is their own answer. */
export interface AnswerMessage {
  fromId: string;
  text: string;
  principalId?: string;
  synthetic?: boolean;
  origin?: string;
  toolScope?: readonly unknown[];
}

export interface OrgSkillSetupDeps {
  client: (boxId: string) => SetupBox | undefined;
  /** The box's work directory, and where the organisation's skills are in it. */
  place: (boxId: string) => { work: string; root: string };
  /** Whether the last thing said to this agent in this conversation was said by a person: only then has anybody been told. */
  personOpened: (agentId: string, conversation: string | undefined) => boolean;
  boxOf: (agentId: string) => string | undefined;
  /** Whether this person may agree for this box: its owner for a personal box, else an Admin who may enter it. */
  mayConsent: (boxId: string, principalId: string) => boolean;
  /** After a yes: the box's skills are read again, so the turn that said yes is told what is now owed. */
  consented?: (boxId: string) => Promise<void>;
  log: (line: string) => void;
  now?: () => Date;
}

interface Owed { install: boolean; signIn: boolean }

/** One line of the ledger. `told` (also a line with no `kind`, as written before consents existed), `asked`, `consent`. */
interface SetupLine {
  kind?: "told" | "asked" | "consent";
  at: string;
  box: string;
  slug: string;
  digest?: string;
  version?: number;
  agreed?: boolean;
  by?: string;
  via?: "chat" | "page";
  agent?: string;
}

export type ConsentState = "agreed" | "declined" | "waiting";

/** A set-up line as it is run: in the skill's directory, with the work directory named. */
export function setupLine(line: string, place: { work: string; root: string }, slug: string): string {
  // Exported first, not prefixed: a prefix is not yet set when the shell expands the line's own "$LUMENBOX_WORK".
  return `cd '${place.root}/${slug}' && export ${WORK_VARIABLE}='${place.work}' && ${line}`;
}

const ANSWER = /^\s*(agree|yes|同意|decline|no|拒绝|不同意)\s+([a-z0-9][a-z0-9._-]*)\s*[.!。！]?\s*$/i;

export class OrgSkillSetup {
  /** box → slug → what its checks said was not done. Absent: not checked, so nothing is claimed. */
  private readonly owed = new Map<string, Map<string, Owed>>();
  /** `box/slug/digest` of what has been said, and of what has been asked, in a turn a person opened. */
  private readonly told = new Set<string>();
  private readonly asked = new Set<string>();
  /** `box/slug` → the last yes or no, with the digest it was for. */
  private readonly answers = new Map<string, SetupLine>();
  /** box → what the index carried since the last turn ended there: `asked` or `told`, by slug and digest. */
  private readonly carried = new Map<string, Map<string, { kind: "asked" | "told"; digest: string }>>();
  /** box → the required skills last checked there, so an answer knows the lines it agrees to. */
  private readonly declared = new Map<string, readonly DeclaredSetup[]>();
  private readonly lines: SetupLine[] = [];

  constructor(private readonly path: string | undefined, private readonly deps: OrgSkillSetupDeps) {
    if (path === undefined || !existsSync(path)) return;
    for (const raw of readFileSync(path, "utf8").split("\n")) {
      try {
        const line = JSON.parse(raw) as SetupLine;
        if (typeof line.box === "string" && typeof line.slug === "string") this.remember(line);
      } catch { /* an empty or torn line */ }
    }
  }

  private remember(line: SetupLine): void {
    this.lines.push(line);
    const key = `${line.box}/${line.slug}/${line.digest ?? ""}`;
    if (line.kind === "consent") this.answers.set(`${line.box}/${line.slug}`, line);
    else if (line.kind === "asked") this.asked.add(key);
    else this.told.add(key);
  }

  private write(line: SetupLine): void {
    this.remember(line);
    if (this.path !== undefined) {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      appendLineDurably(this.path, JSON.stringify(line));
    }
  }

  private stamp(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }

  /** Where this box's person stands on these lines. */
  consent(boxId: string, slug: string, digest: string): ConsentState {
    const answer = this.answers.get(`${boxId}/${slug}`);
    if (answer === undefined || answer.digest !== digest) return "waiting";
    return answer.agreed === true ? "agreed" : "declined";
  }

  /** What each required skill would run in this box, and where this box's person stands on it. */
  forBox(boxId: string): { slug: string; version?: number; publishedBy?: string; digest: string; lines: string[]; state: ConsentState }[] {
    return (this.declared.get(boxId) ?? []).flatMap(skill => {
      if (skill.setup === undefined) return [];
      const digest = linesDigest(skill.setup);
      const lines = [
        ...(skill.setup.install !== undefined ? [`install: ${skill.setup.install.run}`, `installed: ${skill.setup.install.check}`] : []),
        ...(skill.setup.signIn !== undefined ? [`sign_in: ${skill.setup.signIn.name}`, `sign_in_start: ${skill.setup.signIn.start}`, `signed_in: ${skill.setup.signIn.check}`] : []),
      ];
      const { slug, version, publishedBy } = skill;
      return [{ slug, ...(version !== undefined ? { version } : {}), ...(publishedBy !== undefined ? { publishedBy } : {}), digest, lines, state: this.consent(boxId, slug, digest) }];
    });
  }

  /** Every yes and no, oldest first: the audit, and the Admin's list of who declined. */
  consents(): readonly SetupLine[] {
    return this.lines.filter(line => line.kind === "consent");
  }

  /**
   * Records a yes or a no from `principalId` for this box, for the lines it would run now. Refused
   * (false) when that person may not agree for the box or the box has no such required skill.
   */
  async answer(boxId: string, slug: string, agreed: boolean, principalId: string, via: "chat" | "page"): Promise<boolean> {
    const skill = this.declared.get(boxId)?.find(entry => entry.slug === slug);
    if (skill?.setup === undefined || !this.deps.mayConsent(boxId, principalId)) return false;
    const digest = linesDigest(skill.setup);
    this.write({ kind: "consent", at: this.stamp(), box: boxId, slug, digest, ...(skill.version !== undefined ? { version: skill.version } : {}), agreed, by: principalId, via });
    this.deps.log(`organisation skills: ${principalId} ${agreed ? "agreed to" : "declined"} ${slug} (lines ${digest}) in ${boxId}, by ${via}`);
    if (agreed) {
      await this.check(boxId, this.declared.get(boxId) ?? []);
      await this.deps.consented?.(boxId);
    }
    return true;
  }

  /**
   * A turn is starting: when it was opened by a person's own message saying "agree <slug>" or
   * "decline <slug>", that is their answer for this box. Never a synthetic message, a routine's,
   * or an agent's; never anybody but the box's owner (or, for a shared box, an Admin in it).
   */
  async noteInbound(agentId: string, inbound: readonly AnswerMessage[]): Promise<void> {
    const boxId = this.deps.boxOf(agentId);
    if (boxId === undefined) return;
    for (const message of inbound) {
      if (message.fromId !== "user" || message.synthetic === true || message.origin !== undefined || message.toolScope !== undefined || message.principalId === undefined) continue;
      const said = ANSWER.exec(message.text);
      if (said === null) continue;
      const agreed = /^(agree|yes|同意)$/i.test(said[1]!);
      await this.answer(boxId, said[2]!.toLowerCase(), agreed, message.principalId, "chat");
    }
  }

  /** Runs the check lines of each required skill the box's person agreed to and has not been told of. Never anything else. Never throws. */
  async check(boxId: string, skills: readonly DeclaredSetup[]): Promise<void> {
    this.declared.set(boxId, skills);
    const client = this.deps.client(boxId);
    const owed = new Map<string, Owed>();
    if (client !== undefined) {
      const place = this.deps.place(boxId);
      const done = (line: string, slug: string) => client.exec(setupLine(line, place, slug), { timeoutMs: 20_000, actor: "host:org-skills" }).then(result => result.exit_code === 0, () => undefined);
      for (const { slug, setup } of skills) {
        if (setup === undefined) continue;
        const digest = linesDigest(setup);
        if (this.consent(boxId, slug, digest) !== "agreed" || this.told.has(`${boxId}/${slug}/${digest}`)) continue;
        const installed = setup.install === undefined ? true : await done(setup.install.check, slug);
        const signedIn = setup.signIn === undefined ? true : await done(setup.signIn.check, slug);
        if (installed === undefined || signedIn === undefined) continue;
        if (!installed || !signedIn) owed.set(slug, { install: !installed, signIn: !signedIn });
      }
    }
    this.owed.set(boxId, owed);
  }

  /** What the index says of this skill in this box: the question while nobody has answered, what is owed after a yes, else nothing. */
  due(boxId: string, skill: Pick<Skill, "slug" | "setup">): string | undefined {
    if (skill.setup === undefined) return undefined;
    const digest = linesDigest(skill.setup);
    const state = this.consent(boxId, skill.slug, digest);
    const place = this.deps.place(boxId);
    const carry = (kind: "asked" | "told") => {
      this.carried.set(boxId, (this.carried.get(boxId) ?? new Map()).set(skill.slug, { kind, digest }));
    };
    if (state === "declined") return undefined;
    if (state === "waiting") {
      if (this.asked.has(`${boxId}/${skill.slug}/${digest}`)) return undefined;
      const declared = this.declared.get(boxId)?.find(entry => entry.slug === skill.slug);
      const lines = [
        ...(skill.setup.install !== undefined ? [`install \`${skill.setup.install.run}\``, `check \`${skill.setup.install.check}\``] : []),
        ...(skill.setup.signIn !== undefined ? [`${skill.setup.signIn.name} sign-in \`${skill.setup.signIn.start}\``, `sign-in check \`${skill.setup.signIn.check}\``] : []),
      ];
      carry("asked");
      return `nothing of it runs here until the person agrees. Show them exactly what it would run, in its directory: ${lines.join("; ")}` +
        `${declared?.version !== undefined ? ` — version ${declared.version}` : ""}${declared?.publishedBy !== undefined ? `, published by ${declared.publishedBy}` : ""}. ` +
        `Ask once; they answer by writing \`agree ${skill.slug}\` or \`decline ${skill.slug}\`, or in Settings → Mine. Do not run these lines, or any its SKILL.md names, before they agree.`;
    }
    const owed = this.owed.get(boxId)?.get(skill.slug);
    if (owed === undefined || this.told.has(`${boxId}/${skill.slug}/${digest}`)) return undefined;
    const parts: string[] = [];
    if (owed.install && skill.setup.install !== undefined) {
      parts.push(`install it with \`${setupLine(skill.setup.install.run, place, skill.slug)}\` (done when \`${skill.setup.install.check}\` exits 0 there)`);
    }
    if (owed.signIn && skill.setup.signIn !== undefined) {
      parts.push(`then offer the ${skill.setup.signIn.name} sign-in: \`${setupLine(skill.setup.signIn.start, place, skill.slug)}\` starts it (done when \`${skill.setup.signIn.check}\` exits 0 there)`);
    }
    if (parts.length === 0) return undefined;
    carry("told");
    return `the person agreed; ${parts.join("; ")}.`;
  }

  /**
   * A turn ended. When a person opened it and the index of its box carried a question or what is
   * owed, that has now been said: written down, and not said again for those lines.
   */
  noteTurn(event: { type: string; agentId?: string; conversation?: string }): void {
    if (event.type !== "turn_finished" || event.agentId === undefined) return;
    const boxId = this.deps.boxOf(event.agentId);
    const carried = boxId === undefined ? undefined : this.carried.get(boxId);
    if (boxId === undefined || carried === undefined || carried.size === 0 || !this.deps.personOpened(event.agentId, event.conversation)) return;
    this.carried.delete(boxId);
    for (const [slug, { kind, digest }] of carried) {
      const key = `${boxId}/${slug}/${digest}`;
      if ((kind === "asked" ? this.asked : this.told).has(key)) continue;
      // A question carried after a yes arrived in the same turn is moot: only what is still waiting is marked asked.
      if (kind === "asked" && this.consent(boxId, slug, digest) !== "waiting") continue;
      this.write({ kind, at: this.stamp(), box: boxId, slug, digest, agent: event.agentId });
      if (kind === "told") this.owed.get(boxId)?.delete(slug);
      this.deps.log(`organisation skills: ${event.agentId} ${kind === "asked" ? "asked for agreement to" : "was told what is owed of"} ${slug} in ${boxId}`);
    }
  }
}
