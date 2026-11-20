/**
 * Subjects (INV-1772): the four ways a corpus task is put to the system under test.
 *
 * A subject turns a task into the request the product itself would make — the real prompt, the
 * real parser — and reads back an observation the graders can score. None of them holds a model:
 * each is handed one, which is the provider's, the cache in front of it, or a deterministic
 * stand-in, and cannot tell which.
 *
 *   - `episode` — a whole turn on the real stack over an in-memory box (scenario.ts), cut after a
 *     few calls: which skill was opened, what was said, how the run ended. No Docker.
 *   - `auto-review` — the tool-call reviewer's prompt and verdict (auto-review.ts).
 *   - `steward` — the context steward's decision over a conversation's ending (context-steward.ts).
 *   - `teach` — the teaching turn's cue for a recorded demonstration (teach-evals.ts).
 *
 * `fake` is the same subject's deterministic reply: the gold answer, or its opposite. It exists
 * so the runner, graders, cache and report can be run end to end without a provider; a number it
 * produces is not a measurement of anything and is labelled so wherever it is printed.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { buildReviewPrompt, parseVerdict, type ReviewInput } from "../host/auto-review.ts";
import { parseStewardDecision, STEWARD_SYSTEM } from "../host/context-steward.ts";
import type { ProviderProfile } from "../host/provider.ts";
import { runEpisode } from "../host/scenario.ts";
import { filesRead } from "../host/skill-evals.ts";
import { parseSkillFile, SKILLS_DIR, skillFrom } from "../host/skills.ts";
import { starterSkillsWithEvals } from "../host/starter-skills.ts";
import { TEACH_MAX_TOKENS } from "../host/teach.ts";
import { absenceProbe, teachingCueFor } from "../host/teach-evals.ts";
import { fakeModel } from "../host/testing/fake-model.ts";
import type { ModelCall } from "./cache.ts";
import type { EvalTask, SubjectName } from "./corpus.ts";
import { type Observation, teachFixtureOf } from "./graders.ts";

export interface SubjectContext {
  model: ModelCall;
  /** The model this subject runs on: the agent's own, or the cheap one the product uses for side calls. */
  profile: ProviderProfile;
}

export interface Subject {
  name: SubjectName;
  /** `primary` is the agent's model; `summary` the cheap profile the product's own side calls use. */
  tier: "primary" | "summary";
  /** The most model calls one attempt at this task can make. */
  maxCalls(task: EvalTask): number;
  run(task: EvalTask, context: SubjectContext): Promise<Observation>;
  /** A deterministic model for this task: the gold reply, or the wrong one. Never a measurement. */
  fake(task: EvalTask, wrong: boolean): ModelCall;
}

const textOf = (message: Anthropic.Message): string => message.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("");

function reply(content: Anthropic.ContentBlock[], stop: Anthropic.Message["stop_reason"] = "end_turn", tokens = { input: 0, output: 0 }): Anthropic.Message {
  return {
    id: "msg_eval", type: "message", role: "assistant", model: "fake", content, stop_reason: stop, stop_sequence: null,
    usage: { input_tokens: tokens.input, output_tokens: tokens.output },
  } as unknown as Anthropic.Message;
}
export const say = (text: string, tokens?: { input: number; output: number }): Anthropic.Message => reply([{ type: "text", text } as Anthropic.ContentBlock], "end_turn", tokens);
/** What a fake call reports having used, so the cost column has something to add up. */
const FAKE_TOKENS = { input: 1000, output: 100 };

/** One call, one parsed label: the shape the reviewer and the steward share. */
function classifier(options: {
  name: SubjectName;
  request: (task: EvalTask, profile: ProviderProfile) => Anthropic.MessageCreateParams;
  label: (text: string) => string | undefined;
  fakeText: (label: string) => string;
  opposite: (label: string) => string;
}): Subject {
  return {
    name: options.name,
    tier: "summary",
    maxCalls: () => 1,
    async run(task, context) {
      const text = textOf(await context.model(options.request(task, context.profile), "create"));
      return { output: text, labels: [options.label(text) ?? "NONE"], state: {} };
    },
    fake(task, wrong) {
      const gold = task.gold.labels?.all?.[0] ?? "";
      return async () => say(options.fakeText(wrong ? options.opposite(gold) : gold), FAKE_TOKENS);
    },
  };
}

const autoReview = classifier({
  name: "auto-review",
  request: (task, profile) => ({
    model: profile.model,
    max_tokens: Math.min(512, profile.maxTokens),
    messages: [{ role: "user", content: buildReviewPrompt(task.input as unknown as ReviewInput) }],
  }),
  label: text => parseVerdict(text)?.verdict,
  fakeText: label => JSON.stringify({ verdict: label, reason: "a deterministic stand-in, not a model" }),
  opposite: label => (label === "ALLOW" ? "BLOCK" : "ALLOW"),
});

const steward = classifier({
  name: "steward",
  request: (task, profile) => {
    const condensed = Number(task.input.condensed ?? 0);
    return {
      model: profile.model,
      max_tokens: Math.min(600, profile.maxTokens),
      system: STEWARD_SYSTEM,
      messages: [{ role: "user", content: `Condensed so far: ${condensed} time${condensed === 1 ? "" : "s"}.\n\nLatest messages, oldest first:\n${String(task.input.view ?? "")}` }],
    };
  },
  label: text => parseStewardDecision(text),
  fakeText: label => JSON.stringify({ action: label }),
  opposite: label => (label === "switch" ? "compact" : "switch"),
});

const teach: Subject = {
  name: "teach",
  tier: "primary",
  maxCalls: () => 1,
  async run(task, context): Promise<Observation> {
    const fixture = teachFixtureOf(task);
    // The cue must not carry the answer key: a pass that came from reading it would be no pass.
    const leaked = absenceProbe(fixture);
    if (leaked !== undefined) return { output: "", labels: [], state: {}, infra: leaked };
    const message = await context.model(
      { model: context.profile.model, max_tokens: Math.min(TEACH_MAX_TOKENS, context.profile.maxTokens), messages: [{ role: "user", content: teachingCueFor(fixture) }] },
      "create"
    );
    return { output: textOf(message), labels: [], state: {} };
  },
  fake(task, wrong) {
    return async () => say(wrong ? "I would rather describe the skill in prose than return the object." : (task.gold.answer ?? ""), FAKE_TOKENS);
  },
};

/** The starter skills as an episode is offered them: the index entries, and each SKILL.md at its box path. */
function starterSkillSet() {
  const starters = starterSkillsWithEvals();
  const skills = starters.map(starter => {
    const made = skillFrom(starter.slug, parseSkillFile(starter.content));
    if (!("skill" in made)) throw new Error(`${starter.slug}: ${made.problem}`);
    return made.skill;
  });
  const files = Object.fromEntries(starters.map(starter => [`${SKILLS_DIR}/${starter.slug}/SKILL.md`, starter.content]));
  return { skills, files };
}
let starterSet: ReturnType<typeof starterSkillSet> | undefined;
/** Built once: the same set for every episode, and for the prompt read off one (surface.ts). */
export const starterSkills = (): ReturnType<typeof starterSkillSet> => (starterSet ??= starterSkillSet());

const skillPath = (slug: string): string => `${SKILLS_DIR}/${slug}/SKILL.md`;
const DEFAULT_CAP = 4;
const OPENS_WITH = "read_file";
/** Whether a request names this file in its system prompt and carries the tool that reads it. */
function offers(params: Anthropic.MessageCreateParams, path: string): boolean {
  return (params.tools ?? []).some(tool => "name" in tool && tool.name === OPENS_WITH) && JSON.stringify(params.system ?? "").includes(path);
}
/** How a reply the harness wrote in the model's place begins: never read as the model's answer. */
const CUT = "(cut:";

const episode: Subject = {
  name: "episode",
  tier: "primary",
  maxCalls: task => Number(task.input.cap ?? DEFAULT_CAP),
  async run(task, context): Promise<Observation> {
    const starters = starterSkills();
    const cap = Number(task.input.cap ?? DEFAULT_CAP);
    let calls = 0;
    let answered = false;
    let failure: string | undefined;
    // The handed model behind the turn's own client surface, cut quietly after `cap` calls: the
    // choice a task measures is made early, and the rest of the work is not what is being bought.
    const client = fakeModel(async ({ params }) => {
      calls += 1;
      if (calls > cap || failure !== undefined) return say(`${CUT} the eval has what it measures)`);
      try {
        const message = await context.model(params, "stream");
        answered = true;
        return message;
      } catch (error) {
        // Said once and the episode wound down, rather than left to the turn's own retries.
        failure = error instanceof Error ? error.message : String(error);
        return say(`${CUT} the model call failed)`);
      }
    }, { streamText: true }); // the text event is what the episode records as said to the person
    let result: Awaited<ReturnType<typeof runEpisode>>;
    try {
      result = await runEpisode({
        team: [{ name: "Nova" }],
        says: [String(task.input.says ?? "")],
        skills: starters.skills,
        files: { ...starters.files, ...((task.input.files as Record<string, string> | undefined) ?? {}) },
        client,
        provider: context.profile,
      });
    } catch (error) {
      return { output: "", labels: [], state: {}, infra: `the episode did not run: ${error instanceof Error ? error.message : String(error)}` };
    }
    try {
      // Read off the transcripts, which is what the run durably left: with a real client the
      // episode's own scorecard is empty, since it is filled by the script that is not there.
      type Entry = { role?: string; kind?: string; text?: string; blocks?: { type?: string; name?: string }[] };
      const agents = result.registry.list();
      const transcript = result.registry.readTranscript(agents[0]!.id) as Entry[];
      const opened = [...new Set(filesRead(transcript).filter(file => file.startsWith(`${SKILLS_DIR}/`) && file.endsWith("/SKILL.md")).map(file => `skill:${file.split("/").at(-2)}`))];
      const said = transcript.filter(entry => entry.role === "assistant" && typeof entry.text === "string" && !entry.text.startsWith(CUT)).map(entry => entry.text).join("\n").trim();
      const used = agents.flatMap(agent => (result.registry.readTranscript(agent.id) as Entry[]).flatMap(entry => (entry.kind === "blocks" ? (entry.blocks ?? []) : [])).filter(block => block.type === "tool_use"));
      const questions = used.filter(block => block.name === "AskUser").length;
      const spoke = answered && transcript.some(entry => entry.role === "assistant");
      return {
        output: said,
        labels: opened,
        state: { answered: said !== "", questions, engaged: said !== "" || questions > 0, toolCalls: used.length, modelCalls: Math.min(calls, cap), agents: agents.length },
        // A run where the model never answered has tested nothing — least of all a "must not open" case.
        ...(failure !== undefined ? { infra: failure } : !spoke ? { infra: "the model never answered" } : {}),
      };
    } finally {
      result.cleanup();
    }
  },
  fake(task, wrong) {
    const mustOpen = task.gold.labels?.all?.find(label => label.startsWith("skill:"));
    const mustNot = task.gold.labels?.none?.find(label => label.startsWith("skill:"));
    const opens = wrong ? (mustOpen === undefined ? mustNot : undefined) : mustOpen;
    let call = 0;
    return async params => {
      call += 1;
      // It opens only a skill the request offers it, with the tool the request gives it: a prompt
      // that stopped listing the skill, or a tool list without `read_file`, costs the stand-in the
      // task as it would cost a model. That is what lets two versions of the prompt differ here.
      const offered = opens !== undefined && offers(params, skillPath(opens.slice("skill:".length)));
      if (call === 1 && offered) {
        return reply([{ type: "tool_use", id: "toolu_eval_1", name: OPENS_WITH, input: { path: skillPath(opens!.slice("skill:".length)) } } as Anthropic.ContentBlock], "tool_use", FAKE_TOKENS);
      }
      // A task graded on its end state and not on a skill has no wrong skill to open: silence is its wrong answer.
      return say(wrong && mustOpen === undefined && mustNot === undefined ? "" : "A deterministic stand-in answered; no model was asked.", FAKE_TOKENS);
    };
  },
};

export const SUBJECT_TABLE: Readonly<Record<SubjectName, Subject>> = { episode, "auto-review": autoReview, steward, teach };
