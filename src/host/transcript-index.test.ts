/**
 * The installation's transcript index (INV-1751): what it finds, for whom, and what it says when
 * it could not look everywhere. Every fixture is a temporary home; nothing reads ~/.agentbox.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AgentRegistry } from "../agents/registry.ts";
import { readEpochHistory } from "./history.ts";
import { searchHistoryTool } from "./search-history-tool.ts";
import { TRANSCRIPT_INDEX_FILENAME, TranscriptIndex, piecesOf, transcriptIndexFor } from "./transcript-index.ts";

const at = (minute: number) => new Date(Date.UTC(2026, 10, 20, 9, minute)).toISOString();
const person = (text: string, minute = 0) => ({ role: "user", text, at: at(minute), fromPerson: true, turnId: `t${minute}` });
const said = (text: string, minute = 0) => ({ role: "assistant", text, at: at(minute) });

/** Two boxes: Nova and Ada share the own box; Rex lives in another. */
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "inv1751-index-"));
  const registry = new AgentRegistry(join(home, "agents"));
  const other = registry.attachBox({ id: "box-other", name: "other", kind: "attached", displayFloor: 10, workDir: "/home/box/work", members: "everyone", createdAt: at(0) } as never);
  const nova = registry.create({ name: "Nova", boxId: registry.box.id });
  const ada = registry.create({ name: "Ada", boxId: registry.box.id });
  const rex = registry.create({ name: "Rex", boxId: other.id });
  const index = (options: ConstructorParameters<typeof TranscriptIndex>[1] = {}) => new TranscriptIndex(join(registry.root, TRANSCRIPT_INDEX_FILENAME), options);
  const sameBox = (reader: string) => (id: string) => registry.sameBox(reader, id);
  return { home, registry, nova, ada, rex, index, sameBox, done: () => rmSync(home, { recursive: true, force: true }) };
}

test("each piece says whose words it is, by the channel table: the person, the member, a teammate, the host, a tool", () => {
  assert.deepEqual(piecesOf(person("ship it on Thursday")).map(p => [p.role, p.kind]), [["person", "message"]]);
  assert.deepEqual(piecesOf({ role: "user", text: "ship it", at: at(0) }).map(p => [p.role, p.kind]), [["host", "notice"]], "never recorded as a person's: the host's");
  assert.deepEqual(piecesOf({ role: "user", text: "[first run] say hello", at: at(0), fromPerson: true }).map(p => p.role), ["host"], "a cue stamped as a person's is still a cue");
  assert.deepEqual(piecesOf({ role: "user", text: "[agent] A message arrived from your teammate Ada: done", at: at(0) }).map(p => p.role), ["teammate"]);
  const mixed = piecesOf(person("check the export\n\n---\n\n[agent] A message arrived from your teammate Ada: it landed"));
  assert.deepEqual(mixed.map(p => [p.role, p.text.slice(0, 16)]), [["person", "check the export"], ["teammate", "[agent] A messag"]], "a teammate's lines after the wake boundary are not the person's");
  assert.deepEqual(piecesOf(person("hello\n<system_reminder>\n- use tools\n</system_reminder>")).map(p => [p.role, p.kind]), [["host", "reminder"], ["person", "message"]]);
  const blocks = [{ type: "text", text: "looking" }, { type: "tool_use", id: "u1", name: "bash", input: { command: "ls" } }];
  assert.deepEqual(piecesOf({ role: "assistant", kind: "blocks", at: at(0), blocks }).map(p => [p.role, p.kind]), [["member", "message"], ["member", "call"]]);
  assert.deepEqual(piecesOf({ role: "user", kind: "results", at: at(0), blocks: [{ type: "tool_result", tool_use_id: "u1", content: "a.txt" }] }).map(p => [p.role, p.kind]), [["tool", "result"]]);
  assert.deepEqual(piecesOf({ role: "user", kind: "summary", covers: 3, text: "earlier", at: at(0) }).map(p => [p.role, p.kind]), [["host", "summary"]]);
  assert.deepEqual(piecesOf({ role: "assistant", text: "(no reply)", at: at(0), host: true }).map(p => p.role), ["host"]);
});

test("a search finds every agent's conversations the reader may read, newest first, with anchors ReadHistory reads back", () => {
  const f = fixture();
  try {
    f.registry.appendTranscript(f.nova.id, person("we picked the blue logo", 1));
    f.registry.appendTranscript(f.ada.id, person("blue logo for the invoice too", 2), "feishu-oc_1");
    f.registry.appendTranscript(f.rex.id, person("the blue logo is wrong", 3));
    // A work thread is a projection of entries whose canonical copy is above: indexed once, not twice.
    f.registry.appendTranscript(f.nova.id, person("we picked the blue logo", 1), `work-${"a".repeat(32)}`);
    // A conversation started over with /new: its anchors name the version.
    f.registry.contextStore(f.ada.id, "feishu-oc_1").advance("new", 0);
    f.registry.appendTranscript(f.ada.id, said("blue logo, final answer", 4), "feishu-oc_1");
    const index = f.index();
    const found = index.search(f.registry, f.sameBox(f.nova.id), { words: "BLUE logo" });
    assert.deepEqual(found.hits.map(hit => [hit.agent, hit.conversation, hit.anchor, hit.role]), [
      ["Ada", "feishu-oc_1", "e1#0", "member"],
      ["Ada", "feishu-oc_1", "e0#0", "person"],
      ["Nova", "main", "#0", "person"],
    ], "Rex is in another box");
    assert.equal(found.incomplete, undefined);
    for (const hit of found.hits) {
      const back = readEpochHistory(f.registry.readContextTranscriptsByEpoch(hit.agentId, hit.conversation), { around: hit.anchor });
      assert.ok(back.lines.some(line => line.startsWith(`${hit.anchor} `) && line.toLowerCase().includes("blue logo")), `${hit.anchor} reads back`);
    }
    assert.equal(f.index().search(f.registry, f.sameBox(f.rex.id), { words: "blue logo" }).hits.map(hit => hit.agent).join(), "Rex", "and Rex sees only his own box");
    assert.deepEqual(index.search(f.registry, () => true, { words: "logo", agents: [f.rex.id] }).hits.map(hit => hit.agent), ["Rex"], "a person who may read every box, narrowed to one agent");
    assert.equal(index.search(f.registry, () => true, { regex: "blue\\s+logo\\s+is" }).hits[0]?.agent, "Rex", "a regular expression");
    assert.equal(index.search(f.registry, () => true, { words: "logo", since: new Date(at(3)) }).hits.length, 2);
    assert.equal(index.search(f.registry, () => true, { regex: "(" }).problem?.code, "regex");
    index.close();
  } finally {
    f.done();
  }
});

test("what LumenBox wrote into a conversation is hidden unless its kind is named", () => {
  const f = fixture();
  try {
    f.registry.appendTranscript(f.nova.id, { role: "user", text: "[from the host (host:jobs), not from a person] export finished", at: at(1), host: true });
    f.registry.appendTranscript(f.nova.id, { role: "user", kind: "summary", covers: 4, text: "the export finished earlier", at: at(2) });
    f.registry.appendTranscript(f.nova.id, person("did the export finish?\n<system_reminder>\n- check the export\n</system_reminder>", 3));
    const index = f.index();
    const kinds = (query: Parameters<TranscriptIndex["search"]>[2]) => index.search(f.registry, () => true, query).hits.map(hit => hit.kind).sort();
    assert.deepEqual(kinds({ words: "export" }), ["message"]);
    assert.deepEqual(kinds({ words: "export", kinds: ["notice", "summary", "reminder"] }), ["notice", "reminder", "summary"]);
    index.close();
  } finally {
    f.done();
  }
});

test("a secret does not come back out: not in a snippet, not in the index file", () => {
  const f = fixture();
  const held = new Map([["vault:deploy", "hunter2-hunter2-hunter2"]]);
  try {
    f.registry.appendTranscript(f.nova.id, person("the deploy password is hunter2-hunter2-hunter2 and the key sk-abcdefghijklmnopqrstuvwxyz0123", 1));
    const index = f.index({ held: () => held });
    const hit = index.search(f.registry, () => true, { words: "deploy password" }).hits[0]!;
    assert.match(hit.snippet, /<redacted:vault:deploy>/);
    assert.match(hit.snippet, /<redacted:openai-anthropic>/);
    assert.doesNotMatch(hit.snippet, /hunter2|sk-abcdef/);
    assert.equal(index.search(f.registry, () => true, { words: "hunter2" }).hits.length, 0, "and it cannot be searched for");
    index.close();
    const bytes = readFileSync(join(f.registry.root, TRANSCRIPT_INDEX_FILENAME));
    assert.equal(bytes.includes("hunter2-hunter2"), false);
  } finally {
    f.done();
  }
});

test("the index catches up from where it was, reads only whole lines, and is rebuilt when it is another version's", () => {
  const f = fixture();
  try {
    f.registry.appendTranscript(f.nova.id, person("first note about apples", 1));
    const index = f.index();
    assert.equal(index.search(f.registry, () => true, { words: "apples" }).hits.length, 1);
    f.registry.appendTranscript(f.nova.id, said("second note about apples", 2));
    const path = f.registry.transcriptPathFor(f.nova.id);
    // A line still being written is not an entry yet, and does not take a number.
    appendFileSync(path, JSON.stringify(said("third note about apples", 3)).slice(0, 30));
    assert.deepEqual(index.search(f.registry, () => true, { words: "apples" }).hits.map(hit => hit.anchor), ["#1", "#0"]);
    appendFileSync(path, `${JSON.stringify(said("third note about apples", 3)).slice(30)}\n`);
    assert.deepEqual(index.search(f.registry, () => true, { words: "apples" }).hits.map(hit => hit.anchor), ["#2", "#1", "#0"]);
    assert.ok(index.size() > 0);
    index.close();

    const db = new DatabaseSync(join(f.registry.root, TRANSCRIPT_INDEX_FILENAME));
    db.exec("UPDATE meta SET value = '0' WHERE key = 'version'; DELETE FROM docs;");
    db.close();
    const rebuilt = f.index();
    assert.equal(rebuilt.search(f.registry, () => true, { words: "apples" }).hits.length, 3, "an index of another version is thrown away, not trusted");
    rebuilt.close();
  } finally {
    f.done();
  }
});

test("a large history is indexed within the budget across searches, says it is incomplete until then, and a file appended meanwhile keeps its numbering", () => {
  const f = fixture();
  try {
    for (let i = 0; i < 400; i += 1) f.registry.appendTranscript(f.ada.id, said(`routine status line ${i} ${"padding ".repeat(20)}`, i % 60));
    f.registry.appendTranscript(f.ada.id, person("the decision: move the launch to March", 59));
    let clock = 0;
    // Every look at the clock costs a millisecond: a budget of 40 is about forty steps.
    const index = f.index({ now: () => (clock += 1), chunkBytes: 2_048 });
    const first = index.search(f.registry, () => true, { words: "launch March", budgetMs: 40 });
    assert.equal(first.hits.length, 0);
    assert.ok((first.incomplete?.behind ?? 0) > 0, "it says files are not indexed yet");
    f.registry.appendTranscript(f.ada.id, said("noted: launch in March", 59));
    let result = first;
    for (let round = 0; round < 200 && result.incomplete !== undefined; round += 1) result = index.search(f.registry, () => true, { words: "launch March", budgetMs: 40 });
    assert.equal(result.incomplete, undefined, "it finishes");
    assert.deepEqual(result.hits.map(hit => hit.anchor).sort(), ["#400", "#401"], "the entry written while it was catching up is #401, as ReadHistory counts it");

    // A regular expression reads rows newest first and stops at the budget, saying how far back it got.
    const scan = index.search(f.registry, () => true, { regex: "status line 0 ", budgetMs: 1 });
    assert.ok(scan.incomplete?.reached !== undefined, "it says how far back it got");
    index.close();
  } finally {
    f.done();
  }
});

test("SearchHistory searches the member's own box, leaves its current conversation out, and names the anchor to read", () => {
  const f = fixture();
  try {
    f.registry.appendTranscript(f.nova.id, person("the vendor is Acme Corp", 1));
    f.registry.appendTranscript(f.nova.id, person("we chose Acme Corp yesterday", 2), "feishu-oc_9");
    f.registry.appendTranscript(f.ada.id, said("Acme Corp sent the contract", 3));
    f.registry.appendTranscript(f.rex.id, said("Acme Corp called", 4));
    const context = { agent: f.nova, registry: f.registry, conversation: "main" };
    const text = searchHistoryTool(context, { words: "acme corp" }).text;
    assert.match(text, /Ada · main #0 · .* · Ada: Acme Corp sent the contract/);
    assert.match(text, /you · feishu-oc_9 #0 · .* · the person: we chose Acme Corp yesterday/);
    assert.doesNotMatch(text, /the vendor is Acme/, "its current conversation is left out");
    assert.doesNotMatch(text, /Acme Corp called/, "another box's agent is not searched");
    assert.match(searchHistoryTool(context, { words: "acme", agent: "Rex" }).text, /no agent "Rex"/);
    assert.match(searchHistoryTool(context, { words: "acme", kinds: "secrets" }).text, /unknown kind secrets/);
    assert.match(searchHistoryTool({ ...context, side: true }, { words: "acme" }).text, /refused/);
    transcriptIndexFor(f.registry).close();
  } finally {
    f.done();
  }
});

test("the page's search is the same index, read as a person who may read some boxes", async () => {
  const { historySearchRoute } = await import("../web/history-search-routes.ts");
  const f = fixture();
  try {
    f.registry.appendTranscript(f.ada.id, person("invoice 4411 is paid", 1));
    f.registry.appendTranscript(f.rex.id, person("invoice 4411 is late", 2));
    const ask = (query: string, mayRead: (id: string) => boolean = id => f.registry.boxOf(id).id === f.registry.box.id) =>
      historySearchRoute("GET /api/history/search", new URL(`http://x/api/history/search?${query}`), { registry: f.registry, mayReadAgent: mayRead, held: () => new Map() })!;
    const found = ask("q=invoice%204411").body as { hits: { agent: string; role: string; anchor: string }[] };
    assert.deepEqual(found.hits.map(hit => [hit.agent, hit.role, hit.anchor]), [["Ada", "person", "#0"]], "a box the person is not a member of is not searched");
    assert.equal((ask("q=invoice", () => true).body as { hits: unknown[] }).hits.length, 2);
    assert.equal((ask("since=yesterday&q=x").body as { code: string }).code, "history-search-since");
    assert.equal((ask("regex=(").body as { code: string }).code, "history-search-regex");
    assert.equal(ask("").status, 400);
    assert.equal(historySearchRoute("GET /api/other", new URL("http://x/"), { registry: f.registry, mayReadAgent: () => true, held: () => new Map() }), undefined);
    transcriptIndexFor(f.registry).close();
  } finally {
    f.done();
  }
});
