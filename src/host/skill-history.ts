/**
 * The history of host-mediated skills (INV-1376): every draft and every publish is a git commit,
 * every publish a tag `skill/<dir>/vN`, each with a CARD.md saying where it came from, who
 * published it, and what it was and was not tested on. A rollback publishes an older version
 * again as a new one; history is only ever appended.
 *
 * Scope, stated: the skills this records are the ones the host publishes — teaching drafts and
 * imports (teach-drafts.ts). A skill an agent writes or edits directly in the box with write_file
 * or bash is the agent's file and lives only in the box; skill provenance records who wrote it,
 * and a skill.yaml contract (INV-1375) limits what it may change.
 *
 * One git repository under the host's own home, driven through the git binary; no remote. A
 * credential shape in any file refuses the commit, so history never carries one.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { credentialIn } from "./secret-scan.ts";

export interface SkillVersion {
  version: number;
  tag: string;
  at: string;
  author: string;
  message: string;
}

export interface PublishRecord {
  dir: string;
  name: string;
  files: Record<string, string>;
  actor: string;
  source: string;
  draftId?: string;
  note?: string;
}

const SAFE_DIR = /^[A-Za-z0-9._-]+$/;
const SAFE_PATH = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

export class SkillHistory {
  constructor(readonly root: string) {}

  private git(args: string[], author?: string, raw = false): string {
    const identity = ["-c", "user.name=lumenbox", "-c", "user.email=lumenbox@localhost", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "-c", "core.hooksPath=/dev/null"];
    // The author rides as --author on a commit and as the tagger identity on a tag; no environment.
    const who = author === undefined ? [] : args[0] === "commit" ? [`--author=${author.replace(/[<>\n]/g, "")} <${author.replace(/[^A-Za-z0-9._-]/g, "-")}@lumenbox.local>`] : [];
    const tagger = author !== undefined && args[0] === "tag" ? ["-c", `user.name=${author.replace(/[<>\n]/g, "")}`] : [];
    const output = execFileSync("git", [...identity, ...tagger, ...args, ...who], { cwd: this.root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return raw ? output : output.trim();
  }

  private ensure(): void {
    if (existsSync(join(this.root, ".git"))) return;
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.git(["init", "-q", "-b", "main"]);
    this.git(["commit", "-q", "--allow-empty", "-m", "skill history begins"]);
  }

  private writeTree(base: string, files: Record<string, string>): void {
    for (const [path, content] of Object.entries(files)) {
      if (!SAFE_PATH.test(path) || path.split("/").includes("..")) throw new Error(`Refusing to record ${path}: not a plain relative path`);
      const credential = credentialIn(content);
      if (credential !== undefined) throw new Error(`Refusing to record ${path}: it holds something shaped like a credential (${credential})`);
      const target = join(this.root, base, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
  }

  /** A draft as proposed: author is the agent (or the import), message says from what. */
  recordDraft(draft: { id: string; agentName: string; source: string; files: Record<string, string> }): void {
    this.ensure();
    const base = join("drafts", draft.id);
    rmSync(join(this.root, base), { recursive: true, force: true });
    this.writeTree(base, draft.files);
    this.git(["add", "-A", base]);
    this.git(["commit", "-q", "--allow-empty", "-m", `draft ${draft.id.slice(0, 12)} by ${draft.agentName}\n\nfrom: ${draft.source}`], `agent:${draft.agentName}`);
  }

  versions(dir: string): SkillVersion[] {
    if (!SAFE_DIR.test(dir) || !existsSync(join(this.root, ".git"))) return [];
    const out = this.git(["tag", "-l", `skill/${dir}/v*`, "--format=%(refname:short)\t%(creatordate:iso-strict)\t%(taggername)\t%(subject)"]);
    return out
      .split("\n")
      .filter(line => line !== "")
      .map(line => {
        const [tag, at, author, message] = line.split("\t") as [string, string, string, string];
        return { version: Number(/v(\d+)$/.exec(tag)?.[1] ?? 0), tag, at, author, message };
      })
      .sort((a, b) => a.version - b.version);
  }

  /** The version the next publish of this skill will get. */
  nextVersion(dir: string): number {
    return (this.versions(dir).at(-1)?.version ?? 0) + 1;
  }

  /** The CARD.md for a publish: provenance and the honest limits of what was checked. */
  static card(record: PublishRecord, version: number, at: string): string {
    return [
      `# ${record.name} — v${version}`,
      "",
      `- Published: ${at} by ${record.actor}`,
      `- Source: ${record.source}`,
      ...(record.draftId !== undefined ? [`- Draft: ${record.draftId}`] : []),
      ...(record.note !== undefined ? [`- Note: ${record.note}`] : []),
      `- Files: ${Object.keys(record.files).sort().join(", ")}`,
      "- Evaluated: no recorded evaluation for this version (teach evals: npm run scenario -- --teach)",
      "- Not tested on: anything beyond the demonstration or import it came from; a person reviewed the text before publishing, nobody ran it",
      "",
      "Generated by the host at publication; an agent's edit to it does not change this history.",
      "",
    ].join("\n");
  }

  /** A publish: the skill's files and its CARD.md committed under skills/<dir>/, tagged vN. */
  recordPublish(record: PublishRecord, at: string = new Date().toISOString()): { version: number; card: string } {
    if (!SAFE_DIR.test(record.dir)) throw new Error(`Not a skill directory name: ${record.dir}`);
    this.ensure();
    const version = this.nextVersion(record.dir);
    const card = SkillHistory.card(record, version, at);
    const base = join("skills", record.dir);
    rmSync(join(this.root, base), { recursive: true, force: true });
    this.writeTree(base, { ...record.files, "CARD.md": card });
    this.git(["add", "-A", base]);
    const message = `publish ${record.dir} v${version}${record.note !== undefined ? ` (${record.note})` : ""}`;
    this.git(["commit", "-q", "--allow-empty", "-m", `${message}\n\nby: ${record.actor}\nfrom: ${record.source}`], record.actor);
    this.git(["tag", "-a", `skill/${record.dir}/v${version}`, "-m", message], record.actor);
    return { version, card };
  }

  /** The files of one published version, CARD.md excluded. */
  filesAt(dir: string, version: number): Record<string, string> {
    if (!SAFE_DIR.test(dir)) throw new Error(`Not a skill directory name: ${dir}`);
    const tag = `skill/${dir}/v${version}`;
    const prefix = `skills/${dir}/`;
    const names = this.git(["ls-tree", "-r", "--name-only", tag, "--", prefix]).split("\n").filter(name => name !== "");
    if (names.length === 0) throw new Error(`No version ${version} of ${dir}`);
    const files: Record<string, string> = {};
    for (const name of names) {
      const rel = name.slice(prefix.length);
      if (rel === "CARD.md") continue;
      files[rel] = this.git(["show", `${tag}:${name}`], undefined, true);
    }
    return files;
  }
}
