/**
 * A commit's product, frozen, under this checkout's harness (INV-1862).
 *
 * To compare two versions of the prompt and the tools, each has to be the product as it was at
 * that commit — its `prompt.ts`, its tool list, its parsers — while the tasks, the graders and
 * the runner stay one instrument for both. So a commit's tree is exported into a scratch
 * directory, this checkout's `src/evals/` is laid over it, and the subjects are imported from
 * there: `subjects.ts` reaches the product by relative import, so the copy in the frozen tree
 * drives that commit's product and nothing else of it.
 *
 * The tree is `git archive`, not `git worktree add`: an export registers nothing in the
 * repository, so a comparison cannot leave a worktree behind in a checkout other sessions share,
 * and nothing in it can be committed by mistake.
 *
 * Packages come from this checkout's `node_modules`. A commit whose `package-lock.json` differs
 * is refused rather than run on packages it did not pin: its numbers would be about the packages.
 */

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { SubjectName } from "./corpus.ts";
import type { Subject } from "./subjects.ts";
import type { AgentConfiguration, PromptSurface } from "./surface.ts";

const HARNESS = fileURLToPath(new URL("../..", import.meta.url));
const CORPUS_FILES = ["evals/corpus/dev.jsonl", "evals/corpus/test.jsonl"];

export interface FrozenBuild {
  /** The ref as it was asked for, and the commit it named when it was frozen. */
  ref: string;
  sha: string;
  /** The scratch directory holding the tree. */
  dir: string;
  /** This checkout's subjects, driving that commit's product. */
  subjects: Readonly<Record<SubjectName, Subject>>;
  /** The prompt and tool schema that commit sends an agent of this configuration (surface.ts). */
  promptSurface: (configuration?: AgentConfiguration) => Promise<PromptSurface>;
  /** Whether that commit's own corpus is the one this checkout holds. Its own is never run. */
  ownCorpus: "same" | "different" | "none";
  /** Removes the scratch directory. */
  release: () => void;
}

export interface FreezeOptions {
  /** The repository the ref is resolved in. Default: this checkout. */
  repo?: string;
  ref: string;
  /** The checkout whose `src/evals/` and `node_modules` are used. Default: this one. */
  harness?: string;
}

const git = (repo: string, args: readonly string[], encoding: "utf8" | "buffer" = "utf8"): string | Buffer =>
  execFileSync("git", args, { cwd: repo, encoding, maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "pipe"] });

/** The commit a ref names, or a sentence saying it names none. */
export function resolveRef(repo: string, ref: string): string {
  try {
    return (git(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]) as string).trim();
  } catch {
    throw new Error(`${ref} names no commit in ${repo}`);
  }
}

export async function freezeRef(options: FreezeOptions): Promise<FrozenBuild> {
  const harness = options.harness ?? HARNESS;
  const repo = options.repo ?? harness;
  const sha = resolveRef(repo, options.ref);
  const named = `${options.ref} (${sha.slice(0, 7)})`;
  let lock: string;
  try {
    lock = git(repo, ["show", `${sha}:package-lock.json`]) as string;
  } catch {
    throw new Error(`${named} has no package-lock.json: it is not a commit of this product`);
  }
  if (lock !== readFileSync(join(harness, "package-lock.json"), "utf8")) {
    throw new Error(`${named} pins other packages than this checkout (package-lock.json differs), and would be run on this checkout's. Compare from a checkout that shares its lock file.`);
  }

  const dir = mkdtempSync(join(tmpdir(), "lumenbox-eval-ref-"));
  const release = () => rmSync(dir, { recursive: true, force: true });
  try {
    execFileSync("tar", ["-x", "-C", dir], { input: git(repo, ["archive", "--format=tar", sha], "buffer") });
    const same = CORPUS_FILES.map(file => {
      const own = join(dir, file);
      return existsSync(own) ? readFileSync(own, "utf8") === readFileSync(join(harness, file), "utf8") : undefined;
    });
    // The harness of now over the product of then. Tests stay behind: nothing runs them there.
    mkdirSync(join(dir, "src/evals"), { recursive: true });
    for (const file of readdirSync(join(harness, "src/evals"))) {
      if (file.endsWith(".ts") && !file.endsWith(".test.ts")) cpSync(join(harness, "src/evals", file), join(dir, "src/evals", file));
    }
    symlinkSync(join(harness, "node_modules"), join(dir, "node_modules"), "dir");
    const load = (file: string) => import(pathToFileURL(join(dir, "src/evals", file)).href);
    const [subjects, surface] = await Promise.all([load("subjects.ts"), load("surface.ts")]).catch(error => {
      throw new Error(`${named} cannot be run by this checkout's harness: ${error instanceof Error ? error.message : String(error)}`);
    });
    return {
      ref: options.ref, sha, dir,
      subjects: subjects.SUBJECT_TABLE,
      promptSurface: surface.promptSurface,
      ownCorpus: same.every(one => one === undefined) ? "none" : same.every(one => one === true) ? "same" : "different",
      release,
    };
  } catch (error) {
    release();
    throw error;
  }
}

/** The prompt and tool schema an agent of this configuration is sent at a commit. */
export async function promptSurfaceAt(options: FreezeOptions, configuration: AgentConfiguration = {}): Promise<PromptSurface> {
  const build = await freezeRef(options);
  try {
    return await build.promptSurface(configuration);
  } catch (error) {
    throw new Error(`${options.ref} (${build.sha.slice(0, 7)}) cannot be run by this checkout's harness: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    build.release();
  }
}
