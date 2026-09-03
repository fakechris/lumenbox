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

    // Reading a Feishu document needs the bot's workspace identity — offered only
    // where one exists, same reasoning as WebSearch.
    assert.ok(!buildTools(true, true).some(tool => tool.name === "ReadFeishuDoc"));
    assert.ok(
      buildTools(true, true, undefined, false, true, true).some(
        tool => tool.name === "ReadFeishuDoc"
      )
    );

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

// ── template setup turn (docs/29 §5.3) ─────────────────────────────────────────

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "../agents/registry.ts";
import { parseSkillFile } from "./skills.ts";

test("during a template setup turn a routine the bot writes starts paused and says where it came from; outside one nothing is touched", async () => {
  const files = new Map<string, string>();
  const box = {
    readFile: async () => {
      throw new Error("no such file");
    },
    writeFile: async (path: string, content: string) => {
      files.set(path, content);
      return { path, bytes_written: content.length };
    },
  };
  const base = { agent: { id: "a1", profile: { name: "Vera" } }, registry: {} as never, bus: {} as never, box };
  const routine = "---\nname: Digest\ndescription: d\nschedule: \"@daily\"\n---\nbody\n";

  const setup = { ...base, templateSetup: "tpl1" } as unknown as Parameters<typeof dispatchTool>[2];
  await dispatchTool("write_file", { path: "/home/box/work/skills/digest/SKILL.md", content: routine }, setup);
  const written = parseSkillFile(files.get("/home/box/work/skills/digest/SKILL.md")!).meta;
  assert.equal(written.paused, "true");
  assert.equal(written.authored_by, "template:tpl1");

  // A plain skill is stamped but has nothing to pause; a file elsewhere is left alone.
  await dispatchTool("write_file", { path: "/home/box/work/skills/plain/SKILL.md", content: "---\nname: p\ndescription: d\n---\nbody\n" }, setup);
  assert.equal(parseSkillFile(files.get("/home/box/work/skills/plain/SKILL.md")!).meta.paused, undefined);
  await dispatchTool("write_file", { path: "/home/box/work/notes.md", content: routine }, setup);
  assert.equal(files.get("/home/box/work/notes.md"), routine);

  const ordinary = base as unknown as Parameters<typeof dispatchTool>[2];
  await dispatchTool("write_file", { path: "/home/box/work/skills/digest/SKILL.md", content: routine }, ordinary);
  assert.equal(files.get("/home/box/work/skills/digest/SKILL.md"), routine, "an ordinary turn writes what it wrote");
});

test("a memory kept during a template setup turn is sourced to the template and is about nobody", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentbox-tpl-mem-"));
  try {
    const registry = new AgentRegistry(join(root, "agents"));
    const vera = registry.create({ name: "Vera" });
    const context = {
      agent: vera,
      registry,
      bus: {} as never,
      box: undefined,
      caller: { userId: "chris" },
      templateSetup: "tpl1",
    } as unknown as Parameters<typeof dispatchTool>[2];
    const kept = await dispatchTool("RememberFact", { fact: "Transcripts go to ~/work/out as markdown." }, context);
    assert.ok(!kept.isError, kept.text);
    const [record] = registry.readMemoryRecords(vera.id);
    assert.equal(record?.source, "template:tpl1");
    assert.equal(record?.about, undefined, "the person importing did not say it");

    const later = { ...context, templateSetup: undefined } as unknown as Parameters<typeof dispatchTool>[2];
    await dispatchTool("RememberFact", { fact: "Chris wants the digest on Mondays." }, later);
    const [, own] = registry.readMemoryRecords(vera.id);
    assert.equal(own?.source, "RememberFact");
    assert.equal(own?.about, "chris");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PackTemplate packs from the live files and stages a version the bot cannot publish", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentbox-tpl-pack-"));
  try {
    const registry = new AgentRegistry(join(root, "agents"));
    const ada = registry.create({ name: "Ada", title: "转写", avatarColor: "brown" });
    registry.create({ name: "Bob" });
    registry.appendMemoryRecords(ada.id, [
      { at: "2026-09-01T00:00:00Z", kind: "fact", text: "Chris likes the digest terse.", about: "chris" },
    ]);
    const tree: Record<string, string> = {
      "/home/box/work/skills/transcribe/SKILL.md": "---\nname: 音视频转写\ndescription: Transcribe a video.\n---\nFetch, transcribe, write to ~/work/out.\n",
      "/home/box/work/skills/digest/SKILL.md": "---\nname: Digest\ndescription: Monday digest.\nschedule: \"0 9 * * 1\"\ndeliver: feishu:oc_abcdef123456\nagent: Ada\n---\nPost the week to feishu:oc_abcdef123456.\n",
    };
    const box = {
      listDir: async (path: string) => {
        const names = new Map<string, string>();
        for (const key of Object.keys(tree)) {
          if (!key.startsWith(`${path}/`)) continue;
          const rest = key.slice(path.length + 1);
          names.set(rest.split("/")[0]!, rest.includes("/") ? "directory" : "file");
        }
        if (names.size === 0) throw new Error("no such directory");
        return { entries: [...names].map(([name, type]) => ({ name, type })) };
      },
      readFile: async (path: string) => {
        if (tree[path] === undefined) throw new Error("no such file");
        return { content: tree[path] };
      },
    };
    const staged: { agentId: string; name: string }[] = [];
    const context = {
      agent: ada,
      registry,
      bus: {} as never,
      box,
      caller: { userId: "chris" },
      templates: {
        stage: (agentId: string, template: { profile: { name: string } }) => {
          staged.push({ agentId, name: template.profile.name });
          return { id: "share1", version: staged.length, path: "/tmp/v1.json" };
        },
      },
    } as unknown as Parameters<typeof dispatchTool>[2];

    const outcome = await dispatchTool(
      "PackTemplate",
      {
        description: "Turns videos into Chinese transcripts and posts a Monday digest.",
        memory: [{ text: "Transcripts are written to ~/work/out as markdown." }],
        skills: [{ slug: "transcribe" }, { slug: "nope" }],
        routines: [{ slug: "digest" }],
        connectors: ["feishu"],
      },
      context
    );
    assert.ok(!outcome.isError, outcome.text);
    assert.match(outcome.text, /Staged version 1 of the template "Ada" \(1 skill, 1 routine, 1 memory, needs feishu\)/);
    assert.match(outcome.text, /Left out: nope: no such skill here/);
    assert.match(outcome.text, /not shared until the person publishes/);
    assert.deepEqual(staged, [{ agentId: ada.id, name: "Ada" }]);

    // A memory about a person refuses the call, and nothing is staged.
    const personal = await dispatchTool(
      "PackTemplate",
      { description: "d", memory: [{ text: "Chris likes the digest terse, so keep it short." }], skills: [], routines: [], connectors: [] },
      context
    );
    assert.ok(personal.isError && /about a person here/.test(personal.text));
    assert.equal(staged.length, 1);

    // Without somewhere to stage, the tool says so rather than pretending.
    const nowhere = await dispatchTool("PackTemplate", { description: "d" }, { ...context, templates: undefined } as never);
    assert.ok(nowhere.isError && /not available here/.test(nowhere.text));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
