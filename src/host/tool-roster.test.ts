/** The tool roster (INV-1341): what rides in the list, what waits in the catalog, and that nothing is lost on the way. */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PolicyGate } from "./policy.ts";
import { Claims } from "./claims.ts";
import { declaredTools } from "./side-effects.ts";
import { describeDeferred, lookupPair, RESIDENT_TOOLS, splitRoster } from "./tool-roster.ts";
import { buildTools, dispatchTool } from "./tools.ts";

const everything = buildTools(true, true, undefined, true, true, true, true, false, ["feishu", "dingtalk"]);

test("with every flag on, the list a model sees is at most 30 definitions, and every built-in is either resident or deferred — none dropped", () => {
  // The two lists a turn can be given (turn.ts): one a person is waiting on is never offered silence; one nobody is waiting on
  // is, and there Tell — the other tool that decides what reaches a person — waits behind the pair (INV-1853).
  const waited = everything.filter(tool => tool.name !== "NothingToSay");
  for (const [turn, list, unwaited] of [["a person is waiting on", waited, false], ["nobody is waiting on", everything, true]] as const) {
    const { resident, deferred } = splitRoster(list, unwaited);
    const sent = [...resident, ...lookupPair(0, deferred)];
    assert.ok(sent.length <= 30, `${sent.length} tools sent on a turn ${turn}`);
    assert.equal(resident.some(tool => tool.name === "Tell"), !unwaited, `Tell is ${unwaited ? "behind the pair" : "in the list"} on a turn ${turn}`);
    assert.equal(resident.length + deferred.length, list.length);
    assert.deepEqual(new Set([...resident, ...deferred].map(tool => tool.name)), new Set(list.map(tool => tool.name)));
    for (const tool of deferred) assert.ok(declaredTools().includes(tool.name), `${tool.name} keeps its tier`);
    assert.ok(deferred.length > 0 && deferred.every(tool => !RESIDENT_TOOLS.has(tool.name) || (unwaited && tool.name === "Tell")));
  }
  const offered = new Set(everything.map(tool => tool.name));
  for (const name of RESIDENT_TOOLS) assert.ok(offered.has(name) || declaredTools().includes(name), `${name} is a real tool`);
});

test("a list already within budget is sent whole: a narrowed verifier keeps its four tools and gets no pair", () => {
  const four = everything.filter(tool => ["ReadKept", "bash", "list_dir", "read_file"].includes(tool.name));
  const { resident, deferred } = splitRoster(four);
  assert.equal(resident.length, 4);
  assert.deepEqual(deferred, []);
  assert.deepEqual(lookupPair(0, deferred), []);
});

test("the resident set keeps what is used, what faces the person, and the credential door; the deferred set has the once-a-month names", () => {
  for (const name of ["bash", "read_file", "edit_file", "AskUser", "NothingToSay", "RunOnHost", "browser_act", "FeishuWrite"]) assert.ok(RESIDENT_TOOLS.has(name), name);
  const deferred = splitRoster(everything).deferred.map(tool => tool.name);
  for (const name of ["PackTemplate", "CreateAgent", "UpdateAgent", "Forget", "NoteSiteLearning", "browser_upload", "ClaimWork"]) assert.ok(deferred.includes(name), name);
});

test("the pair is offered only when something is behind it, and says what: externals over budget, built-ins by name", () => {
  assert.deepEqual(lookupPair(0, []), []);
  const { deferred } = splitRoster(everything);
  const pair = lookupPair(0, deferred);
  assert.deepEqual(pair.map(tool => tool.name), ["FindMcpTool", "UseMcpTool"]);
  assert.match(pair[0]!.description ?? "", /less-used built-in tools \(.*PackTemplate.*\) are behind this pair/);
  assert.doesNotMatch(pair[0]!.description ?? "", /external services are available/);
  assert.match(lookupPair(40, [])[0]!.description ?? "", /^40 tools from connected external services/);
});

test("the deferred catalog reads like the external one: a heading with a count, one line per tool, the full schema for one named tool, nothing for a server that is not built-in", () => {
  const { deferred } = splitRoster(everything);
  const all = describeDeferred(deferred)!;
  assert.match(all, /^## built-in \(\d+\)\n- /);
  assert.ok(all.split("\n").length === deferred.length + 1);
  assert.match(describeDeferred(deferred, { pattern: "template" })!, /PackTemplate/);
  assert.doesNotMatch(describeDeferred(deferred, { pattern: "template" })!, /\bForget\b/);
  assert.equal(describeDeferred(deferred, { server: "fixture" }), undefined);
  assert.match(describeDeferred(deferred, { server: "built-in" })!, /^## built-in/);
  const one = describeDeferred(deferred, { tool: "PackTemplate" })!;
  assert.match(one, /^PackTemplate\n/);
  assert.match(one, /input schema:\n\{/);
  assert.match(one, /Call it with UseMcpTool/);
  assert.equal(describeDeferred(deferred, { tool: "bash" }), undefined, "a resident tool is not in the catalog");
  assert.equal(describeDeferred([], {}), undefined);
});

test("a deferred built-in called through UseMcpTool is gated and dispatched as itself: the policy sees the inner name, and a rule on it is not escaped by the wrapper", async () => {
  const checked: string[] = [];
  const { deferred } = splitRoster(everything);
  const context = {
    agent: { id: "a1", profile: { name: "Ada" } },
    registry: {} as never,
    bus: {} as never,
    box: undefined,
    deferredTools: deferred,
    policy: { check: (request: { tool: string }) => { checked.push(request.tool); return request.tool === "PackTemplate" ? { allow: false, reason: "PackTemplate is refused by rule" } : { allow: true }; } },
  } as unknown as Parameters<typeof dispatchTool>[2];
  const refused = await dispatchTool("UseMcpTool", { tool: "PackTemplate", arguments: {} }, context);
  assert.equal(refused.isError, true);
  assert.match(refused.text, /PackTemplate is refused by rule/);
  assert.deepEqual(checked, ["PackTemplate"], "the target is gated exactly once");
  const found = await dispatchTool("FindMcpTool", { tool: "PackTemplate" }, context);
  assert.match(found.text, /^PackTemplate\n/, "found without any external service connected");
  const missing = await dispatchTool("UseMcpTool", { tool: "bash" }, context);
  assert.equal(missing.isError, true, "a resident tool is not reachable through the pair; it is in the list");
});

test("UseMcpTool keeps task autonomy on the target: L4 coordination and L2 observation need no approval; external calls still ask (INV-1992)", async t => {
  const dir = mkdtempSync(join(tmpdir(), "deferred-policy-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const gate = new PolicyGate({ path: join(dir, "policy.jsonl"), limits: { budgetWindowHours: 24, wakesPerWindow: 30, wakeWindowMinutes: 10, approvalRequiredTools: [], approvalRequiredCommands: [] } });
  let level: 2 | 4 = 4;
  let externalCalls = 0;
  const context = {
    agent: { id: "a1", profile: { name: "Ada" } },
    registry: { teammates: () => [], list: () => [] }, bus: {}, box: undefined,
    deferredTools: everything.filter(tool => ["ClaimWork", "Fork", "Teammates"].includes(tool.name)),
    claims: new Claims(null), policy: gate,
    taskBinding: { taskId: "t1" }, tasks: { forAgent: () => [{ id: "t1", status: "doing", level }] },
    mcp: { owns: (name: string) => name === "server__tool", callDetailed: async () => { externalCalls++; return { text: "sent" }; } },
  } as unknown as Parameters<typeof dispatchTool>[2];
  const call = (tool: string, args = {}) => dispatchTool("UseMcpTool", { tool, arguments: args }, context);
  assert.match((await call("ClaimWork", { work: "Fix the parser" })).text, /Claimed/);
  assert.match((await call("Fork")).text, /at least one brief/, "the call reaches Fork's own input validation");
  assert.equal((await call("Teammates")).isError, undefined);
  assert.equal(gate.pending().length, 0);
  level = 2;
  assert.equal((await call("Teammates")).isError, undefined);
  assert.equal(gate.pending().length, 0);
  level = 4;
  const args = { command: "send", recipient: "Ada", why: "first payload" };
  const external = await call("server__tool", args);
  assert.ok(external.approval);
  assert.equal(externalCalls, 0);
  assert.equal(gate.pending().length, 1);
  assert.match(gate.pending()[0]!.description, /server__tool/);
  gate.grant(external.approval.id);
  for (const changed of [{ ...args, recipient: "Rex" }, { ...args, why: "different payload" }]) {
    const refused = await call("server__tool", changed);
    assert.ok(refused.approval, "the grant cannot authorize changed non-command arguments, including why");
    assert.notEqual(refused.approval.id, external.approval.id);
    assert.equal(externalCalls, 0);
  }
  assert.equal((await call("server__tool", args)).text, "sent");
  assert.equal(externalCalls, 1, "the full original arguments remain approved");
  assert.equal((await call("server__forged")).isError, true);
  assert.equal((await call("")).isError, true);
});
