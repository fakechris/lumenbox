/** Judges: one yes-or-no question per failure type, held to a quote that is really in the output (INV-1772). */

import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { resolveProvider } from "../host/provider.ts";
import type { CacheStore, ModelCall } from "./cache.ts";
import { loadCorpus, taskVersion } from "./corpus.ts";
import { JUDGE_PROMPT_VERSION, JUDGE_QUESTIONS, judgeCallBudget, judgeRun, outputDigestOf, parseJudgeAnswer } from "./judges.ts";
import type { EvalRun } from "./runner.ts";
import { summarise } from "./summary.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));
const corpus = loadCorpus(join(root, "evals/corpus"));
const everything = [...corpus.dev, ...corpus.test];
const profile = { ...resolveProvider("anthropic"), label: "judge-wire", model: "judge-model" };
const reply = (body: string): Anthropic.Message =>
  ({ id: "m", type: "message", role: "assistant", model: "x", content: [{ type: "text", text: body }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 900, output_tokens: 30 } }) as unknown as Anthropic.Message;

/** A record as the runner would have left it for these tasks: `outputs[i]` is attempt i+1's answer; undefined is a harness failure. */
function record(entries: { id: string; outputs: (string | undefined)[] }[]): EvalRun {
  return {
    format: "lumenbox-eval/1", at: "2026-11-19T10:00:00.000Z", commit: "abc1234", dirty: false, split: "test", corpus: { version: "v", tasks: entries.length }, k: 1, fake: false,
    models: { summary: { provider: "p", model: "m" } }, calls: { made: 0, cached: 0 },
    tasks: entries.map(({ id, outputs }) => {
      const task = everything.find(one => one.id === id)!;
      return {
        id, version: taskVersionOf(id), subject: task.subject, source: task.source, failureType: task.failureType,
        attempts: outputs.map((output, index) => ({
          attempt: index + 1, pass: output !== undefined, ...(output === undefined ? { infra: "the model never answered" } : {}), graders: [], labels: [], state: {}, output: output ?? "", model: "m",
          use: { calls: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        })),
      };
    }),
  };
}
const taskVersionOf = (id: string) => taskVersion(everything.find(one => one.id === id)!);
const steward = everything.find(task => task.failureType === "needless-fresh-context")!;
const skill = everything.find(task => task.failureType === "skill-not-opened")!;
const teach = everything.find(task => task.failureType === "unusable-skill-draft")!;

test("a verdict stands only on a quote that is in the output: a made-up, missing or one-word quote is invalid, not a no", () => {
  const output = "1. The person asked for a weekly report in three parts.\n2. The agent says it is done, so   the work is complete.";
  assert.deepEqual(parseJudgeAnswer('{"present": true, "quote": "The agent says it is done, so the work is complete."}', output), { verdict: "present", quote: "The agent says it is done, so the work is complete." }, "spacing may differ, the words may not");
  assert.deepEqual(parseJudgeAnswer('Here you go:\n```json\n{"present": false, "quote": "asked for a weekly report"}\n```', output).verdict, "absent");
  assert.deepEqual(parseJudgeAnswer('{"present": true, "quote": "the agent admitted it skipped part two"}', output), { verdict: "invalid", why: "the quote is not in the output" });
  assert.match((parseJudgeAnswer('{"present": true, "quote": "done"}', output) as { why: string }).why, /too short/);
  assert.match((parseJudgeAnswer('{"present": true}', output) as { why: string }).why, /no quote/);
  assert.match((parseJudgeAnswer('{"present": "yes", "quote": "asked for a weekly report"}', output) as { why: string }).why, /not true or false/);
  assert.match((parseJudgeAnswer("Yes, the failure is present.", output) as { why: string }).why, /no JSON/);
});

test("each attempt with a question is asked once, with what the system was given and what it answered; the judge's model and question version are on the record", async () => {
  const prompts: string[] = [];
  const model: ModelCall = async params => {
    const prompt = String((params.messages[0] as { content: unknown }).content);
    prompts.push(prompt);
    return reply(JSON.stringify({ present: prompt.includes("second answer"), quote: prompt.includes("second answer") ? "second answer, which claims it is done" : "first answer, with the list written out" }));
  };
  const run = record([
    { id: steward.id, outputs: ["first answer, with the list written out", "second answer, which claims it is done", undefined, "  "] },
    { id: skill.id, outputs: ["an answer about a skill"] },
  ]);
  const section = await judgeRun(run, everything, { model, profile });
  assert.deepEqual(section.model, { provider: "judge-wire", model: "judge-model" });
  assert.equal(section.promptVersion, JUDGE_PROMPT_VERSION);
  assert.deepEqual(section.verdicts.map(v => [v.task, v.attempt, v.question, v.verdict]), [[steward.id, 1, "needless-fresh-context", "absent"], [steward.id, 2, "needless-fresh-context", "present"]]);
  assert.equal(section.verdicts[1]!.outputDigest, outputDigestOf("second answer, which claims it is done"));
  assert.equal(section.skipped, 2, "a harness failure and an empty answer have nothing to read: not asked, not a verdict");
  assert.equal(prompts.length, 2, "whether a skill was opened is a fact on the transcript: no judge is asked");
  assert.ok(prompts[0]!.includes(JUDGE_QUESTIONS.find(one => one.failureType === "needless-fresh-context")!.question));
  assert.ok(prompts[0]!.includes(String(steward.input.view)), "the judge reads what the steward read");
  assert.deepEqual(section.use, { calls: 2, inputTokens: 1800, outputTokens: 60, cacheReadTokens: 0, cacheWriteTokens: 0 });

  run.judges = section;
  assert.deepEqual(run.tasks[0]!.attempts.map(attempt => attempt.pass), [true, true, false, true], "a verdict never changes whether an attempt passed");
  assert.deepEqual(summarise(run).judges!.rows, [{ question: "needless-fresh-context", asked: 2, present: 1, invalid: 0 }]);
});

test("a judge that cannot be asked, or answers without evidence, leaves an invalid verdict; a second pass is answered from the cache; an edited task is not judged", async () => {
  const entries = new Map<string, Anthropic.Message>();
  const cache: CacheStore = { get: key => entries.get(key), set: (key, message) => void entries.set(key, message) };
  let asked = 0;
  const model: ModelCall = async () => {
    asked += 1;
    if (asked === 2) throw new Error("529 overloaded");
    return reply('{"present": true, "quote": "words the output never contained"}');
  };
  const run = record([{ id: steward.id, outputs: ["the steward's first written check", "the steward's second written check"] }]);
  const first = await judgeRun(run, everything, { model, profile, cache });
  assert.deepEqual(first.verdicts.map(v => v.verdict), ["invalid", "invalid"]);
  assert.match(first.verdicts[0]!.why!, /quote is not in the output/);
  assert.match(first.verdicts[1]!.why!, /could not be asked: 529/);
  assert.deepEqual(first.calls, { made: 1, cached: 0 });

  const again = await judgeRun(run, everything, { model: async () => reply('{"present": false, "quote": "the steward\'s second written check"}'), profile, cache });
  assert.deepEqual(again.calls, { made: 1, cached: 1 }, "the call already paid for is not made again; the one that failed is");
  assert.deepEqual(again.verdicts.map(v => v.verdict), ["invalid", "absent"]);

  const edited = everything.map(task => (task.id === steward.id ? { ...task, input: { ...task.input, view: "them: something else entirely" } } : task));
  assert.deepEqual((await judgeRun(run, edited, { model, profile })).verdicts, [], "today's task is not what that output answered");
});

test("the judge of a teach draft reads the cue the model read, never the hidden rubric; the call budget is one per judged attempt", async () => {
  let prompt = "";
  const model: ModelCall = async params => {
    prompt = String((params.messages[0] as { content: unknown }).content);
    return reply('{"present": false, "quote": "Open the issues page"}');
  };
  await judgeRun(record([{ id: teach.id, outputs: ["1. Open the issues page and search."] }]), everything, { model, profile });
  for (const hidden of ((teach.gold.scorer!.expect as { rubric?: string[] }).rubric ?? [])) assert.ok(!prompt.includes(hidden), `the judge was shown the rubric phrase ${hidden}`);
  assert.ok(!prompt.includes(teach.gold.answer!), "nor the reference answer");
  assert.equal(judgeCallBudget([steward, skill, teach], 3), 6);
});
