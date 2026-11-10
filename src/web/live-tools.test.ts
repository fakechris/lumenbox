import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { APP_PAGE } from "./page-locale.ts";
import { toDisplayEntries } from "./transcript.ts";

/** Execute the page's actual event handler; observe the same work rows the renderer receives. */
function page() {
  const html = APP_PAGE("en");
  const handler = html.slice(html.indexOf("stream.onmessage = function"), html.indexOf("stream.onerror"));
  const helpers = /\/\* Live tool calls \*\/([\s\S]+?)\/\* End live tool calls \*\//.exec(html)?.[1] ?? "";
  const scope = {
    stream: {} as { onmessage: (raw: { data: string }) => void },
    current: "a", currentConversation: "main", openAgent: null, openWork: null,
    openCall: new Map(), thread: [] as { kind: string; done?: boolean; calls: { result: string; isError?: boolean }[] }[],
    inView(e: { agentId: string; conversation?: string }) { return e.agentId === scope.current && (e.conversation || "main") === scope.currentConversation; },
    activityLine: () => null, toolDetail: (_: string, input: unknown) => JSON.stringify(input),
    markViewed: () => {}, requestAnimationFrame: () => {},
    $: () => ({ style: {} }), busy: new Set(), live: new Map(),
    closeOpen: () => { if (scope.openWork) (scope.openWork as { done: boolean }).done = true; },
    dropWorking: () => {}, renderAgents: () => {}, refresh: () => {},
    redrawItem: () => {}, pushItem: (item: never) => { scope.thread.push(item); return item; },
  };
  const replay = html.slice(html.indexOf("function replayEntry("), html.indexOf("function agentById("));
  runInNewContext(helpers + replay + handler, scope);
  return { scope, event: (event: object) => scope.stream.onmessage({ data: JSON.stringify(event) }),
    begin: () => runInNewContext("beginLiveReplay()", scope),
    replay: (entries: unknown[]) => { for (const entry of entries) runInNewContext("replayEntry(current, " + JSON.stringify(entry) + ", 0, false)", scope); },
    finish: () => runInNewContext("finishLiveReplay(liveReplay)", scope),
  };
}

test("background conversation completion does not consume the foreground tool result (INV-1784)", () => {
  const { scope, event } = page();
  event({ type: "tool_start", agentId: "a", conversation: "main", turnId: "t", toolUseId: "main-call", tool: "read_file", input: {} });
  event({ type: "tool_start", agentId: "a", conversation: "fork/1", turnId: "f", toolUseId: "child-call", tool: "read_file", input: {} });
  event({ type: "tool_end", agentId: "a", conversation: "fork/1", turnId: "f", toolUseId: "child-call", summary: "child result" });
  event({ type: "tool_end", agentId: "a", conversation: "main", turnId: "t", toolUseId: "main-call", summary: "main result" });
  assert.equal(scope.thread[0]!.calls[0]!.result, "main result");
});

test("history loading preserves tools before the following final answer", () => {
  const view = page(); view.begin();
  const base = { agentId: "a", turnId: "t", toolUseId: "c", tool: "read_file" };
  view.event({ ...base, type: "tool_start", input: {} });
  view.event({ ...base, type: "tool_end", summary: "checked" });
  view.event({ type: "text", agentId: "a", delta: "Final answer" });
  view.finish();
  assert.deepEqual(Array.from(view.scope.thread, x => x.kind), ["work", "agent"]);
  assert.equal(view.scope.thread[0]!.done, true);
});

test("turn completion during history loading closes the buffered work", () => {
  const view = page(); view.begin();
  const base = { agentId: "a", turnId: "t", toolUseId: "c", tool: "read_file" };
  view.event({ ...base, type: "tool_start", input: {} });
  view.event({ ...base, type: "tool_end", summary: "checked" });
  view.event({ type: "turn_finished", agentId: "a" });
  view.finish();
  assert.equal(view.scope.thread[0]!.done, true);
});

test("same-name concurrent calls settle in reverse order, once each and only in their turn", () => {
  const { scope, event } = page();
  const base = { agentId: "a", conversation: "main", turnId: "t", tool: "read_file" };
  for (const id of ["one", "two"]) event({ ...base, type: "tool_start", toolUseId: id, input: { path: id } });
  event({ ...base, type: "tool_start", toolUseId: "one", input: { path: "one" } });
  event({ ...base, type: "tool_end", turnId: "another", toolUseId: "one", summary: "wrong turn" });
  event({ ...base, type: "tool_end", toolUseId: "two", summary: "second", isError: true });
  event({ ...base, type: "tool_end", toolUseId: "one", summary: "first" });
  event({ ...base, type: "tool_end", toolUseId: "two", summary: "duplicate" });
  assert.deepEqual(Array.from(scope.thread[0]!.calls, c => c.result), ["first", "second"]);
  assert.equal(scope.thread[0]!.calls[1]!.isError, true);
});

test("switching threads and returning mid-call joins the result to the replayed pending call", () => {
  const view = page(), base = { agentId: "a", conversation: "main", turnId: "t", toolUseId: "pending", tool: "read_file" };
  view.begin();
  view.scope.currentConversation = "fork/1";
  view.event({ ...base, type: "tool_end", summary: "not for this view" });
  view.scope.currentConversation = "main";
  view.event({ ...base, type: "tool_start", input: { path: "notes" } });
  view.event({ ...base, type: "tool_end", summary: "notes result" });
  const history = toDisplayEntries([{ kind: "blocks", turnId: "t", blocks: [{ type: "tool_use", id: "pending", name: "read_file", input: { path: "notes" } }] }], []);
  view.replay(history);
  view.finish();
  assert.equal(view.scope.thread[0]!.calls.length, 1);
  assert.equal(view.scope.thread[0]!.calls[0]!.result, "notes result");
});

test("a replayed complete result is not shortened by a buffered duplicate end", () => {
  const view = page(); view.begin();
  view.event({ type: "tool_end", agentId: "a", turnId: "t", toolUseId: "c", summary: "short" });
  view.replay(toDisplayEntries([
    { kind: "blocks", turnId: "t", blocks: [{ type: "tool_use", id: "c", name: "read_file", input: {} }] },
    { kind: "results", turnId: "t", blocks: [{ type: "tool_result", tool_use_id: "c", content: "full result from disk" }] },
  ], [])); view.finish();
  assert.equal(view.scope.thread[0]!.calls[0]!.result, "full result from disk");
});

test("legacy events cannot guess their result into an identified call", () => {
  const { scope, event } = page();
  event({ type: "tool_start", agentId: "a", tool: "read_file", input: {}, turnId: "t", toolUseId: "c" });
  event({ type: "tool_start", agentId: "a", tool: "read_file", input: {} });
  event({ type: "tool_end", agentId: "a", tool: "read_file", summary: "ambiguous old result" });
  assert.equal(scope.thread[0]!.calls[0]!.result, undefined);
  assert.match(scope.thread[0]!.calls[1]!.result, /reopen history/);
  event({ type: "tool_end", agentId: "a", turnId: "t", toolUseId: "c", summary: "identified result" });
  assert.equal(scope.thread[0]!.calls[0]!.result, "identified result");
});

test("snapshot text watermarks remove overlapping deltas, while identical prose in another invocation survives", () => {
  const view = page(); view.begin();
  view.event({ type: "text", agentId: "a", executionId: "first", textStart: 0, textEnd: 12, delta: "Final answer" });
  view.replay([{ kind: "text", role: "assistant", executionId: "first", textThrough: 12, text: "Final answer" }]);
  view.finish();
  assert.equal(view.scope.thread.length, 1);
  view.event({ type: "text", agentId: "a", executionId: "second", textStart: 0, textEnd: 12, delta: "Final answer" });
  // A completed replay row and a later invocation are separate messages, even with identical words.
  assert.equal(view.scope.thread.length, 2);
});

test("in-place recovery may reuse a logical call, but its invocation result remains separate", () => {
  const { scope, event } = page();
  const call = { agentId: "a", turnId: "same-turn", toolUseId: "same-call", tool: "read_file" };
  event({ ...call, executionId: "first", type: "tool_start", input: {} });
  event({ ...call, executionId: "first", type: "tool_end", summary: "unknown before restart" });
  event({ ...call, executionId: "resumed", type: "tool_start", input: {} });
  event({ ...call, executionId: "resumed", type: "tool_end", summary: "read back confirmed" });
  assert.deepEqual(Array.from(scope.thread[0]!.calls, c => c.result), ["unknown before restart", "read back confirmed"]);
});
