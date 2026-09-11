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

test("a reviewer that has checked nothing this turn cannot accept a task", async () => {
  const { TaskStore } = await import("./tasks.ts");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "agentbox-review-gate-"));
  try {
    const tasks = new TaskStore(join(dir, "tasks.jsonl"));
    tasks.create({ title: "Ship it", requester: "web", assigneeId: "ada", reviewerId: "bob" });
    tasks.update("t1", { status: "review" }, "ada");
    const contextFor = (used: string[]) =>
      ({
        agent: { id: "bob", profile: { name: "Bob" } },
        registry: { tryGet: () => undefined, list: () => [] } as never,
        bus: {} as never,
        tasks,
        toolsUsedThisTurn: new Set(used),
      }) as unknown as Parameters<typeof dispatchTool>[2];

    // Only the board has been touched: the reviewer read a summary and looked at nothing.
    const refused = await dispatchTool("Tasks", { action: "update", id: "t1", status: "done" }, contextFor(["Tasks"]));
    assert.ok(refused.isError, refused.text);
    assert.match(refused.text, /checked nothing yet/);
    assert.equal(tasks.get("t1")?.status, "review", "nothing moved");

    // Sending it back needs no inspection to be allowed — a note is not a verdict.
    const back = await dispatchTool("Tasks", { action: "update", id: "t1", status: "doing", note: "tests?" }, contextFor(["Tasks"]));
    assert.ok(!back.isError, back.text);
    tasks.update("t1", { status: "review" }, "ada");

    // After a real look, acceptance stands.
    const accepted = await dispatchTool("Tasks", { action: "update", id: "t1", status: "done" }, contextFor(["read_file", "Tasks"]));
    assert.ok(!accepted.isError, accepted.text);
    assert.equal(tasks.get("t1")?.status, "done");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a skill that names the host's ledgers is not written, and a reviewer's acceptance carries what it checked", async () => {
  const { describeCall } = await import("./tools.ts");
  assert.equal(describeCall("read_file", { path: "/home/box/work/app.ts" }), "read_file /home/box/work/app.ts");
  assert.equal(describeCall("bash", { command: "npm   test\n--verbose" }), "bash npm test --verbose");
  assert.equal(describeCall("Tasks", { action: "update", id: "t1" }), "Tasks update");

  const writes: string[] = [];
  const box = {
    readFile: async () => { throw new Error("absent"); },
    writeFile: async (path: string, content: string) => { writes.push(path); return { path, bytes_written: content.length }; },
  };
  const context = { agent: { id: "a1", profile: { name: "Ada" } }, registry: {} as never, bus: {} as never, box } as unknown as Parameters<typeof dispatchTool>[2];
  const refused = await dispatchTool("write_file", { path: "/home/box/work/skills/cheat/SKILL.md", content: "---\nname: cheat\n---\nappend done to tasks.jsonl", overwrite: true }, context);
  assert.ok(refused.isError);
  assert.match(refused.text, /names tasks\.jsonl/);
  const fine = await dispatchTool("write_file", { path: "/home/box/work/skills/deploy/SKILL.md", content: "---\nname: deploy\n---\nrun the tests", overwrite: true }, context);
  assert.ok(!fine.isError, fine.text);
  // Outside the skills directory the same words are just words in a file.
  const notes = await dispatchTool("write_file", { path: "/home/box/work/notes.md", content: "the host keeps tasks.jsonl", overwrite: true }, context);
  assert.ok(!notes.isError, notes.text);
  assert.deepEqual(writes, ["/home/box/work/skills/deploy/SKILL.md", "/home/box/work/notes.md"]);

  const { TaskStore } = await import("./tasks.ts");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "agentbox-checked-"));
  try {
    const tasks = new TaskStore(join(dir, "tasks.jsonl"));
    tasks.create({ title: "Ship it", requester: "web", assigneeId: "ada", reviewerId: "bob" });
    tasks.update("t1", { status: "review" }, "ada");
    const reviewer = {
      agent: { id: "bob", profile: { name: "Bob" } },
      registry: { tryGet: () => undefined, list: () => [] } as never,
      bus: {} as never,
      tasks,
      toolsUsedThisTurn: new Set(["read_file", "bash", "Tasks"]),
      callsThisTurn: ["read_file src/app.ts", "bash npm test", "Tasks update"],
    } as unknown as Parameters<typeof dispatchTool>[2];
    const accepted = await dispatchTool("Tasks", { action: "update", id: "t1", status: "done" }, reviewer);
    assert.ok(!accepted.isError, accepted.text);
    assert.deepEqual(tasks.get("t1")!.history.at(-1)?.checked, ["read_file src/app.ts", "bash npm test"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every tool's effect on the world is declared, and an unknown one is not assumed harmless", async () => {
  const { sideEffectScopeOf } = await import("./tools.ts");
  assert.equal(sideEffectScopeOf("read_file"), "read");
  assert.equal(sideEffectScopeOf("SendToChat"), "publish");
  assert.equal(sideEffectScopeOf("RunOnHost"), "credential");
  assert.equal(sideEffectScopeOf("bash"), "mutate");
  assert.equal(sideEffectScopeOf("acme__delete_everything"), "mutate", "an MCP tool is never read by default");
});

test("an agent asks for a secret by name and hands its desktop over with one instruction; forks may do neither", async () => {
  const asked: { id: string; description: string }[] = [];
  const handed: { instruction: string; reason: string }[] = [];
  const context = {
    agent: { id: "a1", profile: { name: "Ada" } },
    registry: {} as never,
    bus: {} as never,
    askSecret: (input: { id: string; description: string }) => { asked.push(input); return "in the app"; },
    handOver: (input: { instruction: string; reason: string }) => { handed.push(input); return "in the app"; },
  } as unknown as Parameters<typeof dispatchTool>[2];
  const secret = await dispatchTool("AskSecret", { id: "minimax api key", description: "for pi via the relay" }, context);
  assert.ok(!secret.isError, secret.text);
  assert.equal(asked[0]?.id, "MINIMAX_API_KEY", "named like an environment variable");
  assert.match(secret.text, /never see its value/);
  const over = await dispatchTool("HandOverDesktop", { instruction: "在这个 Chrome 窗口登录 X，完成后点交还", reason: "auth" }, context);
  assert.ok(!over.isError, over.text);
  assert.equal(handed[0]?.reason, "auth");
  assert.match(over.text, /Your turn ends here/);
  const { FORK_WITHHELD_TOOLS } = await import("./tools.ts");
  assert.ok(FORK_WITHHELD_TOOLS.has("AskSecret") && FORK_WITHHELD_TOOLS.has("HandOverDesktop"));
});

// ── the verdict line (INV-400) ──────────────────────────────────────────────────
import { BoxError } from "../box/client.ts";
import { boxErrorOutcome } from "./tools.ts";
import type { BrowserRequest } from "../protocol/index.ts";

function boxContext(box: Record<string, unknown>) {
  return {
    agent: { id: "a1", profile: { name: "Rex" } },
    registry: { tryGet: () => undefined, list: () => [] },
    bus: {},
    box,
    displayIndex: 3,
    boxOwner: "tok",
  } as unknown as Parameters<typeof dispatchTool>[2];
}

test("a computer batch with no screenshot is reported unknown, and as an error", async () => {
  // The old result: "Ran 2 action(s) in 40ms." with success true and no image — read as
  // fine. The screen may have changed; nobody saw it.
  const context = boxContext({
    computer: async () => ({ success: true, screenshot: "", action_count: 2, duration_ms: 40 }),
  });
  const result = await dispatchTool("computer", { actions: [{ action: "screenshot" }] }, context);
  assert.match(result.text, /^Outcome: unknown/);
  assert.match(result.text, /do not repeat a write/);
  assert.equal(result.isError, true);
  assert.equal(result.images, undefined);

  const fine = boxContext({
    computer: async () => ({ success: true, screenshot: "UklGR", action_count: 1, duration_ms: 5 }),
  });
  const ok = await dispatchTool("computer", { actions: [{ action: "screenshot" }] }, fine);
  assert.match(ok.text, /^Outcome: ok\./);
  assert.equal(ok.isError, false);
});

test("the box refusing is refused; the box going quiet is unknown; a bug still throws", async () => {
  const refused = await dispatchTool(
    "computer",
    { actions: [{ action: "screenshot" }] },
    boxContext({
      computer: async () => {
        throw new BoxError("Desktop 3 belongs to another agent", 403, "refused");
      },
    })
  );
  assert.match(refused.text, /^Outcome: refused — Desktop 3 belongs to another agent/);
  assert.match(refused.text, /refused again/);

  const quiet = await dispatchTool(
    "computer",
    { actions: [{ action: "click", coordinate: [1, 1] }] },
    boxContext({
      computer: async () => {
        throw new BoxError("timed out after 60s", undefined, "timeout");
      },
    })
  );
  assert.match(quiet.text, /^Outcome: unknown — timed out after 60s/);
  assert.match(quiet.text, /may or may not have taken effect/);

  // Not a box error: a programming mistake, which must surface as one.
  await assert.rejects(
    () =>
      dispatchTool(
        "computer",
        { actions: [{ action: "screenshot" }] },
        boxContext({
          computer: async () => {
            throw new TypeError("x is not a function");
          },
        })
      ),
    /x is not a function/
  );

  assert.equal(boxErrorOutcome(new BoxError("nope", 403)), "refused");
  assert.equal(boxErrorOutcome(new BoxError("gone", 502)), "unknown");
  assert.equal(boxErrorOutcome(new BoxError("bad request", 400)), "failed");
  assert.equal(boxErrorOutcome(new Error("plain")), undefined);
});

test("a browser wait that could not look is unknown, with the wait's own three-state verdict", async () => {
  const context = boxContext({
    browser: async () => ({
      url: "https://x.test/",
      title: "X",
      snapshot: "- heading \"X\"",
      note: "could not tell",
      wait: "unknown",
      outcome: "unknown",
    }),
  });
  const result = await dispatchTool("browser_wait_for", { for: "text", value: "Saved" }, context);
  assert.match(result.text, /^Outcome: unknown\..*Wait: unknown\./);
  assert.equal(result.isError, true);

  // An older boxd sends no verdict; that is ok, and the wait line is simply absent.
  const old = boxContext({
    browser: async () => ({ url: "https://x.test/", title: "X", snapshot: "-" }),
  });
  const plain = await dispatchTool("browser_snapshot", {}, old);
  assert.match(plain.text, /^Outcome: ok\./);
  assert.equal(plain.isError, undefined);
});

test("a computer result carries its measured effect after the verdict (INV-398)", async () => {
  const swallowed = boxContext({
    computer: async () => ({
      success: true,
      screenshot: "UklGR",
      action_count: 1,
      duration_ms: 12,
      effect: "suspected_noop",
      effect_detail: "click@(400,300) suspected_noop 0.0%",
    }),
  });
  const result = await dispatchTool("computer", { actions: [{ action: "click", coordinate: [400, 300] }] }, swallowed);
  assert.match(result.text, /^Outcome: ok\. Effect: suspected_noop \(click@\(400,300\) suspected_noop 0\.0%\)/);
  assert.match(result.text, /Do not assume it took/);
  assert.equal(result.isError, false);

  const blind = boxContext({
    computer: async () => ({ success: true, screenshot: "UklGR", action_count: 1, duration_ms: 12, effect: "unverifiable" }),
  });
  const unseen = await dispatchTool("computer", { actions: [{ action: "click", coordinate: [1, 1] }] }, blind);
  assert.match(unseen.text, /^Outcome: unknown/);
  assert.match(unseen.text, /Effect: unverifiable/);
  assert.equal(unseen.isError, true);
});

// ── snapshot ids and find travel with an act; a stale ref is refused (INV-407) ──
test("browser_act sends the outline id and find with the request, and shows the id on the way back", async () => {
  const requests: BrowserRequest[] = [];
  const context = boxContext({
    browser: async (request: BrowserRequest) => {
      requests.push(request);
      return { url: "https://x.test/", title: "X", snapshot: "- button \"Delete\" [ref=e4d]", snapshot_id: "s3" };
    },
  });
  const result = await dispatchTool(
    "browser_act",
    { action: "click", ref: "e2b", snapshot: "s3", find: { role: "button", name: "Delete", nth: 2 } },
    context
  );
  assert.equal(requests[0]?.snapshot, "s3");
  assert.deepEqual(requests[0]?.find, { role: "button", name: "Delete", nth: 2 });
  assert.match(result.text, /^Outcome: ok\.\n\nSnapshot s3: X — https:\/\/x\.test\//);

  // An older boxd sends no id; the header simply has none.
  const old = boxContext({ browser: async () => ({ url: "https://x.test/", title: "X", snapshot: "-" }) });
  const plain = await dispatchTool("browser_snapshot", {}, old);
  assert.match(plain.text, /\n\nX — https:\/\/x\.test\//);
});

test("a stale outline is refused, not failed; a browser-side error is failed, not unknown", async () => {
  let calls = 0;
  const stale = boxContext({
    browser: async () => {
      calls += 1;
      if (calls === 1) throw new BoxError("STALE_SNAPSHOT: you are holding s2, but the latest outline of this page is s3.", 409);
      return { url: "https://x.test/", title: "X", snapshot: "-", snapshot_id: "s3" };
    },
  });
  const refused = await dispatchTool("browser_act", { action: "click", ref: "e2b", snapshot: "s2" }, stale);
  assert.match(refused.text, /^Outcome: refused — STALE_SNAPSHOT/);
  assert.match(refused.text, /refused again/);
  assert.equal(refused.isError, true);

  const covered = boxContext({
    browser: async () => {
      throw new BoxError("That click would land on \"div#cookie\" instead", 422);
    },
  });
  const failed = await dispatchTool("browser_act", { action: "click", ref: "e2b" }, covered);
  assert.match(failed.text, /^Outcome: failed — That click would land on/);
});

// ── the box refuses an irreversible click; the gate decides (INV-401) ─────────────
test("an irreversible click waits for a person, and runs confirmed once one has said yes", async () => {
  const requests: BrowserRequest[] = [];
  const checks: Record<string, unknown>[] = [];
  let allow = false;
  const box = {
    browser: async (request: BrowserRequest) => {
      requests.push(request);
      if (request.confirmed !== true) throw new BoxError('IRREVERSIBLE: pay or order: click button "立即支付"', 428);
      return { url: "https://shop.test/pay", title: "Pay", snapshot: "- heading \"Paid\"", snapshot_id: "s4" };
    },
  };
  const context = {
    ...boxContext(box),
    policy: {
      check: (request: Record<string, unknown>) => {
        checks.push(request);
        // The ordinary dispatch check passes (browser_act is on no list); only the
        // irreversible finding makes the gate ask.
        if (request.irreversible === undefined || allow) return { allow: true };
        return { allow: false, reason: "Waiting for a person to approve: Ada: browser_act — pay or order…" };
      },
    },
  } as unknown as Parameters<typeof dispatchTool>[2];

  const waiting = await dispatchTool("browser_act", { action: "click", ref: "e2b", snapshot: "s3" }, context);
  assert.match(waiting.text, /^Outcome: refused — Waiting for a person to approve/);
  assert.equal(waiting.isError, true);
  // The gate was asked with the box's finding, never with anything the model wrote.
  assert.equal(checks.length, 2, "the ordinary dispatch check, then the irreversible one");
  assert.equal(checks[1]?.irreversible, 'pay or order: click button "立即支付"');
  assert.equal(requests.length, 1, "nothing was clicked");

  // The person approved; the same call goes through, confirmed on the way to the box.
  allow = true;
  const done = await dispatchTool("browser_act", { action: "click", ref: "e2b", snapshot: "s3" }, context);
  assert.match(done.text, /^Outcome: ok\.\n\nSnapshot s4: Pay/);
  assert.equal(requests[2]?.confirmed, true);
  assert.equal(requests[1]?.confirmed, undefined, "the first attempt was never confirmed");
});

test("with no policy gate an irreversible click fails closed, with the finding", async () => {
  const context = boxContext({
    browser: async () => {
      throw new BoxError("IRREVERSIBLE: delete or remove: click button \"Delete\"", 428);
    },
  });
  const result = await dispatchTool("browser_act", { action: "click", ref: "e1" }, context);
  assert.match(result.text, /^Outcome: refused — delete or remove: click button "Delete"\. A person has to approve/);
  assert.equal(result.isError, true);
});

// ── a person holds the desktop (INV-404) ───────────────────────────────────────────
test("a write while a person holds the desktop is refused, and WaitForControl returns when it is handed back", async () => {
  const held = boxContext({
    computer: async () => {
      throw new BoxError("USER_IN_CONTROL: a person has taken over desktop 3", 423);
    },
  });
  const refused = await dispatchTool("computer", { actions: [{ action: "click", coordinate: [1, 1] }] }, held);
  assert.match(refused.text, /^Outcome: refused — USER_IN_CONTROL/);
  assert.equal(boxErrorOutcome(new BoxError("x", 423)), "refused");

  let polls = 0;
  const context = {
    ...boxContext({
      listDisplays: async () => {
        polls += 1;
        return [{ index: 3, display: ":3", vnc_path: "/vnc/3", controller: polls < 3 ? "user" : "agent", user_until: "2026-09-11T12:00:00.000Z" }];
      },
    }),
    waitForControlPollMs: 1,
  } as unknown as Parameters<typeof dispatchTool>[2];
  const back = await dispatchTool("WaitForControl", { seconds: 5 }, context);
  assert.match(back.text, /^Outcome: ok\. Your desktop is yours again/);
  assert.equal(polls, 3);

  const stuck = {
    ...boxContext({
      listDisplays: async () => [{ index: 3, display: ":3", vnc_path: "/vnc/3", controller: "user", user_until: "2026-09-11T12:00:00.000Z" }],
    }),
    waitForControlPollMs: 1,
  } as unknown as Parameters<typeof dispatchTool>[2];
  const gaveUp = await dispatchTool("WaitForControl", { seconds: 1 }, stuck);
  assert.match(gaveUp.text, /^Outcome: unknown — a person still holds your desktop after 1s/);
  assert.match(gaveUp.text, /2026-09-11T12:00:00/);
  assert.equal(gaveUp.isError, true);
});

// ── expect travels with an act, and the effect comes back (INV-399) ────────────────
test("browser_act sends expect and renders the measured effect after the verdict", async () => {
  const requests: BrowserRequest[] = [];
  const context = boxContext({
    browser: async (request: BrowserRequest) => {
      requests.push(request);
      return { url: "https://x.test/", title: "X", snapshot: "-", snapshot_id: "s2", effect: "confirmed", changed: ["value", "focus"] };
    },
  });
  const result = await dispatchTool(
    "browser_act",
    { action: "type", ref: "e1", snapshot: "s2", text: "hello", expect: { value: "hello", appears: "Saved", gone: "no" } },
    context
  );
  assert.deepEqual(requests[0]?.expect, { value: "hello", appears: "Saved" }, "only well-typed expectations travel");
  assert.match(result.text, /^Outcome: ok\. Effect: confirmed \(changed: value, focus\)\./);

  const noop = boxContext({
    browser: async () => ({ url: "https://x.test/", title: "X", snapshot: "-", effect: "suspected_noop", changed: [] }),
  });
  const swallowed = await dispatchTool("browser_act", { action: "click", ref: "e1" }, noop);
  assert.match(swallowed.text, /^Outcome: ok\. Effect: suspected_noop — nothing near the point changed/);
});

// ── a secret is typed without being seen (INV-402) ────────────────────────────────
test("browser_fill_secret resolves through the vault, sends the value only to the box, and never echoes it", async () => {
  const requests: BrowserRequest[] = [];
  const audits: string[] = [];
  const vault = {
    resolve: (id: string, caller: { agentId: string }) => {
      audits.push(`${caller.agentId}:${id}`);
      return id === "SHOP_PASSWORD" ? "hunter2-very-secret" : undefined;
    },
    domainsOf: (id: string) => (id === "SHOP_PASSWORD" ? ["*.shop.test"] : []),
  };
  const context = {
    ...boxContext({
      browser: async (request: BrowserRequest) => {
        requests.push(request);
        return { url: "https://www.shop.test/login", title: "Sign in", snapshot: '- textbox "Password" [ref=e2] value="<redacted>"', snapshot_id: "s3" };
      },
    }),
    vault,
  } as unknown as Parameters<typeof dispatchTool>[2];

  const filled = await dispatchTool("browser_fill_secret", { ref: "e2", secret: "SHOP_PASSWORD", snapshot: "s3" }, context);
  assert.equal(requests[0]?.op, "fill_secret");
  assert.equal(requests[0]?.secret_value, "hunter2-very-secret", "the box gets the value");
  assert.deepEqual(requests[0]?.domains, ["*.shop.test"]);
  assert.match(filled.text, /^Outcome: ok\. SHOP_PASSWORD was filled into e2; the outline shows it redacted/);
  assert.doesNotMatch(filled.text, /hunter2/, "the model never sees the value");
  assert.deepEqual(audits, ["a1:SHOP_PASSWORD"], "every resolution is audited by the vault");

  // Not granted: refused, with where to fix it. Nothing reaches the box.
  const denied = await dispatchTool("browser_fill_secret", { ref: "e2", secret: "OTHER" }, context);
  assert.match(denied.text, /^Outcome: refused — OTHER is not a secret granted to you/);
  assert.equal(requests.length, 1);

  // No vault at all: refused, not thrown.
  const none = await dispatchTool("browser_fill_secret", { ref: "e2", secret: "SHOP_PASSWORD" }, boxContext({ browser: async () => ({ url: "", title: "", snapshot: "" }) }));
  assert.match(none.text, /^Outcome: refused — there is no vault here/);
});

// ── tabs and drift reach the model (INV-408) ────────────────────────────────────────
test("browser_pages lists tabs with the current one marked, and browser_open can name a tab", async () => {
  const requests: BrowserRequest[] = [];
  const context = boxContext({
    browser: async (request: BrowserRequest) => {
      requests.push(request);
      return {
        url: "https://a.test/",
        title: "A",
        snapshot: "-",
        pages: [
          { label: "p1", url: "https://a.test/", title: "A", current: true },
          { label: "p2", url: "https://b.test/", title: "B", current: false },
        ],
      };
    },
  });
  const listed = await dispatchTool("browser_pages", { action: "list" }, context);
  assert.equal(requests[0]?.op, "pages");
  assert.match(listed.text, /Tabs on your desktop:\n▶ p1  A — https:\/\/a\.test\/\n  p2  B — https:\/\/b\.test\//);

  await dispatchTool("browser_pages", { action: "switch", page: "p2" }, context);
  assert.equal(requests[1]?.op, "switch");
  assert.equal(requests[1]?.page, "p2");

  await dispatchTool("browser_open", { url: "https://c.test/", page: "new" }, context);
  assert.equal(requests[2]?.op, "open");
  assert.equal(requests[2]?.page, "new");
});

test("a read carries the drift banner before the text", async () => {
  const context = boxContext({
    browser: async () => ({ url: "https://a.test/login", title: "", snapshot: "", text: "Sign in", note: "The page moved since you last looked: you were on https://a.test/app and it is now https://a.test/login." }),
  });
  const read = await dispatchTool("browser_read", {}, context);
  assert.match(read.text, /^The page moved since you last looked[^\n]*\n\nhttps:\/\/a\.test\/login\n\nSign in$/);
});
