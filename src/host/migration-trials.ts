/**
 * The teaching-and-template migration trials (INV-481): does what was taught hold on
 * inputs it was not taught on, and in an environment that is not the author's?
 *
 * Five workflows, frozen, each with three new inputs never used to demonstrate it. Every
 * input runs twice on the scripted model — with the skill (or site learning) in place, and
 * without — and the trial records what a person would compare: whether the skill was
 * offered at all, whether the learning was recalled on a new page of the same site, how
 * many calls it took, how many questions, whether anything needing a capability the
 * receiver lacks was refused rather than done, and whether the artifact came out with
 * the input's own parameters.
 *
 * The scripted model takes the short path when the skill is in its prompt and the long
 * path when it is not, so the call delta here is *by construction*: it proves the
 * machinery — skills reach the prompt, learnings reach the open, parameters reach the
 * artifact, refusals hold — not a model's judgement. Failures are classified the way the
 * contract asks (extraction, parameterisation, capability-binding, environment, execution,
 * verification) so a reader knows which stage broke. The real-model comparison and the
 * two non-author installs are reported UNVERIFIED, never inferred.
 */

import type { EpisodeResult, Script } from "./scenario.ts";
import type { Skill } from "./skills.ts";

export type FailureClass = "extraction" | "parameterisation" | "capability-binding" | "environment" | "execution" | "verification";

export interface TrialInput {
  id: string;
  /** What the person asks, with this input's own parameters. */
  ask: string;
  /** The parameter that must show up in the artifact or the answer. */
  param: string;
  files?: Record<string, string>;
  /** For a browser workflow: the page the input opens. */
  url?: string;
}

export interface Workflow {
  id: string;
  /** The taught thing: a skill the prompt lists, a site learning the open recalls, or both. */
  skill?: Skill;
  learning?: { host: string; line: string };
  inputs: [TrialInput, TrialInput, TrialInput];
  /** The scripted model: short path when `taught`, long path otherwise. */
  script: (input: TrialInput, taught: boolean) => Script;
  /** Where the artifact lands for an input, if the workflow writes one. */
  artifact?: (input: TrialInput) => string;
  /** Checks with the stage that fails when they do. */
  checks: Record<string, { stage: FailureClass; ok: (result: EpisodeResult, input: TrialInput, taught: boolean) => boolean }>;
  /** A workflow that reaches for a capability the receiver does not have. */
  needsCapability?: string;
}

const WORK = "/home/box/work";

const skillOf = (slug: string, name: string, description: string): Skill => ({ slug, name, description, scope: "global", path: `${WORK}/skills/${slug}/SKILL.md`, helpers: [] });

const rounds = (replies: ((ctx: Parameters<Script>[0]) => ReturnType<Script>)[]): Script => ctx => replies[ctx.round]?.(ctx);

const fileHas = (result: EpisodeResult, path: string, needle: string): boolean => (result.files.get(path) ?? "").includes(needle);
const said = (result: EpisodeResult, needle: string): boolean => result.score.said.some(s => s.text.includes(needle));
const offered = (result: EpisodeResult, name: string): boolean =>
  result.observations.length > 0 && (result as EpisodeResult & { systems?: string[] }).systems?.some(system => system.includes(name)) === true;
/** Whether an open's result carried the site's learnings, read off the transcript. */
const learningRecalled = (result: EpisodeResult, host: string): boolean => {
  for (const record of result.registry.list()) {
    for (const entry of result.registry.readTranscript(record.id) as { kind?: string; blocks?: { content?: unknown }[] }[]) {
      if (entry.kind !== "results") continue;
      for (const block of entry.blocks ?? []) {
        const text = Array.isArray(block.content) ? (block.content as { text?: string }[]).map(part => part.text ?? "").join(" ") : String(block.content ?? "");
        if (text.includes(`learned on ${host}`)) return true;
      }
    }
  }
  return false;
};

export const WORKFLOWS: readonly Workflow[] = [
  {
    id: "summarise-materials",
    skill: skillOf("q-summary", "Quarter summary", "Summarise the files under materials/<quarter> into out/<quarter>-summary.md, one bullet per file, each bullet naming its file."),
    inputs: [
      { id: "q1", ask: "Summarise materials/q1 into a summary.", param: "q1", files: { [`${WORK}/materials/q1/sales.md`]: "Q1 revenue 0.9M" } },
      { id: "q2", ask: "Summarise materials/q2 into a summary.", param: "q2", files: { [`${WORK}/materials/q2/sales.md`]: "Q2 revenue 1.1M" } },
      { id: "q4", ask: "Summarise materials/q4 into a summary.", param: "q4", files: { [`${WORK}/materials/q4/sales.md`]: "Q4 revenue 1.4M" } },
    ],
    artifact: input => `${WORK}/out/${input.param}-summary.md`,
    script: (input, taught) =>
      taught
        ? rounds([
            () => ({ call: "read_file", input: { path: `${WORK}/materials/${input.param}/sales.md` } }),
            () => ({ call: "write_file", input: { path: `${WORK}/out/${input.param}-summary.md`, content: `# ${input.param} summary\n- sales.md: revenue (materials/${input.param}/sales.md)\n` } }),
            () => ({ say: `Written to out/${input.param}-summary.md.` }),
          ])
        : rounds([
            () => ({ call: "list_dir", input: { path: `${WORK}/materials` } }),
            () => ({ call: "list_dir", input: { path: `${WORK}/materials/${input.param}` } }),
            () => ({ call: "read_file", input: { path: `${WORK}/materials/${input.param}/sales.md` } }),
            () => ({ call: "write_file", input: { path: `${WORK}/out/${input.param}-summary.md`, content: `# ${input.param} summary\n- revenue\n` } }),
            () => ({ say: `Written to out/${input.param}-summary.md.` }),
          ]),
    checks: {
      "the skill is in the prompt when taught": { stage: "extraction", ok: (r, _i, taught) => !taught || offered(r, "Quarter summary") },
      "the artifact carries this input's parameter": { stage: "parameterisation", ok: (r, i) => r.files.has(`${WORK}/out/${i.param}-summary.md`) },
      "taught, every bullet names its file": { stage: "execution", ok: (r, i, taught) => !taught || fileHas(r, `${WORK}/out/${i.param}-summary.md`, `materials/${i.param}/sales.md`) },
      "the answer names the artifact": { stage: "verification", ok: (r, i) => said(r, `${i.param}-summary.md`) },
    },
  },
  {
    id: "vendor-pricing",
    learning: { host: "vendor.test", line: "the price table sits under the Team plan heading; the top banner is an ad" },
    inputs: [
      { id: "eu", ask: "Collect the EU pricing page.", param: "eu", url: "https://vendor.test/eu/pricing" },
      { id: "enterprise", ask: "Collect the enterprise pricing page.", param: "enterprise", url: "https://vendor.test/enterprise" },
      { id: "startup", ask: "Collect the startup pricing page.", param: "startup", url: "https://vendor.test/startup-plan" },
    ],
    artifact: input => `${WORK}/out/pricing-${input.param}.md`,
    script: input =>
      rounds([
        () => ({ call: "browser_open", input: { url: input.url } }),
        () => ({ call: "write_file", input: { path: `${WORK}/out/pricing-${input.param}.md`, content: `Source: ${input.url}\n- Team plan price\n` } }),
        () => ({ say: `Collected ${input.param} pricing.` }),
      ]),
    checks: {
      "the site learning is recalled on a page it was not written on": { stage: "environment", ok: (r, _i, taught) => !taught || learningRecalled(r, "vendor.test") },
      "untaught, nothing is recalled (the control is a control)": { stage: "environment", ok: (r, _i, taught) => taught || !learningRecalled(r, "vendor.test") },
      "the note cites this input's URL": { stage: "parameterisation", ok: (r, i) => fileHas(r, `${WORK}/out/pricing-${i.param}.md`, i.url!) },
    },
  },
  {
    id: "digest-check",
    skill: skillOf("digest-check", "Digest check", "To check a night's digest: read out/digest-<date>.md and answer with the date and the counts; never rewrite it."),
    inputs: [
      { id: "d1", ask: "Check the digest for 2026-09-10.", param: "2026-09-10", files: { [`${WORK}/out/digest-2026-09-10.md`]: "3 closed" } },
      { id: "d2", ask: "Check the digest for 2026-09-11.", param: "2026-09-11", files: { [`${WORK}/out/digest-2026-09-11.md`]: "5 closed" } },
      { id: "d3", ask: "Check the digest for 2026-09-12.", param: "2026-09-12", files: { [`${WORK}/out/digest-2026-09-12.md`]: "1 closed" } },
    ],
    script: (input, taught) =>
      taught
        ? rounds([() => ({ call: "read_file", input: { path: `${WORK}/out/digest-${input.param}.md` } }), () => ({ say: `Digest ${input.param}: ran.` })])
        : rounds([() => ({ call: "list_dir", input: { path: `${WORK}/out` } }), () => ({ call: "read_file", input: { path: `${WORK}/out/digest-${input.param}.md` } }), () => ({ say: `Digest ${input.param}: ran.` })]),
    checks: {
      "the skill is in the prompt when taught": { stage: "extraction", ok: (r, _i, taught) => !taught || offered(r, "Digest check") },
      "the answer names this input's date": { stage: "verification", ok: (r, i) => said(r, i.param) },
      "nothing was rewritten": { stage: "execution", ok: r => !r.score.trail.some(step => step.endsWith(":write_file")) },
    },
  },
  {
    id: "changelog",
    skill: skillOf("changelog", "Changelog", "Turn notes/<release>.md into out/CHANGELOG-<release>.md with a heading per section."),
    inputs: [
      { id: "v1", ask: "Write the changelog for release 1.4.", param: "1.4", files: { [`${WORK}/notes/1.4.md`]: "fixed a, added b" } },
      { id: "v2", ask: "Write the changelog for release 1.5.", param: "1.5", files: { [`${WORK}/notes/1.5.md`]: "fixed c" } },
      { id: "v3", ask: "Write the changelog for release 2.0.", param: "2.0", files: { [`${WORK}/notes/2.0.md`]: "rewrote d" } },
    ],
    artifact: input => `${WORK}/out/CHANGELOG-${input.param}.md`,
    script: (input, taught) =>
      taught
        ? rounds([
            () => ({ call: "read_file", input: { path: `${WORK}/notes/${input.param}.md` } }),
            () => ({ call: "write_file", input: { path: `${WORK}/out/CHANGELOG-${input.param}.md`, content: `# ${input.param}\n## Fixed\n## Added\n` } }),
            () => ({ say: `CHANGELOG-${input.param}.md written.` }),
          ])
        : rounds([
            () => ({ call: "list_dir", input: { path: `${WORK}/notes` } }),
            () => ({ call: "read_file", input: { path: `${WORK}/notes/${input.param}.md` } }),
            () => ({ call: "AskUser", input: { question: "Which sections do you want in the changelog?" } }),
            () => ({ call: "write_file", input: { path: `${WORK}/out/CHANGELOG-${input.param}.md`, content: `# ${input.param}\n` } }),
            () => ({ say: `CHANGELOG-${input.param}.md written.` }),
          ]),
    checks: {
      "the skill is in the prompt when taught": { stage: "extraction", ok: (r, _i, taught) => !taught || offered(r, "Changelog") },
      "taught, no question was needed": { stage: "extraction", ok: (r, _i, taught) => !taught || r.score.questions === 0 },
      "the artifact is this release's": { stage: "parameterisation", ok: (r, i) => r.files.has(`${WORK}/out/CHANGELOG-${i.param}.md`) },
    },
  },
  {
    id: "deploy",
    skill: skillOf("deploy", "Deploy", "To deploy <service>: run the release script on the operator's machine with RunOnHost, then confirm in out/deploys.md."),
    needsCapability: "RunOnHost (a host runner)",
    inputs: [
      { id: "api", ask: "Deploy the api service.", param: "api" },
      { id: "web", ask: "Deploy the web service.", param: "web" },
      { id: "worker", ask: "Deploy the worker service.", param: "worker" },
    ],
    script: input =>
      rounds([
        () => ({ call: "RunOnHost", input: { command: `./release.sh ${input.param}` } }),
        () => ({ say: `I cannot deploy ${input.param} from here: running on your machine was refused (no host runner). Nothing was changed.` }),
      ]),
    checks: {
      "the host command is refused, not run": { stage: "capability-binding", ok: r => r.score.refusals.some(line => /Host execution is not available|Unknown tool: RunOnHost/.test(line)) },
      "no side effect happened": { stage: "capability-binding", ok: r => !r.score.trail.some(step => /write_file|bash/.test(step)) && r.files.size === 0 },
      "the person is told what was refused and why": { stage: "verification", ok: (r, i) => said(r, `deploy ${i.param}`) && said(r, "refused") },
    },
  },
];

export interface TrialOutcome {
  workflow: string;
  input: string;
  taught: boolean;
  calls: number;
  questions: number;
  refusals: number;
  artifact?: { path: string; present: boolean };
  failures: { check: string; stage: FailureClass }[];
}

export function judgeTrial(workflow: Workflow, input: TrialInput, taught: boolean, result: EpisodeResult): TrialOutcome {
  const failures: TrialOutcome["failures"] = [];
  for (const [check, { stage, ok }] of Object.entries(workflow.checks)) {
    let passed = false;
    try {
      passed = ok(result, input, taught);
    } catch {
      passed = false;
    }
    if (!passed) failures.push({ check, stage });
  }
  const path = workflow.artifact?.(input);
  return {
    workflow: workflow.id,
    input: input.id,
    taught,
    calls: result.score.trail.filter(step => !step.includes(":AskUser:")).length,
    questions: result.score.questions,
    refusals: result.score.refusals.length,
    ...(path !== undefined ? { artifact: { path, present: result.files.has(path) } } : {}),
    failures,
  };
}

/** The report a reader keeps: the 5×3 matrix, taught vs untaught, failures by stage, and what is unverified. */
export function trialReport(outcomes: readonly TrialOutcome[], context: { commit: string; config: string }): string[] {
  const lines = [`Migration trials (INV-481): ${outcomes.filter(o => o.failures.length === 0).length}/${outcomes.length} cells passed — commit ${context.commit}, ${context.config}`];
  for (const workflow of WORKFLOWS) {
    for (const input of workflow.inputs) {
      const cell = (taught: boolean) => outcomes.find(o => o.workflow === workflow.id && o.input === input.id && o.taught === taught);
      const on = cell(true);
      const off = cell(false);
      const fmt = (o: TrialOutcome | undefined) => (o === undefined ? "—" : `${o.calls} call(s), ${o.questions} q, ${o.refusals} refused${o.failures.length > 0 ? `, FAILED ${o.failures.map(f => `${f.stage}: ${f.check}`).join("; ")}` : ""}`);
      lines.push(`  ${workflow.id.padEnd(20)} ${input.id.padEnd(10)} taught: ${fmt(on)}  |  untaught: ${fmt(off)}`);
    }
  }
  const byStage = new Map<FailureClass, number>();
  for (const outcome of outcomes) for (const failure of outcome.failures) byStage.set(failure.stage, (byStage.get(failure.stage) ?? 0) + 1);
  lines.push(`  failures by stage: ${byStage.size === 0 ? "none" : [...byStage].map(([stage, n]) => `${stage} ${n}`).join(", ")}`);
  lines.push("  the call delta between taught and untaught is by construction of the scripted model: it proves the machinery, not a model's judgement.");
  lines.push("  UNVERIFIED: the same matrix on a real model (opt-in, authorised credentials); two non-author installs binding their own bundles (no participants).");
  return lines;
}
