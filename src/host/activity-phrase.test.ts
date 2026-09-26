import { test } from "node:test";
import assert from "node:assert/strict";
import { activityPhrase, activityPhrases, hasPhraseTemplate, phrasedTools, safeDetailOf } from "./activity-phrase.ts";
import { buildTools } from "./tools.ts";
import { SEARCH_PROVIDERS } from "./web.ts";

/** Every tool this installation can offer, with every optional one switched on (as side-effects.test.ts). */
function everyTool(): string[] {
  const key = SEARCH_PROVIDERS[0]!.keyEnv;
  const before = process.env[key];
  process.env[key] = "offered-for-the-guard";
  try {
    return buildTools(true, true, undefined, true, true, true, true, false, ["github"]).map(tool => tool.name);
  } finally {
    if (before === undefined) delete process.env[key];
    else process.env[key] = before;
  }
}

test("guard: every offered built-in tool has a phrase, and every phrase names a real tool", () => {
  const offered = new Set(everyTool());
  const missing = [...offered].filter(name => !hasPhraseTemplate(name));
  assert.deepEqual(missing, [], "a new tool must say what it does in a person's words in activity-phrase.ts");
  const phantom = phrasedTools().filter(name => !offered.has(name));
  assert.deepEqual(phantom, [], "a phrase must name a tool buildTools can offer");
});

test("guard: no template renders empty in either language", () => {
  for (const tool of phrasedTools()) {
    for (const locale of ["en", "zh"] as const) {
      const line = activityPhrase(tool, {}, locale);
      assert.ok(line.trim() !== "", `${tool} renders empty in ${locale}`);
      assert.ok(!line.includes("{detail}"), `${tool} leaks its placeholder in ${locale}: ${line}`);
    }
  }
});

test("bash shows the program and never the command", () => {
  const command = "python batch.py --token sk-secret-123 /Users/someone/reports";
  assert.equal(safeDetailOf("bash", { command }), "python");
  const en = activityPhrase("bash", { command }, "en");
  const zh = activityPhrase("bash", { command }, "zh");
  assert.equal(en, "running a command (python)");
  assert.equal(zh, "运行命令(python)");
  for (const line of [en, zh]) {
    assert.ok(!line.includes("sk-secret"), line);
    assert.ok(!line.includes("batch.py"), line);
    assert.ok(!line.includes("/Users"), line);
  }
  // An env assignment or sudo is not the program; a path to the program is the program.
  assert.equal(safeDetailOf("bash", { command: "FOO=1 sudo /usr/bin/node script.js" }), "node");
  assert.equal(safeDetailOf("bash", { command: "   " }), undefined);
  assert.equal(activityPhrase("bash", {}, "en"), "running a command");
  assert.equal(activityPhrase("bash", {}, "zh"), "运行命令");
});

test("files show the basename and never the directory", () => {
  assert.equal(safeDetailOf("read_file", { path: "/home/box/work/reports/q1.pdf" }), "q1.pdf");
  assert.equal(activityPhrase("edit_file", { path: "/home/box/work/src/app.ts", old: "a", new: "b" }, "en"), "editing app.ts");
  assert.equal(activityPhrase("write_file", { path: "notes/plan.md", content: "secret" }, "zh"), "写入文件 plan.md");
  assert.ok(!activityPhrase("write_file", { path: "notes/plan.md", content: "secret" }, "zh").includes("secret"));
});

test("browser tools show the hostname only, and the action kind", () => {
  const url = "https://user:pw@shop.example.com:8443/orders/42?token=abc&q=private#frag";
  assert.equal(safeDetailOf("browser_open", { url }), "shop.example.com");
  const line = activityPhrase("browser_open", { url }, "en");
  assert.equal(line, "opening shop.example.com");
  for (const leak of ["/orders", "token=", "abc", "private", "user:pw", "8443", "#frag"]) {
    assert.ok(!line.includes(leak), `${leak} leaked into ${line}`);
  }
  assert.equal(activityPhrase("WebFetch", { url: "http://docs.example.org/a/b?c=d" }, "zh"), "抓取网页 docs.example.org");
  assert.equal(activityPhrase("browser_open", { url: "not a url" }, "en"), "opening");
  assert.equal(activityPhrase("browser_act", { action: "click", ref: "e12", find: "the login button" }, "en"), "acting on the page (click)");
  assert.equal(activityPhrase("browser_act", { action: "type", ref: "e3", text: "hunter2" }, "zh"), "操作网页(type)");
  assert.ok(!activityPhrase("browser_act", { action: "type", ref: "e3", text: "hunter2" }, "en").includes("hunter2"));
});

test("Fork counts the briefs; SetTodos counts the items; the desktop names its action kinds", () => {
  assert.equal(activityPhrase("Fork", { briefs: ["a", "b", "c"] }, "zh"), "派出 3 个子任务");
  assert.equal(activityPhrase("Fork", { briefs: ["a", "b"] }, "en"), "sending out 2 subtasks");
  assert.equal(activityPhrase("SetTodos", { items: [{ text: "x" }, { text: "y" }] }, "en"), "updating the to-do list (2)");
  assert.equal(
    activityPhrase("computer", { actions: [{ action: "click", x: 1, y: 2 }, { action: "type", text: "pw" }, { action: "click" }] }, "en"),
    "using the desktop (click, type)"
  );
});

test("MCP and extension tools get a generic phrase with the tool's display name", () => {
  assert.equal(activityPhrase("linear__create_issue", { title: "x" }, "en"), "using create_issue on linear");
  assert.equal(activityPhrase("linear__create_issue", {}, "zh"), "使用 linear 的 create_issue");
  assert.equal(activityPhrase("SomethingNew", {}, "en"), "using SomethingNew");
});

test("the quiet tools have sensible phrases", () => {
  assert.equal(activityPhrase("NothingToSay", {}, "zh"), "无需回复");
  assert.equal(activityPhrase("RememberFact", { fact: "the boss likes tea" }, "en"), "remembering a fact");
  assert.equal(activityPhrase("Checkpoint", {}, "zh"), "保存进度点");
  assert.equal(activityPhrase("connector_request", { connector: "github", method: "post", path: "/repos" }, "en"), "calling github POST");
});

test("both languages at once, for the stored event", () => {
  assert.deepEqual(activityPhrases("bash", { command: "npm test" }), { en: "running a command (npm)", zh: "运行命令(npm)" });
});
