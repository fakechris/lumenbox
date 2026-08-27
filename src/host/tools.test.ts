/**
 * Tool behaviours worth pinning: the ones where a wrong answer changes a file.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTools, dispatchTool } from "./tools.ts";

test("edit_file changes part of a file, and refuses the two ways it could change the wrong part", async () => {
  const file = { path: "/home/box/work/app.py", content: "" };
  const box = {
    readFile: async () => ({
      path: file.path,
      content: file.content,
      total_lines: file.content.split("\n").length,
      truncated: false,
    }),
    writeFile: async (_path: string, content: string) => {
      file.content = content;
      return { path: file.path, bytes: content.length };
    },
  };
  const context = {
    agent: { id: "a1", profile: { name: "Ada" } },
    registry: {} as never,
    bus: {} as never,
    box,
  } as unknown as Parameters<typeof dispatchTool>[2];

  file.content = "import os\n\ndef main():\n    print('hello')\n\nmain()\n";
  const edited = await dispatchTool(
    "edit_file",
    { path: file.path, old: "    print('hello')", new: "    print('goodbye')" },
    context
  );
  assert.ok(!edited.isError, edited.text);
  assert.match(file.content, /print\('goodbye'\)/);
  assert.match(file.content, /^import os/, "and nothing else moved");

  // Not there: says so, and says why it might not match.
  const missing = await dispatchTool(
    "edit_file",
    { path: file.path, old: "print('nope')", new: "x" },
    context
  );
  assert.ok(missing.isError);
  assert.match(missing.text, /does not appear/);

  // Ambiguous: refuses rather than picking one, and says how many it found.
  file.content = "a = 1\nb = 1\n";
  const ambiguous = await dispatchTool("edit_file", { path: file.path, old: "= 1", new: "= 2" }, context);
  assert.ok(ambiguous.isError);
  assert.match(ambiguous.text, /appears 2 times/);
  assert.equal(file.content, "a = 1\nb = 1\n", "and nothing was written");

  // A file read only in part cannot be matched against honestly.
  const partial = {
    ...context,
    box: { ...box, readFile: async () => ({ path: file.path, content: "a = 1\n", total_lines: 999, truncated: true }) },
  } as unknown as Parameters<typeof dispatchTool>[2];
  const tooBig = await dispatchTool("edit_file", { path: file.path, old: "a = 1", new: "a = 2" }, partial);
  assert.ok(tooBig.isError);
  assert.match(tooBig.text, /too large/);
});

test("AskUser hands the question to a person and stops, rather than guessing or waiting", async () => {
  const asked: { question: string; options?: string[] }[] = [];
  const context = {
    agent: { id: "a1", profile: { name: "Rex" } },
    registry: {} as never,
    bus: {} as never,
    box: undefined,
    askUser: async (input: { question: string; options?: string[] }) => {
      asked.push({ question: input.question, ...(input.options ? { options: input.options } : {}) });
      return "feishu:ou_chris";
    },
  } as unknown as Parameters<typeof dispatchTool>[2];

  const result = await dispatchTool(
    "AskUser",
    { question: "Which quarter did you mean, this one or last?", options: ["this", "last"] },
    context
  );
  assert.ok(!result.isError);
  assert.deepEqual(asked, [
    { question: "Which quarter did you mean, this one or last?", options: ["this", "last"] },
  ]);
  // The turn ending is the answer. An agent told to carry on would either act on the
  // guess it just said it could not make, or burn rounds waiting for a message that
  // arrives as a new turn by design.
  assert.match(result.text, /turn ends here/);
  assert.match(result.text, /wakes you/);
  assert.match(result.text, /feishu:ou_chris/);

  // Nobody to ask: said plainly, so the agent decides and admits which way it went.
  const alone = await dispatchTool("AskUser", { question: "anything?" }, {
    ...context,
    askUser: undefined,
  } as unknown as Parameters<typeof dispatchTool>[2]);
  assert.ok(alone.isError);
  assert.match(alone.text, /nobody to ask/);

  // Reachable in principle, but this agent has never been driven from anywhere.
  const undeliverable = await dispatchTool("AskUser", { question: "anything?" }, {
    ...context,
    askUser: async () => undefined,
  } as unknown as Parameters<typeof dispatchTool>[2]);
  assert.ok(undeliverable.isError);
  assert.match(undeliverable.text, /could not be delivered/);

  // A model that ignores the schema and sends option objects. It happened on the MiniMax
  // profile with a Feishu-doc question: four choices reached the person's chat as four
  // lines of "[object Object]", which is a question nobody can answer. The schema says
  // strings; nothing enforces a schema on a model, so the reader has to.
  asked.length = 0;
  const objects = await dispatchTool(
    "AskUser",
    {
      question: "The doc needs a login. What should I do?",
      options: [
        { label: "用你已有的飞书身份读", description: "walk the OAuth flow" },
        { text: "把正文粘给我" },
        { title: "跳过这篇" },
        "直接问作者",
      ],
    },
    context
  );
  assert.ok(!objects.isError);
  assert.deepEqual(asked[0]?.options, ["用你已有的飞书身份读", "把正文粘给我", "跳过这篇", "直接问作者"]);
});

test("searching is offered only where it can work, and is a tool the team knows about", async () => {
  const { SEARCH_KEY_VARIABLE } = await import("./web.ts");
  const { ALL_TOOLS } = await import("./orchestrator.ts");
  const previous = process.env[SEARCH_KEY_VARIABLE];
  try {
    // A tool that is always present and always answers "not configured" teaches an agent
    // to stop trying — including on the installations where it would have worked.
    delete process.env[SEARCH_KEY_VARIABLE];
    assert.ok(!buildTools(true, true).some(tool => tool.name === "WebSearch"));

    process.env[SEARCH_KEY_VARIABLE] = "test-key";
    assert.ok(buildTools(true, true).some(tool => tool.name === "WebSearch"));

    // Reading a page needs nothing configured, so it is always there.
    assert.ok(buildTools(true, true).some(tool => tool.name === "WebFetch"));

    // The "every tool is accounted for" guard in agents.test.ts runs without a key, so
    // it cannot see this one. Named here instead, or a coordinator's allowlist would
    // silently withhold search from every installation that configured it.
    assert.ok(ALL_TOOLS.includes("WebSearch"));
    assert.ok(ALL_TOOLS.includes("WebFetch"));
  } finally {
    if (previous === undefined) delete process.env[SEARCH_KEY_VARIABLE];
    else process.env[SEARCH_KEY_VARIABLE] = previous;
  }
});

test("the shell refuses to reach around the browser tools, before it needs a box", async () => {
  const context = {
    agent: { id: "a1", profile: { name: "Rex" } },
    registry: {} as never,
    bus: {} as never,
    box: undefined,
  } as unknown as Parameters<typeof dispatchTool>[2];

  // No box here on purpose. The refusal is about the command, and an agent that got
  // "no box" instead would reasonably conclude the command was fine and retry it later.
  const refused = await dispatchTool(
    "bash",
    { command: "curl http://127.0.0.1:9222/json/list" },
    context
  );
  assert.ok(refused.isError);
  assert.match(refused.text, /browser_open/);

  const screen = await dispatchTool("bash", { command: "xdotool key Return" }, context);
  assert.ok(screen.isError);
  assert.match(screen.text, /computer/);
});

test("ReadHistory reads the conversation the agent is in, not the team room", async () => {
  // It read the default, so an agent working in a bound chat and asking what was said
  // earlier was handed the *team room's* history — a different room it may never have
  // been in. Silent, because a wrong history reads exactly like a thin one.
  const asked: (string | undefined)[] = [];
  const context = {
    agent: { id: "a1", profile: { name: "Rex" } },
    conversation: "feishu-oc_room-om_topic",
    registry: {
      tryGet: () => undefined,
      list: () => [],
      readTranscript: (_id: string, conversation?: string) => {
        asked.push(conversation);
        return [];
      },
    },
    bus: {},
    box: undefined,
  } as unknown as Parameters<typeof dispatchTool>[2];

  await dispatchTool("ReadHistory", { search: "anything" }, context);
  assert.deepEqual(asked, ["feishu-oc_room-om_topic"]);
});
