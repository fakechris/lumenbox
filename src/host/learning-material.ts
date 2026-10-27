/**
 * Learning material (INV-1377): what an evaluation run leaves for a teaching turn to learn from.
 *
 * Our evaluations end in a scorecard a person reads. This is the layer between that and a change:
 * a fixed directory — `tasks/<id>.json` per task, `index.jsonl` over them — holding what was asked,
 * what came back, which tools ran, whether it passed and the feedback that says why. A teaching
 * turn reads only this and the skill as it stands, and proposes a revised SKILL.md as a draft with
 * the failing tasks it rests on; a person publishes it or not. Nothing here retrains in a loop and
 * nothing publishes.
 *
 * What is never in the material: a fixture's expected answer or hidden rubric (the feedback says
 * what went wrong, not what the grader wanted verbatim), and any credential shape (redacted on
 * write, as the teaching trace is).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redactCredentials } from "./teach.ts";

export type MaterialSource = "skill-eval" | "teach-eval" | "scenario" | "preset-matrix";

export interface MaterialTask {
  id: string;
  source: MaterialSource;
  /** What the task asked: the person's line, the brief. */
  input: string;
  /** What came back, cut to a readable length. */
  output?: string;
  /** The tools that ran, in order, names and a short argument. */
  tools?: string[];
  passed: boolean;
  /** Why it passed or failed, in words a teaching turn can act on. */
  feedback: string;
  /** The skill under test, when the task is about one. */
  skill?: { slug: string; version?: number };
}

const ID = /^[A-Za-z0-9._-]{1,120}$/;
const SOURCES = new Set<MaterialSource>(["skill-eval", "teach-eval", "scenario", "preset-matrix"]);

/** Why a task is not valid material, or undefined. The schema, in code. */
export function materialProblem(task: unknown): string | undefined {
  const t = task as Partial<MaterialTask>;
  if (t === null || typeof t !== "object") return "not an object";
  if (typeof t.id !== "string" || !ID.test(t.id)) return "id must be letters, digits, . _ -";
  if (!SOURCES.has(t.source as MaterialSource)) return `source must be one of ${[...SOURCES].join(", ")}`;
  if (typeof t.input !== "string" || t.input === "") return "input is required";
  if (t.output !== undefined && typeof t.output !== "string") return "output must be text";
  if (t.tools !== undefined && (!Array.isArray(t.tools) || t.tools.some(tool => typeof tool !== "string"))) return "tools must be a list of text";
  if (typeof t.passed !== "boolean") return "passed must be true or false";
  if (typeof t.feedback !== "string" || t.feedback === "") return "feedback is required";
  if (t.skill !== undefined && (typeof t.skill?.slug !== "string" || !ID.test(t.skill.slug))) return "skill.slug must be a skill directory name";
  return undefined;
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)} …` : text);

/** Writes the tasks: credentials redacted, long text cut, every task checked against the schema. */
export function writeMaterial(dir: string, tasks: readonly MaterialTask[]): void {
  mkdirSync(join(dir, "tasks"), { recursive: true });
  const index: string[] = [];
  for (const raw of tasks) {
    const task: MaterialTask = {
      ...raw,
      input: redactCredentials(clip(raw.input, 4_000)),
      ...(raw.output !== undefined ? { output: redactCredentials(clip(raw.output, 4_000)) } : {}),
      ...(raw.tools !== undefined ? { tools: raw.tools.slice(0, 60).map(tool => redactCredentials(clip(tool, 200))) } : {}),
      feedback: redactCredentials(clip(raw.feedback, 2_000)),
    };
    const problem = materialProblem(task);
    if (problem !== undefined) throw new Error(`material task ${raw.id}: ${problem}`);
    writeFileSync(join(dir, "tasks", `${task.id}.json`), `${JSON.stringify(task, null, 2)}\n`);
    index.push(JSON.stringify({ id: task.id, source: task.source, passed: task.passed, ...(task.skill !== undefined ? { skill: task.skill.slug } : {}) }));
  }
  writeFileSync(join(dir, "index.jsonl"), `${index.join("\n")}\n`);
}

/** Reads and validates a material directory; a task that breaks the schema is an error, not skipped. */
export function readMaterial(dir: string): MaterialTask[] {
  const lines = readFileSync(join(dir, "index.jsonl"), "utf8").split("\n").filter(line => line.trim() !== "");
  return lines.map(line => {
    const { id } = JSON.parse(line) as { id: string };
    if (typeof id !== "string" || !ID.test(id)) throw new Error(`index.jsonl names an invalid task id`);
    const task = JSON.parse(readFileSync(join(dir, "tasks", `${id}.json`), "utf8")) as MaterialTask;
    const problem = materialProblem(task);
    if (problem !== undefined) throw new Error(`material task ${id}: ${problem}`);
    return task;
  });
}

/**
 * The cue for an improvement: the skill as it stands, the tasks about it that failed (and a few that
 * passed, so a fix does not break them), and the same output contract as a teaching turn.
 */
export function improvementCue(slug: string, skillText: string, tasks: readonly MaterialTask[]): { cue: string; basis: string[] } {
  const mine = tasks.filter(task => task.skill?.slug === slug);
  const failed = mine.filter(task => !task.passed).slice(0, 12);
  const passed = mine.filter(task => task.passed).slice(0, 6);
  const render = (task: MaterialTask) =>
    [`- ${task.id} (${task.passed ? "passed" : "FAILED"}): asked "${task.input}"`, task.tools?.length ? `  tools: ${task.tools.join(" → ")}` : "", task.output ? `  answered: ${task.output}` : "", `  feedback: ${task.feedback}`].filter(Boolean).join("\n");
  const cue = [
    `[improve skill] An evaluation ran the skill "${slug}". Propose a revised SKILL.md that fixes what failed without breaking what passed.`,
    "",
    "The skill as it stands:",
    "```",
    skillText.trim(),
    "```",
    "",
    "Tasks that failed:",
    ...failed.map(render),
    ...(passed.length > 0 ? ["", "Tasks that passed (keep them passing):", ...passed.map(render)] : []),
    "",
    "Do it in this order:",
    '1. Return only a JSON object {"skill": string|null, "question": string|null}. There are no tools in this call.',
    "2. Change as little as fixes the failures. A skill that was not opened when it should have been, or was opened when it should not, is usually fixed in the description: it is the trigger.",
    "3. Keep the frontmatter to name, description, scope: global, and allowed-tools if it had one; keep the name.",
    "4. If the failures do not say what to change, return skill: null and one short question.",
    "5. Never add a credential, a schedule, or a step that runs unasked.",
  ].join("\n");
  return { cue, basis: failed.map(task => task.id) };
}

/**
 * `agentbox skills improve <slug> --material <dir> [--from <SKILL.md>]`: the improvement turn on
 * the operator's provider, its answer stored as a teaching draft revising <slug> for a person to
 * review. The skill text comes from --from, or from the starter skill of that name.
 */
export async function cmdSkillsImprove(argv: string[], out: (line: string) => void = line => console.log(line)): Promise<number> {
  const value = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
  const slug = argv.find((arg, index) => !arg.startsWith("--") && !["--material", "--from", "--agent"].includes(argv[index - 1] ?? ""));
  const dir = value("--material");
  if (slug === undefined || dir === undefined) {
    out("Usage: agentbox skills improve <skill-dir> --material <dir> [--from <SKILL.md>] [--agent <name>]");
    return 1;
  }
  const from = value("--from");
  const { starterSkillsWithEvals } = await import("./starter-skills.ts");
  const skillText = from !== undefined ? readFileSync(from, "utf8") : starterSkillsWithEvals().find(starter => starter.slug === slug)?.content;
  if (skillText === undefined) {
    out(`No starter skill called ${slug}; pass --from <path to its SKILL.md>.`);
    return 1;
  }
  const tasks = readMaterial(dir);
  const { cue, basis } = improvementCue(slug, skillText, tasks);
  if (basis.length === 0) {
    out(`No failing task about ${slug} in ${dir}; nothing to improve.`);
    return 1;
  }
  const { join: joinPath, resolve } = await import("node:path");
  const { agentboxHome, loadConfig } = await import("../config.ts");
  const { createClient, resolveProvider } = await import("./provider.ts");
  const { AgentRegistry } = await import("../agents/registry.ts");
  const { TeachDrafts, SkillHistory, parseTeachingResponse } = await import("./teach-drafts.ts");
  const { TEACH_MAX_TOKENS } = await import("./teach.ts");
  const provider = resolveProvider(loadConfig().provider);
  const response = await createClient(provider).messages.create({ model: provider.model, max_tokens: Math.min(TEACH_MAX_TOKENS, provider.maxTokens), messages: [{ role: "user", content: cue }] });
  const text = response.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("\n");
  const parsed = parseTeachingResponse(text);
  const registry = new AgentRegistry();
  const agents = registry.agentsIn(registry.box.id);
  const wanted = value("--agent");
  const agent = wanted === undefined ? agents[0] : agents.find(record => record.profile.name.toLowerCase() === wanted.toLowerCase());
  if (agent === undefined) {
    out("No agent to credit the draft to.");
    return 1;
  }
  const home = agentboxHome();
  const drafts = new TeachDrafts(joinPath(home, "skills-drafts"), new SkillHistory(joinPath(home, "skill-history")));
  const material = resolve(dir);
  const draft = drafts.create({
    boxId: registry.box.id, agentId: agent.id, sessionId: `eval-${slug}-${Date.now().toString(36)}`, eventsPath: `material:${material}`,
    skill: parsed.skill, question: parsed.question, source: { kind: "eval", from: material, skillDir: slug, basis },
  });
  out(parsed.skill !== null
    ? `Draft ${draft.id.slice(0, 12)} revises ${slug}, resting on ${basis.join(", ")}. Review and publish it in the web UI; nothing was installed.`
    : `The turn asked instead of revising: ${parsed.question}`);
  return 0;
}
