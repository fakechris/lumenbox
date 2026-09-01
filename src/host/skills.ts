/**
 * Work an agent has done once and can do again.
 *
 * The whole model in one sentence, and it is worth keeping that small: **a skill is a saved prompt
 * the agent runs.** Not a plugin, not a DSL, not a workflow graph. A markdown file saying how to do
 * something, optionally with scripts beside it.
 *
 * Where they live is the decision that makes everything else easy. `/home/box/work/skills/<slug>/`,
 * which is the box's work volume, because that is the only place that satisfies all three things a
 * skill has to be:
 *
 *   - **writable by the agent** with the tools it already has — it can write a skill with `bash` or
 *     `write_file` the moment it works something out, without a new tool for authoring;
 *   - **readable and editable by a person**, through the files view that already serves that
 *     directory;
 *   - **durable**, since that volume is the one that survives a rebuild.
 *
 * The third argument is the decisive one on its own: a skill with a helper script needs the script
 * where `bash` can run it. Anywhere outside the box fails that immediately.
 *
 * **Bodies are not in the prompt.** The prompt carries names, descriptions and paths — enough to
 * decide which skill applies — and the agent reads the one it wants. A dozen skills pasted into every
 * request would cost more than the conversation, and the same reasoning already governs memory and
 * compaction here: load an index, drill down on demand.
 *
 * No new tool for invoking one, deliberately. The agent has `read_file`; a `UseSkill` tool would be a
 * second way to read a file, and the framing a skill needs ("this is a recipe you wrote, adapt it
 * where the situation differs") belongs in the one place the list is rendered rather than in a tool
 * result nobody sees until they call it.
 */

import { envNumber } from "../config.ts";
import { describeSchedule, knownTimezone, parseSchedule, type Schedule } from "./schedule.ts";

/** Where skills live inside the box. Under the work volume for the reasons in the module comment. */
export const SKILLS_DIR = "/home/box/work/skills";

/** The one file that makes a directory a skill. */
export const SKILL_FILENAME = "SKILL.md";

export interface Skill {
  /** The directory name, which is the id. Stable, and what a path is built from. */
  slug: string;
  name: string;
  /** One line. This is what the agent reads when deciding whether the skill applies. */
  description: string;
  /**
   * Whose it is.
   *
   * `global` — anyone here may use it. `agent` — written for one agent's own work, and cluttering
   * everyone else's prompt with it would be the roster problem again.
   */
  scope: SkillScope;
  /** When `scope` is `agent`, whose. Ignored otherwise. */
  owner?: string;
  /** Absolute path of the markdown, so the agent can read it without constructing anything. */
  path: string;
  /** Scripts and assets beside the markdown, named so the agent knows they are there to be run. */
  helpers: readonly string[];
  /**
   * When it runs by itself, if it does.
   *
   * A skill with a schedule is an automation. No second object and no second store: the only
   * difference between a recipe and an automation is a line of frontmatter.
   */
  schedule?: Schedule;
  /** Which agent a scheduled run wakes. Defaults to the coordinator, i.e. whoever is listed first. */
  runAs?: string;
  /**
   * The IANA zone the schedule's times are read in — `America/New_York`, not `ET`.
   *
   * Absent means the host's own clock, which is what every schedule used before this
   * existed. That default is fine for a box whose owner sits beside it and wrong the
   * moment a time is agreed in someone else's zone: "06:30 ET" fired at 06:30 wherever
   * the machine happened to be, and would have drifted by an hour twice a year on top.
   */
  timezone?: string;
  /**
   * The chat a run reports to. A `chatKey` — `feishu:oc_…` — or absent.
   *
   * Absent, the run happens and no chat hears anything, which is right for a tidy-up and
   * wrong for a morning brief. Before this, *every* scheduled skill was the silent kind:
   * the turn ran in the main conversation, which no chat reads.
   */
  deliver?: string;
  /**
   * Who wrote this, when an agent did — and why it thought the routine was worth having.
   *
   * Not a permission and not a gate. An agent can already create a scheduled routine
   * (skills live under the work directory it writes to every day), and forbidding that
   * would trade away the loop that makes an assistant improve — noticing that an ad-hoc
   * request keeps recurring and standing it up as a routine — for a risk the budget
   * already bounds. What was missing is not approval, it is *provenance*: a standing
   * commitment nobody remembers agreeing to should at least say where it came from, so
   * the review can happen afterwards rather than the decision beforehand.
   */
  authoredBy?: string;
  /** Why it exists, in the author's words. Shown wherever the routine is listed. */
  because?: string;
}

export type SkillScope = "global" | "agent";

/** Frontmatter keys that mean something. Anything else is ignored rather than rejected. */
const KNOWN_KEYS = new Set([
  "name",
  "description",
  "scope",
  "owner",
  "schedule",
  "agent",
  "timezone",
  "deliver",
  "authored_by",
  "because",
]);

export interface ParsedSkill {
  meta: Record<string, string>;
  body: string;
}

/**
 * Splits `---` frontmatter from the body.
 *
 * Deliberately not YAML. Adding a YAML parser to a project with two runtime dependencies to read
 * four `key: value` lines would be a poor trade, and the failure mode of a real YAML parser here is
 * worse than this one's: it rejects a file a person hand-edited slightly wrong, where this treats the
 * whole thing as a body and the skill still works with a name derived from its directory.
 */
export function parseSkillFile(text: string): ParsedSkill {
  const normalised = text.replace(/^﻿/, "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(normalised);
  if (match === null) return { meta: {}, body: normalised.trim() };

  const meta: Record<string, string> = {};
  const lines = (match[1] ?? "").split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const at = line.indexOf(":");
    if (at <= 0) continue;
    const key = line.slice(0, at).trim().toLowerCase();
    if (!KNOWN_KEYS.has(key)) continue;
    // Quotes stripped because a person writing frontmatter by hand will sometimes add them, and a
    // name of `"Weekly report"` with the quotes in it looks like a bug in our code.
    // Hub skills (WorkBuddy / skill-hub) use YAML `|` blocks for description; fold them
    // into one line so the prompt index still has something to match on.
    let value = line.slice(at + 1).trim();
    if (value === "|" || value === "|-" || value === ">" || value === ">-") {
      const block: string[] = [];
      while (index + 1 < lines.length && /^(?: {2}|\t)/.test(lines[index + 1]!)) {
        index += 1;
        block.push(lines[index]!.replace(/^(?: {2}|\t)/, "").trim());
      }
      value = block.join(" ").replace(/\s+/g, " ").trim();
    } else {
      // A quoted value is exactly its quoted span, whatever follows: our own prompt's
      // example writes `schedule: "0 9 * * 1"  # cron, or @daily`, and an agent that
      // imitates it verbatim used to hand the schedule parser the comment too — the
      // skill was then rejected whole, invisibly to the agent that wrote it. Unquoted
      // values lose an inline ` # comment` the same way YAML would.
      const quoted = /^(["'])(.*?)\1/.exec(value);
      value = quoted ? quoted[2]! : value.replace(/\s+#.*$/, "").replace(/^["']|["']$/g, "");
    }
    meta[key] = value;
  }
  return { meta, body: normalised.slice(match[0].length).trim() };
}

/** A directory name from a skill name: lowercase, hyphenated, and safe in a path. */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  // A name with nothing usable in it — CJK, emoji — still needs a directory. Same reasoning as
  // container names: refusing would mean only serving people who name things in ASCII.
  return slug === "" ? `skill-${simpleHash(name)}` : slug;
}

function simpleHash(text: string): string {
  let hash = 0;
  for (let at = 0; at < text.length; at++) {
    hash = (hash * 31 + text.charCodeAt(at)) | 0;
  }
  return Math.abs(hash).toString(36).slice(0, 8);
}

/**
 * Builds a skill from what was found on disk, or explains why it is not one.
 *
 * A directory without a readable `SKILL.md` is simply not a skill — that is not an error, it is a
 * directory. A skill without a description *is* worth complaining about, because the description is
 * the only thing the agent sees when choosing, and one that says nothing makes the skill invisible in
 * practice while appearing to exist.
 */
export function skillFrom(
  slug: string,
  parsed: ParsedSkill,
  helpers: readonly string[] = []
): { skill: Skill } | { problem: string } {
  if (parsed.body.trim() === "") {
    return { problem: `${slug}: ${SKILL_FILENAME} has no content, so there is nothing to run.` };
  }
  const name = parsed.meta.name?.trim() || slug.replace(/-/g, " ");
  const description = parsed.meta.description?.trim() ?? "";
  if (description === "") {
    return {
      problem:
        `${slug}: no description. Add \`description:\` to the frontmatter — it is the only thing ` +
        `read when deciding whether this skill applies, so without it the skill exists but is never ` +
        `chosen.`,
    };
  }
  const scope: SkillScope = parsed.meta.scope?.trim() === "agent" ? "agent" : "global";

  // A schedule that cannot be read is reported rather than ignored. Silently dropping it leaves a
  // skill that looks scheduled in its own file and never fires, which is the hardest kind of
  // not-working to notice.
  let schedule: Schedule | undefined;
  const scheduleText = parsed.meta.schedule?.trim();
  if (scheduleText !== undefined && scheduleText !== "") {
    const result = parseSchedule(scheduleText);
    if ("problem" in result) return { problem: `${slug}: ${result.problem}` };
    schedule = result.schedule;
  }

  // A zone is checked here rather than at fire time, because the failure it prevents is
  // silent: an unknown name would fall back to the host clock and the schedule would run
  // at plausible-looking wrong times forever. Refused with the name, so the fix is
  // obvious — the common mistake is writing "ET" or "EST" where IANA wants
  // "America/New_York".
  const timezone = parsed.meta.timezone?.trim();
  if (timezone !== undefined && timezone !== "" && !knownTimezone(timezone)) {
    return {
      problem:
        `${slug}: unknown timezone "${timezone}". Use an IANA name such as ` +
        `America/New_York or Asia/Shanghai, not an abbreviation.`,
    };
  }
  if (timezone !== undefined && timezone !== "" && schedule === undefined) {
    return { problem: `${slug}: timezone is set but there is no schedule for it to apply to.` };
  }

  // Likewise a delivery target with nothing to deliver: the person meant to schedule it.
  const deliver = parsed.meta.deliver?.trim();
  if (deliver !== undefined && deliver !== "" && schedule === undefined) {
    return { problem: `${slug}: deliver is set but the skill has no schedule, so nothing fires.` };
  }

  return {
    skill: {
      slug,
      name,
      description,
      scope,
      ...(scope === "agent" && parsed.meta.owner ? { owner: parsed.meta.owner.trim() } : {}),
      path: `${SKILLS_DIR}/${slug}/${SKILL_FILENAME}`,
      helpers,
      ...(schedule !== undefined ? { schedule } : {}),
      ...(parsed.meta.agent ? { runAs: parsed.meta.agent.trim() } : {}),
      ...(timezone !== undefined && timezone !== "" ? { timezone } : {}),
      ...(deliver !== undefined && deliver !== "" ? { deliver } : {}),
      ...(parsed.meta.authored_by ? { authoredBy: parsed.meta.authored_by.trim() } : {}),
      ...(parsed.meta.because ? { because: parsed.meta.because.trim() } : {}),
    },
  };
}

/**
 * The skills this agent should be told about.
 *
 * A `global` skill is for everyone. An `agent`-scoped one reaches only its owner, because the whole
 * reason for the scope is that one agent's private recipe should not occupy every other agent's
 * prompt — the same roster cost that keeps the starter team at four.
 */
export function visibleTo(skills: readonly Skill[], agentName: string): Skill[] {
  return skills
    .filter(skill => skill.scope === "global" || skill.owner === agentName)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * How skills appear in the prompt: an index, never the bodies.
 *
 * The framing is the load-bearing part. A list of filenames tells an agent nothing about what to do
 * with them, and the two failure modes worth pre-empting are opposite: ignoring a skill that applies,
 * and following one word-for-word when the situation has moved on.
 */
export function renderSkills(skills: readonly Skill[]): string {
  if (skills.length === 0) return "";
  const lines = skills.map(skill => {
    const when = skill.schedule === undefined ? "" : ` — runs ${describeSchedule(skill.schedule)}`;
    const helpers =
      skill.helpers.length === 0
        ? ""
        : ` — with ${skill.helpers.join(", ")} in the same directory`;
    return `- **${skill.name}** — ${skill.description}${when}\n  \`${skill.path}\`${helpers}`;
  });
  return [
    "## Skills you can reuse",
    "",
    "Recipes for work already worked out once, written by you or by someone here. Only the names and",
    "descriptions are here; read the file when one applies.",
    "",
    ...lines,
    "",
    "Follow one where it fits and adapt it where the situation has moved on — a skill is a record of",
    "what worked before, not an instruction that overrides what you can see now. If you find one is",
    "wrong or out of date, fix the file rather than working around it. And when you work something",
    "out that you would want next time, write a new one the same way.",
    "",
    "**A skill with a `schedule:` runs by itself, and you may write one.** When you notice you are",
    "being asked for the same thing on a rhythm — every Monday, after every deploy — standing it up",
    "as a routine is better than waiting to be asked again. Say who wrote it and why:",
    "",
    "```",
    "schedule: \"0 9 * * 1\"",
    "timezone: America/New_York",
    "agent: Ada",
    "deliver: feishu:oc_…",
    "authored_by: Ada",
    "because: they asked for this three Mondays running",
    "```",
    "",
    "schedule is cron or @daily / @every 30m; timezone an IANA name (omit for this",
    "machine's clock); deliver the chat it reports to (omit and no chat hears it);",
    "authored_by is you when it was your idea. No inline # comments in frontmatter.",
    "",
    "Two things to hold onto when you do. A routine is a *standing* commitment — it costs its run",
    "every time, forever, whether or not anyone reads it — so give it a real reason and delete it when",
    "the reason stops being true. And you are spending inside an allowance, not out of nobody's",
    "pocket: if a routine of yours is what is exhausting it, that is the one to stop.",
  ].join("\n");
}

/** The frontmatter-and-body file for a new skill, so everything writes them the same way. */
export function composeSkillFile(input: {
  name: string;
  description: string;
  body: string;
  scope?: SkillScope;
  owner?: string;
}): string {
  const meta = [
    `name: ${input.name}`,
    `description: ${input.description}`,
    `scope: ${input.scope ?? "global"}`,
    ...(input.scope === "agent" && input.owner !== undefined ? [`owner: ${input.owner}`] : []),
  ];
  return ["---", ...meta, "---", "", input.body.trim(), ""].join("\n");
}

// ── loading them from the box ─────────────────────────────────────────────────────────

/** Just enough of the box client to read a directory of skills. */
export interface SkillSource {
  listDir(path: string): Promise<{ entries: { name: string; type: string }[] }>;
  readFile(path: string): Promise<{ content?: string; text?: string }>;
}

export interface SkillsLoad {
  skills: Skill[];
  /** Directories that look like skills but are not usable, and why. Surfaced, never swallowed. */
  problems: string[];
  /**
   * Whether the directory was actually read.
   *
   * The distinction this names: "there is no skills directory" and "the box did not answer" both
   * produce an empty list, and they mean opposite things. Without it a cache replaces a good result
   * with an empty one every time the box restarts, and an agent is told its skills were deleted.
   *
   * A field rather than an exception because a caller that only wants a list should not have to
   * catch, and because the two outcomes are both ordinary rather than one being exceptional.
   */
  read: boolean;
}

/**
 * Reads every skill in the box.
 *
 * Costs one directory listing plus one read per skill, on every turn that rebuilds a prompt — which
 * is why `SkillCache` exists in front of it. Never throws: a box that is starting, a directory that
 * does not exist, or an unreadable file all mean "no skills", because a turn must not fail over
 * whether an optional directory could be listed.
 */
export async function loadSkills(source: SkillSource): Promise<SkillsLoad> {
  let entries: { name: string; type: string }[];
  try {
    entries = (await source.listDir(SKILLS_DIR)).entries;
  } catch {
    // Either the directory does not exist — the normal state of a fresh box — or the box is not
    // answering. Indistinguishable from here, so it is reported as "not read" and the caller decides.
    return { skills: [], problems: [], read: false };
  }

  const skills: Skill[] = [];
  const problems: string[] = [];
  for (const entry of entries) {
    if (entry.type !== "directory") continue;
    let text: string;
    let helpers: string[] = [];
    try {
      const read = await source.readFile(`${SKILLS_DIR}/${entry.name}/${SKILL_FILENAME}`);
      text = read.content ?? read.text ?? "";
      const inside = await source.listDir(`${SKILLS_DIR}/${entry.name}`);
      helpers = inside.entries
        .filter(file => file.type === "file" && file.name !== SKILL_FILENAME)
        .map(file => file.name);
    } catch {
      // A directory under skills/ with no readable SKILL.md is a directory, not a broken skill.
      continue;
    }
    const result = skillFrom(entry.name, parseSkillFile(text), helpers);
    if ("skill" in result) skills.push(result.skill);
    else problems.push(result.problem);
  }
  return { skills, problems, read: true };
}

/**
 * Skills, re-read at most every few seconds.
 *
 * A prompt is built once per turn, so without this a four-agent box makes four listings and a read
 * per skill every time anyone says anything — over a local socket that is survivable and still
 * pointless. Short rather than long, because a person who has just edited a skill in the files view
 * should see it apply on their next message, not in a minute.
 */
export class SkillCache {
  private loaded: SkillsLoad = { skills: [], problems: [], read: false };
  /**
   * When the last read finished, or undefined if there has not been one.
   *
   * Undefined rather than zero, because "never read" and "read at time zero" are different states
   * and conflating them means the first call can be mistaken for a fresh cache. With a wall clock
   * that never happens — the difference from zero is decades — so it works by accident and fails the
   * moment the clock is injected, which is exactly what the test that found this does.
   */
  private attemptAt: number | undefined;
  private inFlight: Promise<void> | undefined;

  constructor(
    private readonly source: () => SkillSource | undefined,
    private readonly ttlMs = envNumber("AGENTBOX_SKILL_TTL_MS", 5_000),
    private readonly now: () => number = Date.now
  ) {}

  /** What was last read. Synchronous, because prompt assembly is. */
  current(): SkillsLoad {
    return this.loaded;
  }

  /**
   * Re-reads if the cache is stale. Awaited by the caller before assembling a prompt.
   *
   * Concurrent calls share one read: four agents waking at once should not produce four listings of
   * the same directory.
   */
  async refresh(): Promise<SkillsLoad> {
    // A read already running is joined before anything else is decided. This order is
    // the fix for a race the TTL-on-attempt change introduced on 2026-09-01: arming the
    // gate at the *start* of a read made a concurrent first caller pass the TTL check
    // and return the empty pre-read cache instead of waiting — two callers, two
    // different answers, from one refresh.
    if (this.inFlight !== undefined) {
      await this.inFlight;
      return this.loaded;
    }
    // Gated on the last *attempt*, not the last success: a box that is down (or a fresh
    // box with no skills directory yet) used to fail the read, leave the gate unarmed,
    // and every turn and scheduler tick re-issued the listing — negative results need
    // the same TTL as positive ones, or the cache only works when nothing is wrong.
    if (this.attemptAt !== undefined && this.now() - this.attemptAt < this.ttlMs) {
      return this.loaded;
    }
    const source = this.source();
    if (source === undefined) return this.loaded;

    this.inFlight = (async () => {
      try {
        const loaded = await loadSkills(source);
        // Only replaced when the directory was actually read. A box that is restarting must not make
        // an agent believe its skills were deleted — and since the list is in the prompt, an empty
        // one reads as "you have none" rather than "we could not check".
        if (loaded.read) {
          this.loaded = loaded;
        }
      } catch {
        // Same reasoning for anything loadSkills did not catch itself.
      } finally {
        // Armed when the read *finishes*, however it finished. At the start it would
        // gate the callers who arrive during it; never, and a failing box is re-listed
        // on every turn.
        this.attemptAt = this.now();
        this.inFlight = undefined;
      }
    })();
    await this.inFlight;
    return this.loaded;
  }
}
