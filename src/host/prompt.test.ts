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

test("the prompt gives a real rule for cloning and for the browser", () => {
  const prompt = buildSystemPrompt({
    agent: { id: "a", profile: { name: "Ada", description: "", createdAt: "", updatedAt: "" } } as never,
    teammates: [],
    memory: "",
    resolution: undefined,
    agentsRoot: "/tmp",
    hasBox: true,
  });

  // The observed behaviour this fixes: an agent reading a git repository by curling raw URLs one
  // file at a time, because the shell tool's description named curl and nothing named git.
  assert.match(prompt, /git clone/);
  assert.match(prompt, /Fetching a repository file by file/);

  // And the other half: knowing when curl has failed rather than retrying with more headers. Both
  // failure signatures are named, because "use the browser sometimes" is not actionable.
  assert.match(prompt, /suspiciously small/);
  assert.match(prompt, /renders\s*client-side will never yield/);

  // Stated as judgement rather than a rule, since a single small file really is a curl.
  assert.match(prompt, /Neither of these is a rule to follow blindly/);
});

test("the prompt says how to hand a file to a person", () => {
  const prompt = buildSystemPrompt({
    agent: { id: "a", profile: { name: "Ada", description: "", createdAt: "", updatedAt: "" } } as never,
    teammates: [],
    memory: "",
    resolution: undefined,
    agentsRoot: "/tmp",
    hasBox: true,
  });

  // The experience this fixes: an agent writes a report and says "I saved it in the work
  // directory", leaving a person to open a VNC desktop and find a file manager.
  assert.match(prompt, /not something the person you are talking to can see/);
  assert.match(prompt, /give its full path in your message/);
  assert.match(prompt, /"I saved it in the work directory" is not/);
  // And the counterweight, so it does not start putting two-sentence answers in files.
  assert.match(prompt, /do not make\s*someone open a file to read two sentences/);
});
