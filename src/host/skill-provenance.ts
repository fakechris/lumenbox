/**
 * Who wrote each skill, as the host saw it happen.
 *
 * A skill file is writable by any agent, and its frontmatter can name which agent a schedule runs
 * as — so without a record of authorship, `agent: Ada` in a file Bob wrote is Bob borrowing Ada's
 * permissions (audit 2026-09-01 #2, and the reason the scheduler refused every `agent:` but the
 * default). `authored_by` in the file is what the writer *claims*; this ledger is what the host
 * *observed*: every write that reached a skill directory through a tool, with the agent that
 * made the call. The scheduler consults it to let an agent run its own skill as itself, and only
 * that.
 *
 * The hole that remains: a write through `bash` is attributed by reading the command text for a
 * skill path and a write-shaped operator, which a determined agent can dodge. A skill with no
 * record is treated as unattributed, and unattributed skills run only as the default agent.
 */

import { existsSync, readFileSync } from "node:fs";
import { appendLine } from "./jsonl.ts";
import { SKILLS_DIR } from "./skills.ts";

export interface Writer {
  agentId: string;
  agentName: string;
  tool: string;
  at: string;
}

/** The skill a path belongs to, or undefined when it is not under the skills directory. */
export function skillSlugOf(path: string): string | undefined {
  const normalised = path.replace(/^~\/work\//, `${"/home/box/work"}/`);
  if (!normalised.startsWith(`${SKILLS_DIR}/`)) return undefined;
  const slug = normalised.slice(SKILLS_DIR.length + 1).split("/")[0];
  return slug === undefined || slug === "" ? undefined : slug;
}

const SKILL_PATH = /(?:~\/work|\/home\/box\/work)\/skills\/([A-Za-z0-9._-]+)/g;
const WRITE_SHAPED = /(>|>>|\btee\b|\bcp\b|\bmv\b|\bsed\s+-i|\binstall\b|\brsync\b|\bln\b|\btouch\b|\bcat\s*<<|\bgit\s+(checkout|pull|clone|apply))/;

/** The skills a shell command looks like it writes to. Coarse on purpose; see the module note. */
export function skillsWrittenBy(command: string): string[] {
  if (!WRITE_SHAPED.test(command)) return [];
  const slugs = new Set<string>();
  for (const match of command.matchAll(SKILL_PATH)) slugs.add(match[1]!);
  return [...slugs];
}

export class SkillProvenance {
  private readonly writers = new Map<string, Writer>();

  /** `path` null keeps no file, for tests. */
  constructor(private readonly path: string | null) {
    if (path === null || !existsSync(path)) return;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      try {
        const record = JSON.parse(line) as Partial<Writer> & { slug?: string };
        if (typeof record.slug === "string" && typeof record.agentId === "string") {
          this.writers.set(record.slug, {
            agentId: record.agentId,
            agentName: record.agentName ?? record.agentId,
            tool: record.tool ?? "?",
            at: record.at ?? "",
          });
        }
      } catch {
        // A torn line costs that record, not the file.
      }
    }
  }

  /** Records a tool-path write to `path`, if it is inside a skill. Returns the slug when it was. */
  noteWrite(input: { path: string; agentId: string; agentName: string; tool: string }): string | undefined {
    const slug = skillSlugOf(input.path);
    if (slug !== undefined) this.record(slug, input);
    return slug;
  }

  /** Records what a shell command looks like it writes. Returns the slugs it attributed. */
  noteCommand(input: { command: string; agentId: string; agentName: string }): string[] {
    const slugs = skillsWrittenBy(input.command);
    for (const slug of slugs) this.record(slug, { ...input, tool: "bash" });
    return slugs;
  }

  /** The last agent seen writing this skill, or undefined when no tool-path write was ever seen. */
  writerOf(slug: string): Writer | undefined {
    return this.writers.get(slug);
  }

  private record(slug: string, input: { agentId: string; agentName: string; tool: string }): void {
    const writer: Writer = {
      agentId: input.agentId,
      agentName: input.agentName,
      tool: input.tool,
      at: new Date().toISOString(),
    };
    this.writers.set(slug, writer);
    if (this.path !== null) appendLine(this.path, JSON.stringify({ slug, ...writer }));
  }
}
