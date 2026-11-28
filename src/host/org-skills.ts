/**
 * The organisation's skill library (INV-2222, docs/109 §6, docs/93 §1a).
 *
 * A skill lives in one box (docs/93 §1), so a tool every member needs was one import per box. The
 * organisation's skills live here instead, on the server, and are placed in every box by
 * `org-skill-sync.ts`: an Admin publishes once.
 *
 * - **Where.** `<home>/org-skills/<slug>/v<n>/`, each version a directory in the format a box
 *   skill has (SKILL.md, and the files beside it), and `<home>/org-skills.jsonl`, one line per act.
 *   A version's directory is written whole before its line is; the ledger is what is true, and a
 *   directory with no line is a publish that did not finish and is written over by the next.
 *   Withdrawing removes nothing here: the versions stay, so the record can show what each said.
 * - **The ledger** is the audit (docs/109 §7): `publish` (the first version, or the first after a
 *   withdrawal), `update` (a new version), `withdraw`, and `require` (required on or off), each
 *   with who and when. Append-only, never compacted, read whole at start; state is its fold.
 * - **What is refused at publish.** What a box's own skill is refused for (no body, no
 *   description, a bad frontmatter value, naming the host's own records), and what is refused
 *   because every box will carry it: a description past the index's limit, which a box's own
 *   skill merely has cut; anything credential-shaped in any file (docs/15: nothing that leaves a
 *   box carries one), or a value the vault holds; `scope: agent`, which names one box's agent;
 *   and a schedule or a trigger — published to everybody it would be a routine started in every
 *   box, and switching one on is each person's act (docs/29).
 * - **A member offers one of their own** (docs/109 §6, as knowledge is promoted — org-promotion.ts):
 *   `offer` keeps the files under `org-skills/.offers/<id>/` and writes an `offer` line. Held: it
 *   is placed in no box and read by no agent. An Admin sees the files and what the checks say, and
 *   decides: approved is a `decide` line and then an ordinary `publish` or `update` by that Admin,
 *   naming the offer; declined is a `decide` line with the reason. What is refused at publish is
 *   refused at the offer, so a credential never reaches the server's disk to wait for review.
 * - **A personal installation has none** (docs/95 §5): every write is refused there, and nothing
 *   is placed in its boxes.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { namesControlSurface } from "./control-surfaces.ts";
import type { InstallationMode } from "./installation.ts";
import { appendLineDurably, type LedgerKind } from "./jsonl.ts";
import { scanText } from "./secret-scan.ts";
import { IMPORT_MAX_FILE_BYTES, IMPORT_MAX_FILES, IMPORT_MAX_TOTAL_BYTES } from "./skill-import.ts";
import { MAX_DESCRIPTION_CHARS, parseSkillFile, SKILL_FILENAME, skillFrom, slugify } from "./skills.ts";

export const LEDGER_KIND: LedgerKind = "record";

/** The library's directory and its ledger, under the installation's home. */
export const ORG_SKILLS_DIR = "org-skills";
export const ORG_SKILLS_LEDGER = "org-skills.jsonl";
/** Under the library's directory: what members offered, each as it was offered. A leading dot, which no slug has. */
const OFFERS_DIR = ".offers";

/** A skill as it is carried: the shape a template's skill has (`TemplateSkill.files`). Relative path → text. */
export type SkillFiles = Readonly<Record<string, string>>;

/** One line of the ledger. */
export interface OrgSkillAct {
  at: string;
  act: "publish" | "update" | "withdraw" | "require" | "offer" | "decide";
  slug: string;
  /** The principal who did it (or the operator's key). */
  by: string;
  /** `publish` and `update`: the version this line makes current, what it holds, and where it came from. */
  version?: number;
  digest?: string;
  name?: string;
  description?: string;
  files?: string[];
  /** `upload`, `template:<name>`, or `box:<box id>/<slug>`. */
  source?: string;
  /** `require`: on or off. */
  required?: boolean;
  /** `offer`, its `decide`, and the `publish`/`update` an approval made: the offer's id. */
  offer?: string;
  /** `decide`: what the Admin decided, and why when it was declined. */
  decision?: "approved" | "declined";
  reason?: string;
}

/** A member's skill offered to the organisation, and where it stands. */
export interface OrgSkillOffer {
  id: string;
  slug: string;
  name: string;
  description: string;
  digest: string;
  files: string[];
  /** The member who offered it, when, and from where (`box:<box id>/<slug>`). */
  by: string;
  at: string;
  source: string;
  state: "waiting" | "approved" | "declined";
  /** Who decided, when, and the reason a declined one was given. */
  decidedBy?: string;
  decidedAt?: string;
  reason?: string;
}

/** A skill the organisation has now. */
export interface OrgSkill {
  slug: string;
  name: string;
  description: string;
  version: number;
  digest: string;
  files: string[];
  required: boolean;
  /** Who made this version current, and when. */
  by: string;
  at: string;
  source: string;
}

export type OrgSkillRefusal = "personal" | "invalid" | "credential" | "unknown" | "unchanged";
export type OrgOfferResult = { ok: true; offer: OrgSkillOffer; skill?: OrgSkill } | { ok: false; code: OrgSkillRefusal; why: string };
export type OrgSkillResult = { ok: true; skill: OrgSkill } | { ok: false; code: OrgSkillRefusal; why: string };

const SAFE_PATH = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** What every box would hold if this were placed: sorted paths and their text, hashed. */
export function digestOf(files: SkillFiles): string {
  const hash = createHash("sha256");
  for (const path of Object.keys(files).sort()) hash.update(`${path}\0${files[path]!.length}\0${files[path]!}\0`);
  return hash.digest("hex");
}

/**
 * Why these files are not published as `slug`, or undefined. `held` is the vault's values, by
 * name: one of them verbatim in a file is a credential whatever it is shaped like.
 */
export function publishRefusal(slug: string, files: SkillFiles, held: ReadonlyMap<string, string> = new Map()): { code: "invalid" | "credential"; why: string } | undefined {
  const invalid = (why: string) => ({ code: "invalid" as const, why });
  if (!SLUG.test(slug)) return invalid(`"${slug}" cannot be a skill's directory name: lowercase letters, digits, . _ and -, starting with a letter or a digit.`);
  const paths = Object.keys(files);
  const text = files[SKILL_FILENAME];
  if (typeof text !== "string") return invalid(`There is no ${SKILL_FILENAME}, so it is not a skill.`);
  if (paths.length > IMPORT_MAX_FILES) return invalid(`It has ${paths.length} files; a skill carries at most ${IMPORT_MAX_FILES}.`);
  let total = 0;
  for (const path of paths) {
    const content = files[path];
    if (!SAFE_PATH.test(path) || path.split("/").some(part => part === "." || part === "..")) return invalid(`"${path}" is not a path inside the skill.`);
    if (typeof content !== "string" || content.includes("\0")) return invalid(`${path} is not text; a skill carries text files only.`);
    const bytes = Buffer.byteLength(content);
    total += bytes;
    if (bytes > IMPORT_MAX_FILE_BYTES || total > IMPORT_MAX_TOTAL_BYTES) return invalid(`${path} makes the skill too large to place in every box.`);
    const named = namesControlSurface(content);
    if (named !== undefined) return invalid(`${path} names ${named}, which a skill may not touch.`);
    const found = scanText(content, held);
    // What kind, never its characters: a refusal that quotes the key has published most of it.
    if (found.exact.length > 0) return { code: "credential", why: `${path} holds the value of ${found.exact[0]}, which the vault keeps. A skill never carries a credential — name it under \`secrets:\` instead.` };
    if (found.patterns.length > 0) return { code: "credential", why: `${path} holds something shaped like a credential (${found.patterns[0]!.pattern}). A skill never carries one — say where it lives instead.` };
  }
  const parsed = parseSkillFile(text);
  const read = skillFrom(slug, parsed, paths.filter(path => path !== SKILL_FILENAME));
  if ("problem" in read) return invalid(read.problem);
  const length = (parsed.meta.description ?? "").trim().length;
  if (length > MAX_DESCRIPTION_CHARS) {
    return invalid(`${slug}: the description is ${length} characters; every agent of the organisation is sent it on every turn, so it is at most ${MAX_DESCRIPTION_CHARS}. Say when the skill applies and keep the rest in the body.`);
  }
  if (parsed.meta.scope?.trim() === "agent") return invalid(`${slug}: it is \`scope: agent\`, which names one agent of one box; an organisation skill is for every box.`);
  if (read.skill.schedule !== undefined || read.skill.listener !== undefined || read.skill.webhook === true) {
    return invalid(`${slug}: it has a schedule or a trigger. Published to everybody it would start a routine in every box; publish the recipe, and let each person turn on a routine of their own.`);
  }
  return undefined;
}

/** The slug an uploaded skill gets when none was given: from its name, as a box's own would. */
export function slugFor(files: SkillFiles): string {
  return slugify(parseSkillFile(files[SKILL_FILENAME] ?? "").meta.name ?? "");
}

export interface OrgSkillsDeps {
  /** The installation's mode, asked at each write. */
  mode: () => InstallationMode;
  /** The vault's values by name, for the exact-match half of the credential check. */
  held?: () => ReadonlyMap<string, string>;
  now?: () => Date;
}

const PERSONAL = "A personal installation has no organisation skills (docs/95 §5): its skills are its box's own.";

export class OrgSkills {
  private readonly log: OrgSkillAct[] = [];
  /** Replaced by the server, which knows whether this is the desktop app (`boxRegistrationModeAt`). */
  mode: () => InstallationMode;
  /** Replaced by the server, which holds the vault. */
  held: () => ReadonlyMap<string, string>;
  /** Told after every act that changes what boxes should hold: the server syncs them. */
  changed: () => void = () => {};

  constructor(private readonly home: string, private readonly deps: OrgSkillsDeps) {
    this.mode = deps.mode;
    this.held = deps.held ?? (() => new Map());
    const path = join(home, ORG_SKILLS_LEDGER);
    if (!existsSync(path)) return;
    for (const raw of readFileSync(path, "utf8").split("\n")) {
      if (raw.trim() === "") continue;
      let line: unknown;
      try { line = JSON.parse(raw); } catch { continue; } // a torn final line, left by a crash mid-append
      if (readable(line)) this.log.push(line);
    }
  }

  /** Every act, in order, as written: the audit. */
  acts(): readonly OrgSkillAct[] {
    return this.log;
  }

  /** What the organisation has now, by name; empty on a personal installation. */
  list(): OrgSkill[] {
    if (this.mode() === "single-machine") return [];
    const standing = new Map<string, OrgSkill>();
    for (const line of this.log) {
      if (line.act === "withdraw") standing.delete(line.slug);
      else if (line.act === "require") {
        const skill = standing.get(line.slug);
        if (skill !== undefined) standing.set(line.slug, { ...skill, required: line.required === true });
      } else if (line.version !== undefined && line.digest !== undefined) {
        standing.set(line.slug, {
          slug: line.slug, name: line.name ?? line.slug, description: line.description ?? "", version: line.version, digest: line.digest,
          files: line.files ?? [], required: standing.get(line.slug)?.required ?? false, by: line.by, at: line.at, source: line.source ?? "upload",
        });
      }
    }
    return [...standing.values()].sort((a, b) => a.slug.localeCompare(b.slug));
  }

  get(slug: string): OrgSkill | undefined {
    return this.list().find(skill => skill.slug === slug);
  }

  /** The slugs an Admin marked required. */
  required(): Set<string> {
    return new Set(this.list().filter(skill => skill.required).map(skill => skill.slug));
  }

  /** One number for "what every box should hold": changes with every publish, update and withdrawal. */
  revision(): string {
    return createHash("sha256").update(JSON.stringify(this.list().map(skill => [skill.slug, skill.digest]))).digest("hex").slice(0, 16);
  }

  /** The files of a standing skill's current version, read from its directory; undefined when the directory is not what the ledger says. */
  filesOf(skill: Pick<OrgSkill, "slug" | "version" | "digest">): SkillFiles | undefined {
    return this.readDir(this.versionDir(skill.slug, skill.version), skill.digest);
  }

  private readDir(dir: string, digest: string): SkillFiles | undefined {
    if (!existsSync(dir)) return undefined;
    const files: Record<string, string> = {};
    const walk = (at: string, prefix: string) => {
      for (const name of readdirSync(at).sort()) {
        const path = join(at, name);
        if (statSync(path).isDirectory()) walk(path, `${prefix}${name}/`);
        else files[`${prefix}${name}`] = readFileSync(path, "utf8");
      }
    };
    walk(dir, "");
    return digestOf(files) === digest ? files : undefined;
  }

  /**
   * Publishes `files` as `slug`: the first version, or a new one over the one standing. Refused
   * when it would change nothing, so the ledger has no version that is the one before it.
   */
  publish(slug: string, files: SkillFiles, by: string, source: string, offer?: string): OrgSkillResult {
    if (this.mode() === "single-machine") return { ok: false, code: "personal", why: PERSONAL };
    const refusal = publishRefusal(slug, files, this.held());
    if (refusal !== undefined) return { ok: false, ...refusal };
    const standing = this.get(slug);
    const digest = digestOf(files);
    if (standing !== undefined && standing.digest === digest) return { ok: false, code: "unchanged", why: `${slug} is already published exactly so (version ${standing.version}).` };
    const version = this.log.reduce((highest, line) => (line.slug === slug && line.version !== undefined ? Math.max(highest, line.version) : highest), 0) + 1;
    this.writeVersion(slug, version, files);
    const parsed = parseSkillFile(files[SKILL_FILENAME]!);
    this.append({
      at: this.now(), act: standing === undefined ? "publish" : "update", slug, by, version, digest,
      name: parsed.meta.name?.trim() || slug.replace(/-/g, " "), description: (parsed.meta.description ?? "").trim(), files: Object.keys(files).sort(), source,
      ...(offer !== undefined ? { offer } : {}),
    });
    return { ok: true, skill: this.get(slug)! };
  }

  /** Every offer made, oldest first, with where it stands. */
  offers(): OrgSkillOffer[] {
    const offers = new Map<string, OrgSkillOffer>();
    for (const line of this.log) {
      if (line.act === "offer" && line.offer !== undefined && line.digest !== undefined) {
        const { offer: id, slug, digest, by, at } = line;
        offers.set(id, { id, slug, name: line.name ?? slug, description: line.description ?? "", digest, files: line.files ?? [], by, at, source: line.source ?? "", state: "waiting" });
      } else if (line.act === "decide" && line.offer !== undefined && line.decision !== undefined) {
        const offer = offers.get(line.offer);
        if (offer !== undefined) offers.set(line.offer, { ...offer, state: line.decision, decidedBy: line.by, decidedAt: line.at, ...(line.reason !== undefined ? { reason: line.reason } : {}) });
      }
    }
    return [...offers.values()];
  }

  /** An offer's files, as they were offered; undefined when they are not what the ledger says. */
  offerFiles(offer: Pick<OrgSkillOffer, "id" | "digest">): SkillFiles | undefined {
    return this.readDir(join(this.home, ORG_SKILLS_DIR, OFFERS_DIR, offer.id), offer.digest);
  }

  /** A member offers a skill of theirs: held for an Admin, placed nowhere. Refused for what a publish is refused for. */
  offer(slug: string, files: SkillFiles, by: string, source: string): OrgOfferResult {
    if (this.mode() === "single-machine") return { ok: false, code: "personal", why: PERSONAL };
    const refusal = publishRefusal(slug, files, this.held());
    if (refusal !== undefined) return { ok: false, ...refusal };
    const digest = digestOf(files);
    if (this.get(slug)?.digest === digest) return { ok: false, code: "unchanged", why: `${slug} is already an organisation skill, exactly so.` };
    if (this.offers().some(offer => offer.state === "waiting" && offer.slug === slug && offer.digest === digest)) return { ok: false, code: "unchanged", why: `${slug} is already waiting for an Admin, exactly so.` };
    const id = `o${this.log.filter(line => line.act === "offer").length + 1}-${digest.slice(0, 8)}`;
    this.writeDir(join(this.home, ORG_SKILLS_DIR, OFFERS_DIR, id), files);
    const parsed = parseSkillFile(files[SKILL_FILENAME]!);
    this.append({
      at: this.now(), act: "offer", slug, by, offer: id, digest, source,
      name: parsed.meta.name?.trim() || slug.replace(/-/g, " "), description: (parsed.meta.description ?? "").trim(), files: Object.keys(files).sort(),
    });
    return { ok: true, offer: this.offers().find(offer => offer.id === id)! };
  }

  /**
   * An Admin decides an offer that waits. Approved: it is published as that Admin's act, exactly
   * as offered, and the decision is recorded only when the publish stood. Declined: with a reason
   * the member is given.
   */
  decideOffer(id: string, decision: "approved" | "declined", by: string, reason = ""): OrgOfferResult {
    if (this.mode() === "single-machine") return { ok: false, code: "personal", why: PERSONAL };
    const offer = this.offers().find(candidate => candidate.id === id && candidate.state === "waiting");
    if (offer === undefined) return { ok: false, code: "unknown", why: "That offer is not waiting: it was decided already, or never made." };
    if (decision === "declined") {
      if (reason.trim() === "") return { ok: false, code: "invalid", why: "Say why it is declined: the member who offered it is told." };
      this.append({ at: this.now(), act: "decide", slug: offer.slug, by, offer: id, decision, reason: reason.trim() });
      return { ok: true, offer: this.offers().find(candidate => candidate.id === id)! };
    }
    const files = this.offerFiles(offer);
    if (files === undefined) return { ok: false, code: "invalid", why: "The offer's files are not what was offered any more; ask for it again." };
    const published = this.publish(offer.slug, files, by, `offer:${id} from ${offer.by} (${offer.source})`, id);
    if (!published.ok) return published;
    this.append({ at: this.now(), act: "decide", slug: offer.slug, by, offer: id, decision });
    return { ok: true, offer: this.offers().find(candidate => candidate.id === id)!, skill: published.skill };
  }

  /** Withdraws a skill: it leaves every box at the next sync. Its versions stay here. */
  withdraw(slug: string, by: string): OrgSkillResult {
    if (this.mode() === "single-machine") return { ok: false, code: "personal", why: PERSONAL };
    const standing = this.get(slug);
    if (standing === undefined) return { ok: false, code: "unknown", why: `The organisation has no skill ${slug}.` };
    this.append({ at: this.now(), act: "withdraw", slug, by });
    return { ok: true, skill: standing };
  }

  /** Marks a skill required, or not: a required skill is read in a box that has its own by that name (docs/93 §1a). */
  require(slug: string, required: boolean, by: string): OrgSkillResult {
    if (this.mode() === "single-machine") return { ok: false, code: "personal", why: PERSONAL };
    const standing = this.get(slug);
    if (standing === undefined) return { ok: false, code: "unknown", why: `The organisation has no skill ${slug}.` };
    if (standing.required === required) return { ok: false, code: "unchanged", why: `${slug} is already ${required ? "required" : "not required"}.` };
    this.append({ at: this.now(), act: "require", slug, by, required });
    return { ok: true, skill: this.get(slug)! };
  }

  private now(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }

  private versionDir(slug: string, version: number): string {
    return join(this.home, ORG_SKILLS_DIR, slug, `v${version}`);
  }

  /** The version's directory, whole or not at all: written beside itself and renamed into place. */
  private writeVersion(slug: string, version: number, files: SkillFiles): void {
    this.writeDir(this.versionDir(slug, version), files);
  }

  private writeDir(dir: string, files: SkillFiles): void {
    const staging = `${dir}.writing`;
    rmSync(staging, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true }); // a directory with no line: a write that did not finish
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(staging, path)), { recursive: true, mode: 0o700 });
      writeFileSync(join(staging, path), content, { mode: 0o600 });
    }
    renameSync(staging, dir);
  }

  private append(line: OrgSkillAct): void {
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
    appendLineDurably(join(this.home, ORG_SKILLS_LEDGER), JSON.stringify(line));
    this.log.push(line);
    // An offer and its decision change nothing a box holds; the publish an approval makes does.
    if (line.act !== "offer" && line.act !== "decide") this.changed();
  }
}

function readable(line: unknown): line is OrgSkillAct {
  if (typeof line !== "object" || line === null) return false;
  const act = line as Partial<OrgSkillAct>;
  return typeof act.at === "string" && typeof act.slug === "string" && typeof act.by === "string" && ["publish", "update", "withdraw", "require", "offer", "decide"].includes(act.act ?? "");
}
