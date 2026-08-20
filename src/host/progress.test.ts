/**
 * Tests for loop detection and the round-limit judgement.
 *
 * The important ones are the false positives. A detector that stops a working agent is worse than no
 * detector, because the failure it causes is silent and looks like the agent giving up — so each
 * "this is not a loop" case here is a specific thing an agent legitimately does that a naive
 * definition would kill.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyLimit,
  continuationPrompt,
  detectLoop,
  hasProgressed,
  loopReport,
  MAX_CONTINUATIONS,
  signatureOf,
  stateHashOf,
  type RoundRecord,
} from "./progress.ts";

const round = (signatures: string[], stateHash = "s0"): RoundRecord => ({ signatures, stateHash });

test("the same call with the same arguments, repeatedly, is a loop", () => {
  const call = signatureOf("bash", { command: "ls /tmp" });
  const rounds = [round([call]), round([call]), round([call]), round([call])];
  const found = detectLoop(rounds);
  assert.ok(found);
  assert.equal(found.rounds, 4);
  // The message quotes the call, which is worth more than any adjective.
  assert.match(loopReport(found, 10), /same `bash` call with the same/);
  assert.match(loopReport(found, 10), /Say what you were trying to achieve/);
});

test("varied work is not a loop", () => {
  // The false positive that matters most: an agent doing different things is working, however many
  // rounds it takes.
  const rounds = [
    round([signatureOf("bash", { command: "ls" })]),
    round([signatureOf("bash", { command: "cat a" })]),
    round([signatureOf("bash", { command: "cat b" })]),
    round([signatureOf("computer", { actions: [{ action: "screenshot" }] })]),
  ];
  assert.equal(detectLoop(rounds), undefined);
});

test("two calls alternating is not a loop", () => {
  // An agent that acts and then looks is doing the normal thing.
  const act = signatureOf("computer", { actions: [{ action: "left_click" }] });
  const look = signatureOf("computer", { actions: [{ action: "screenshot" }] });
  assert.equal(detectLoop([round([act]), round([look]), round([act]), round([look])]), undefined);
  // Both in the same round likewise.
  assert.equal(
    detectLoop([round([act, look]), round([act, look]), round([act, look]), round([act, look])]),
    undefined
  );
});

test("a repeat that ticks something off is not a loop", () => {
  // Polling a build with `bash: make` four times while the todo list moves is patience, not a loop.
  const call = signatureOf("bash", { command: "make" });
  const rounds = [round([call], "s0"), round([call], "s0"), round([call], "s1"), round([call], "s1")];
  assert.equal(
    detectLoop(rounds),
    undefined,
    "an agent that changed what it says it is doing made progress"
  );
});

test("rounds with no calls are the model talking, not looping", () => {
  const call = signatureOf("bash", { command: "ls" });
  assert.equal(detectLoop([round([call]), round([]), round([call]), round([call])]), undefined);
});

test("three repeats is patience; four is a loop", () => {
  const call = signatureOf("bash", { command: "sleep 1" });
  assert.equal(detectLoop([round([call]), round([call]), round([call])]), undefined);
  assert.ok(detectLoop([round([call]), round([call]), round([call]), round([call])]));
});

test("argument order does not hide a loop", () => {
  // Two identical calls whose keys arrived in a different order have to be recognised as identical,
  // or a loop hides behind JSON key ordering.
  assert.equal(
    signatureOf("bash", { command: "ls", cwd: "/tmp" }),
    signatureOf("bash", { cwd: "/tmp", command: "ls" })
  );
  // And nested, since tool inputs are.
  assert.equal(
    signatureOf("computer", { actions: [{ action: "click", x: 1, y: 2 }] }),
    signatureOf("computer", { actions: [{ y: 2, x: 1, action: "click" }] })
  );
  // Different arguments are still different.
  assert.notEqual(
    signatureOf("bash", { command: "rm a" }),
    signatureOf("bash", { command: "rm b" })
  );
});

test("the state hash moves when a todo does, and not otherwise", () => {
  const base = { plan: "do it", todos: [{ text: "one", status: "pending" as const }] };
  assert.equal(stateHashOf(base), stateHashOf({ ...base }));
  assert.notEqual(
    stateHashOf(base),
    stateHashOf({ ...base, todos: [{ text: "one", status: "done" }] }),
    "ticking something off has to register"
  );
  assert.notEqual(stateHashOf(base), stateHashOf({ ...base, plan: "do it differently" }));
  // Whitespace on the plan is not a change: an agent that rewrote its plan identically did nothing.
  assert.equal(stateHashOf(base), stateHashOf({ ...base, plan: "  do it \n" }));
  assert.equal(stateHashOf({}), stateHashOf({ plan: "", todos: [] }));
});

test("the limit distinguishes stuck from out of budget", () => {
  const call = signatureOf("bash", { command: "ls" });

  // Looping: reported as a loop, with the call.
  const looping = classifyLimit([round([call]), round([call]), round([call]), round([call])]);
  assert.equal(looping.kind, "looping");

  // Progressing: a budget, not a wall. This is the case the old code called "probably looping" and
  // then abandoned.
  const progressing = classifyLimit([round([call], "s0"), round([call], "s1")]);
  assert.equal(progressing.kind, "progressing");

  // Varied calls with no state change also count as progress: an agent working without a todo list
  // is still working.
  assert.equal(
    classifyLimit([round([call]), round([signatureOf("bash", { command: "pwd" })])]).kind,
    "progressing"
  );

  // Nothing at all: reported as unclear rather than as a diagnosis nobody checked.
  assert.equal(classifyLimit([]).kind, "inconclusive");
  assert.equal(classifyLimit([round([call])]).kind, "inconclusive");
});

test("progress is judged generously, because abandoning work is the worse mistake", () => {
  const call = signatureOf("bash", { command: "x" });
  const many = Array.from({ length: 399 }, () => round([call], "s0"));
  assert.equal(hasProgressed(many), false, "four hundred identical rounds changed nothing");
  // One change in four hundred rounds is slow progress, and throwing it away is worse than
  // continuing.
  assert.equal(hasProgressed([...many, round([call], "s1")]), true);
});

test("the continuation prompt says where to pick up and when to stop", () => {
  const prompt = continuationPrompt(400, 2);
  assert.match(prompt, /this is a fresh turn rather than a failure/);
  assert.match(prompt, new RegExp(`continuation 2\\s*of at most ${MAX_CONTINUATIONS}`));
  // The two things it has to say: the plan survived, and do not start what you cannot finish.
  assert.match(prompt, /plan and todo list are in your instructions above and are unchanged/);
  assert.match(prompt, /first item that is not done/);
  assert.match(prompt, /stop and say what is left/);
});
