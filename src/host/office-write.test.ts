import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkBlocks, dingtalkEventBody, doorIdOf, feishuDocUrl, feishuEventBody, feishuTaskBody, instantOf, markdownToFeishuBlocks } from "./office-write.ts";
import { dispatchTool } from "./tools.ts";

test("markdown becomes the document blocks Feishu documents, one paragraph per block", () => {
  const blocks = markdownToFeishuBlocks("# Q3 report\n\nRevenue grew\n12%.\n\n## Risks\n- churn\n* hiring\n1. first\n> a quote\n\n---\n```ts\nconst x = 1;\n```\nlast line");
  assert.deepEqual(blocks.map(block => block.block_type), [3, 2, 4, 12, 12, 13, 15, 22, 14, 2]);
  assert.deepEqual(blocks[1], { block_type: 2, text: { elements: [{ text_run: { content: "Revenue grew 12%." } }] } }, "lines of one paragraph join; a blank line splits");
  assert.deepEqual(blocks[7], { block_type: 22, divider: {} });
  assert.deepEqual(blocks[8], { block_type: 14, code: { elements: [{ text_run: { content: "const x = 1;" } }], style: { language: 63 } } });
  assert.equal(markdownToFeishuBlocks("#### deep")[0]!.block_type, 5, "deeper headings fold into heading3");
});

test("at most fifty blocks a call, in order", () => {
  const blocks = markdownToFeishuBlocks(Array.from({ length: 120 }, (_, n) => `- item ${n}`).join("\n"));
  const chunks = chunkBlocks(blocks);
  assert.deepEqual(chunks.map(chunk => chunk.length), [50, 50, 20]);
  assert.equal((chunks[2]![19] as { bullet: { elements: { text_run: { content: string } }[] } }).bullet.elements[0]!.text_run.content, "item 119");
});

test("each API gets its own time unit", () => {
  const start = instantOf("2026-10-03 15:00", "Asia/Shanghai")!;
  assert.equal(new Date(start).toISOString(), "2026-10-03T07:00:00.000Z", "a wall time is read in the zone given");
  assert.equal(instantOf("2026-10-03T15:00:00+08:00", "America/New_York"), start, "an explicit offset wins over the zone");
  assert.equal(instantOf("next friday", "UTC"), undefined);
  const event = feishuEventBody({ summary: "Review", startMs: start, endMs: start + 3_600_000, timezone: "Asia/Shanghai" });
  assert.deepEqual(event.start_time, { timestamp: String(start / 1000), timezone: "Asia/Shanghai" }, "calendar: seconds, as a string");
  const task = feishuTaskBody({ summary: "Ship", dueMs: start, assignees: ["ou_b"], followers: ["ou_me", "ou_b"] });
  assert.deepEqual(task.due, { timestamp: String(start), is_all_day: false }, "tasks: milliseconds, as a string");
  assert.deepEqual(task.members, [{ id: "ou_b", type: "user", role: "assignee" }, { id: "ou_me", type: "user", role: "follower" }], "an assignee is not also listed as a follower");
  const ding = dingtalkEventBody({ summary: "Review", startMs: start, endMs: start + 3_600_000, timezone: "Asia/Shanghai", attendees: ["u2"] });
  assert.deepEqual(ding.start, { dateTime: "2026-10-03T07:00:00.000Z", timeZone: "Asia/Shanghai" });
  assert.deepEqual(ding.attendees, [{ id: "u2" }]);
});

test("links and ids come from what is known, never guessed", () => {
  assert.equal(feishuDocUrl("doxA", undefined), undefined, "no tenant domain, no link");
  assert.equal(feishuDocUrl("doxA", "https://acme.feishu.cn/"), "https://acme.feishu.cn/docx/doxA");
  assert.equal(doorIdOf(["telegram:1", "feishu:ou_me"], "feishu"), "ou_me");
  assert.equal(doorIdOf(["telegram:1"], "feishu"), undefined);
});

/** Feishu answering as its docs say: 200 with code 0 and the result under data. */
function feishuStub() {
  const calls: { method: string; url: string; headers: Record<string, string>; body: unknown }[] = [];
  const reply = (url: string): unknown => {
    if (url.endsWith("/docx/v1/documents")) return { code: 0, data: { document: { document_id: "doxAAA", title: "Q3" } } };
    if (url.includes("/drive/v1/permissions/")) return { code: 0, data: { member: {} } };
    if (url.includes("/blocks/")) return { code: 0, data: { children: [] } };
    if (url.endsWith("/calendar/v4/calendars/primary")) return { code: 0, data: { calendars: [{ calendar: { calendar_id: "cal_app" } }] } };
    if (url.includes("/attendees")) return { code: 0, data: {} };
    if (url.includes("/events")) return { code: 0, data: { event: { event_id: "evt1", app_link: "https://applink.feishu.cn/evt1" } } };
    if (url.includes("/task/v2/tasks")) return { code: 0, data: { task: { guid: "t-1", url: "https://applink.feishu.cn/t-1" } } };
    if (url.includes("/oauth2/accessToken")) return {};
    if (url.includes("/calendar/users/")) return { id: "dingEvt" };
    return { code: 0, data: {} };
  };
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    calls.push({ method: init.method, url, headers: init.headers, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    return new Response(JSON.stringify(reply(url)), { status: 200 });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const context = (identities: string[]) => ({
  agent: { id: "a1", profile: { name: "Ada" } },
  registry: {} as never, bus: {} as never, box: undefined,
  oauth: { bearerFor: async () => "tok-secret" },
  callerIdentities: identities,
}) as unknown as Parameters<typeof dispatchTool>[2];

test("doc_create: the document, the person who asked added so they can open it, then the body in order (INV-754)", async () => {
  const stub = feishuStub();
  try {
    const markdown = Array.from({ length: 60 }, (_, n) => `- point ${n}`).join("\n");
    const out = await dispatchTool("FeishuWrite", { action: "doc_create", title: "Q3", markdown }, context(["feishu:ou_me"]));
    assert.ok(!out.isError, out.text);
    assert.deepEqual(stub.calls.map(call => `${call.method} ${new URL(call.url).pathname}`), [
      "POST /open-apis/docx/v1/documents",
      "POST /open-apis/drive/v1/permissions/doxAAA/members",
      "POST /open-apis/docx/v1/documents/doxAAA/blocks/doxAAA/children",
      "POST /open-apis/docx/v1/documents/doxAAA/blocks/doxAAA/children",
    ]);
    assert.deepEqual(stub.calls[1]!.body, { member_type: "openid", member_id: "ou_me", perm: "full_access", type: "user" });
    assert.equal((stub.calls[2]!.body as { children: unknown[] }).children.length, 50);
    assert.equal(stub.calls[0]!.headers.Authorization, "Bearer tok-secret", "the host attaches the token");
    assert.match(out.text, /can open and edit it/);
    assert.match(out.text, /Wrote 60 block/);
    assert.doesNotMatch(out.text, /tok-secret/);
  } finally { stub.restore(); }
});

test("doc_create without knowing who asked says only the app can see it", async () => {
  const stub = feishuStub();
  try {
    const out = await dispatchTool("FeishuWrite", { action: "doc_create", title: "Q3" }, context([]));
    assert.match(out.text, /only the app can see it/);
    assert.equal(stub.calls.length, 1);
  } finally { stub.restore(); }
});

test("calendar_event: the app's calendar, then the person who asked invited so it is on theirs", async () => {
  const stub = feishuStub();
  try {
    const out = await dispatchTool("FeishuWrite", { action: "calendar_event", summary: "Review", start: "2026-10-03 15:00", end: "2026-10-03 16:00", timezone: "Asia/Shanghai" }, context(["feishu:ou_me"]));
    assert.ok(!out.isError, out.text);
    const paths = stub.calls.map(call => new URL(call.url).pathname);
    assert.deepEqual(paths, ["/open-apis/calendar/v4/calendars/primary", "/open-apis/calendar/v4/calendars/cal_app/events", "/open-apis/calendar/v4/calendars/cal_app/events/evt1/attendees"]);
    assert.match(stub.calls[1]!.url, /idempotency_key=[0-9a-f-]{40,}/, "a create carries its own idempotency key");
    assert.deepEqual((stub.calls[2]!.body as { attendees: unknown[] }).attendees, [{ type: "user", user_id: "ou_me" }]);
    assert.match(out.text, /including the person who asked/);
    const bad = await dispatchTool("FeishuWrite", { action: "calendar_event", summary: "x", start: "2026-10-03 16:00", end: "2026-10-03 15:00" }, context([]));
    assert.ok(bad.isError, "an end before its start is refused before any call");
  } finally { stub.restore(); }
});

test("task_create: the person who asked follows it, so they can see it", async () => {
  const stub = feishuStub();
  try {
    const out = await dispatchTool("FeishuWrite", { action: "task_create", summary: "Send the deck", due: "2026-10-03" }, context(["feishu:ou_me"]));
    assert.ok(!out.isError, out.text);
    const body = stub.calls[0]!.body as { members: unknown[]; due: { is_all_day: boolean } };
    assert.deepEqual(body.members, [{ id: "ou_me", type: "user", role: "follower" }]);
    assert.equal(body.due.is_all_day, true, "a date alone is an all-day due");
  } finally { stub.restore(); }
});

test("a Feishu refusal is reported with its code, and nothing after it is attempted", async () => {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    calls.push(url);
    return new Response(JSON.stringify({ code: 1770036, msg: "folder locked" }), { status: 200 });
  }) as typeof fetch;
  try {
    const out = await dispatchTool("FeishuWrite", { action: "doc_create", title: "Q3", markdown: "hello" }, context(["feishu:ou_me"]));
    assert.ok(out.isError);
    assert.match(out.text, /code 1770036.*folder locked/);
    assert.equal(calls.length, 1);
  } finally { globalThis.fetch = original; }
});

test("DingTalk: the token travels in its own header, and the event is on the person's calendar", async () => {
  const stub = feishuStub();
  try {
    const out = await dispatchTool("DingTalkWrite", { action: "calendar_event", summary: "Review", start: "2026-10-03T15:00:00+08:00", end: "2026-10-03T16:00:00+08:00", operator_union_id: "union_me" }, context([]));
    assert.ok(!out.isError, out.text);
    assert.equal(new URL(stub.calls[0]!.url).pathname, "/v1.0/calendar/users/union_me/calendars/primary/events");
    assert.equal(stub.calls[0]!.headers["x-acs-dingtalk-access-token"], "tok-secret");
    assert.equal(stub.calls[0]!.headers.Authorization, undefined);
    const unknown = await dispatchTool("DingTalkWrite", { action: "calendar_event", summary: "x", start: "2026-10-03", end: "2026-10-04" }, context([]));
    assert.match(unknown.text, /unionId/, "without an operator it says whose id it needs");
  } finally { stub.restore(); }
});
