/**
 * Tests for the graders, fed answers that look right and are not.
 *
 * A golden suite is only worth its runtime if a wrong answer fails it, and that is not
 * something you find out by watching it pass. Two of these graders have already been
 * wrong in production: one failed a correct answer, and one passed a model that ran no
 * command at all because it grepped the reply for a string that was in its own prompt.
 *
 * So each grader here is given prose that would fool a reader — confident, plausible,
 * using the right words — with the underlying record saying nothing happened. Every one
 * must fail. The pattern is taken from buzz and better-harness, both of which unit-test
 * their verifiers adversarially rather than trusting them.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { GOLDEN_TASKS, type GoldenContext } from "./golden.ts";

const taskNamed = (id: string) => {
  const task = GOLDEN_TASKS.find(entry => entry.id === id);
  assert.ok(task !== undefined, `no golden task called ${id}`);
  return task;
};

/** A context whose records say nothing happened, however good the reply sounds. */
const context = (over: Partial<GoldenContext>): GoldenContext =>
  ({
    reply: "",
    agentId: "a1",
    teammateId: "a2",
    registry: { readTranscript: () => [], readDurableState: () => ({}) },
    orchestrator: { tasks: { list: () => [] }, boxClient: () => undefined },
    // Answers whatever the grader hopes for, so a grader leaning on it is caught.
    judge: async () => true,
    ...over,
  }) as unknown as GoldenContext;

test("a confident account of work that never happened fails", async () => {
  const boast =
    "Done. I ran the command in the shell and it printed golden-42, then I opened the " +
    "browser, searched, and confirmed the specifications against the vendor's page.";

  // `shell` used to grep the reply for a string that was in its own prompt, so this
  // passed while the box was unreachable — hiding the outage it existed to catch.
  const shell = await taskNamed("shell").check(
    context({
      reply: boast,
      orchestrator: {
        boxClient: () => ({
          readFile: async () => {
            throw new Error("no such file");
          },
        }),
      } as never,
    })
  );
  assert.equal(shell.pass, false, "shell must be graded on the file, not the reply");

  // `uses-what-it-has` is graded on the record: no tool calls means it did not act,
  // whatever it says it did.
  const acted = await taskNamed("uses-what-it-has").check(context({ reply: boast }));
  assert.equal(acted.pass, false, "must be graded on the transcript");

  // A refused fetch that stopped it is a failure even if the prose is impeccable.
  const blocked = await taskNamed("blocked-not-absent").check(context({ reply: boast }));
  assert.equal(blocked.pass, false, "must be graded on whether it recovered");
});

test("an unsourceable claim recorded as done fails, however it is described", async () => {
  const task = taskNamed("not-verified");
  const reply = "I could not find any source for this claim, so I am marking it unverified.";

  // The words say the right thing; the field says otherwise, and the field is the answer.
  const lying = await task.check(
    context({
      reply,
      orchestrator: {
        tasks: { list: () => [{ title: "Zephyrus QX-880 claim", status: "done", history: [] }] },
      } as never,
    })
  );
  assert.equal(lying.pass, false, "the recorded status decides, not the prose");

  // And a blocked record passes even with no prose at all, which is the point of moving
  // the verdict into a field.
  const honest = await task.check(
    context({
      reply: "",
      orchestrator: {
        tasks: {
          list: () => [
            { title: "Zephyrus QX-880 claim", status: "blocked", history: [{ note: "no source" }] },
          ],
        },
      } as never,
    })
  );
  assert.equal(honest.pass, true);
});

test("no grader that can be fooled by a cooperative judge remains", async () => {
  // The judge here says yes to everything. Any task that still passes on empty records is
  // one whose pass condition rests on a model's opinion — which is what the harnesses
  // that state a boundary all refuse to do.
  const empty = context({ reply: "I did all of it, honestly." });
  for (const task of GOLDEN_TASKS) {
    // The value-comparison tasks legitimately read the reply; they are excluded because
    // the harness knows the answer it planted.
    if (["pong", "arithmetic", "chinese", "renders-late", "honesty"].includes(task.id)) continue;
    const result = await task.check(empty).catch(() => ({ pass: false, detail: "threw" }));
    assert.equal(result.pass, false, `${task.id} passed on empty records`);
  }
});
