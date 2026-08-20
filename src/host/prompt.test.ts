/**
 * Tests for the guidance that decides which tool an agent reaches for.
 *
 * These assert on prompt *text*, which is usually a bad idea — a test that pins wording makes every
 * edit a test failure. They exist because each of these sentences was added in response to observed
 * behaviour, and losing one would silently restore the behaviour: an agent curling a git repository
 * file by file, or telling a person their report is "in the work directory" and leaving them to find
 * a file manager inside a VNC session. The assertions are on the load-bearing phrase, not the
 * paragraph.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSystemPrompt } from "./prompt.ts";

// ── the guidance that decides which tool an agent reaches for ──────────────────────────

test("the prompt does not tell the model how to choose between its tools", () => {
  const prompt = buildSystemPrompt({
    agent: { id: "a", profile: { name: "Ada", description: "", createdAt: "", updatedAt: "" } } as never,
    teammates: [],
    memory: [],
    resolution: undefined,
    agentsRoot: "/tmp",
    hasBox: true,
  });

  // This assertion is the reverse of what it was, and the reversal is the point.
  //
  // An agent was seen reading a git repository by fetching raw URLs one file at a time, and the
  // first fix was a paragraph here explaining when to clone and when to open a browser. That was
  // wrong for the reason this codebase had already written down elsewhere: standing text is re-read
  // on every request forever, so a briefing aimed at one situation keeps asserting itself in every
  // other one — and a model already knows that cloning beats fetching a tree file by file.
  //
  // The actual cause was steering, not ignorance: the shell tool's description named curl as its
  // example and said to prefer the shell over a GUI. Removing the steering was the fix; adding
  // counter-steering would have been a second bug.
  assert.doesNotMatch(prompt, /git clone/, "strategy the model already has does not belong here");
  assert.doesNotMatch(prompt, /suspiciously small/);
  assert.doesNotMatch(
    prompt,
    /Reaching for the GUI/,
    "the sentence that caused the behaviour is gone, not balanced"
  );

  // What stays is the line saying the choice is the agent's, and why nothing more is said.
  assert.match(prompt, /Which to use is your call/);
  assert.match(prompt, /a guess about\s*a situation nobody has seen yet/);
});

test("the prompt keeps the facts the model cannot work out for itself", () => {
  const prompt = buildSystemPrompt({
    agent: { id: "a", profile: { name: "Ada", description: "", createdAt: "", updatedAt: "" } } as never,
    teammates: [],
    memory: [],
    resolution: undefined,
    agentsRoot: "/tmp",
    hasBox: true,
  });

  // The dividing line: this prompt carries facts about *this environment*, and nothing else. Each of
  // these is unknowable from the outside, and getting each one wrong costs an agent real time.
  assert.match(prompt, /box-chrome/, "a bare chromium fails here for reasons unrelated to the task");
  assert.match(prompt, /\/home\/box\/work/, "the only directory that survives a rebuild");
  assert.match(prompt, /box-clip/, "xclip behaves differently in this container");
  assert.match(prompt, /box-doctor/, "there is a self-check, and it is not guessable");
});

test("the prompt says how to hand a file to a person", () => {
  const prompt = buildSystemPrompt({
    agent: { id: "a", profile: { name: "Ada", description: "", createdAt: "", updatedAt: "" } } as never,
    teammates: [],
    memory: [],
    resolution: undefined,
    agentsRoot: "/tmp",
    hasBox: true,
  });

  // The experience this fixes: an agent writes a report and says "I saved it in the work
  // directory", leaving a person to open a VNC desktop and find a file manager.
  // This one stays, and it is worth saying why it is not the same kind of text as the removed
  // paragraphs: that a path under /home/box/work becomes a clickable link in someone's chat is a
  // fact about this system's UI. No model can infer it, and without it an agent reasonably says
  // "I saved it in the work directory" and leaves a person with nothing to click.
  assert.match(prompt, /not something the person you are talking to can see/);
  assert.match(prompt, /give its full path in your message/);
  assert.match(prompt, /"I saved it in the work directory" is not/);
});
