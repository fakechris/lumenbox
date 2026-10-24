/** The tool roster (INV-1341): what rides in the list, what waits in the catalog, and that nothing is lost on the way. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { declaredTools } from "./side-effects.ts";
import { describeDeferred, lookupPair, RESIDENT_TOOLS, splitRoster } from "./tool-roster.ts";
import { buildTools, dispatchTool } from "./tools.ts";

const everything = buildTools(true, true, undefined, true, true, true, true, false, ["feishu", "dingtalk"]);

test("with every flag on, the list a model sees is at most 30 definitions, and every built-in is either resident or deferred — none dropped", () => {
  const { resident, deferred } = splitRoster(everything);
  const sent = [...resident, ...lookupPair(0, deferred)];
  assert.ok(sent.length <= 30, `${sent.length} tools sent`);
  assert.equal(resident.length + deferred.length, everything.length);
  assert.deepEqual(new Set([...resident, ...deferred].map(tool => tool.name)), new Set(everything.map(tool => tool.name)));
  const offered = new Set(everything.map(tool => tool.name));
  for (const name of RESIDENT_TOOLS) assert.ok(offered.has(name) || declaredTools().includes(name), `${name} is a real tool`);
  for (const tool of deferred) assert.ok(declaredTools().includes(tool.name), `${tool.name} keeps its tier`);
  assert.ok(deferred.length > 0 && deferred.every(tool => !RESIDENT_TOOLS.has(tool.name)));
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
  assert.deepEqual(checked, ["UseMcpTool", "PackTemplate"], "the pair, then the tool itself");
  const found = await dispatchTool("FindMcpTool", { tool: "PackTemplate" }, context);
  assert.match(found.text, /^PackTemplate\n/, "found without any external service connected");
  const missing = await dispatchTool("UseMcpTool", { tool: "bash" }, context);
  assert.equal(missing.isError, true, "a resident tool is not reachable through the pair; it is in the list");
});
