/**
 * The parts that can be wrong quietly.
 *
 * A message that arrives twice and is answered twice, a picture that vanishes on
 * its way to the agent, a push that follows the person instead of the room — none
 * of these throw; they just make the bot look unreliable at random. The mapping and
 * decision functions are tested directly, and `receive` is driven frame by frame
 * through a fake wire, exactly as the socket would deliver.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CARD_CALLBACK_TOPIC,
  CHUNK_CHARS,
  DingTalkChannel,
  approvalPressFrom,
  approvalVarsFor,
  chunkText,
  flattenRichText,
  imageFormatOf,
  freshWebhookOf,
  imSpaceIdFor,
  isContentRefusal,
  markdownTitle,
  mediaOf,
  outboundRoute,
  parseChatKey,
  subscriptionsFor,
  TOPIC,
  taskVarsFor,
  wantsNudge,
  type BotMessage,
} from "./dingtalk.ts";
import { looksLikeMarkdown as fromShared } from "./markdown.ts";
import { looksLikeMarkdown as fromFeishu } from "./feishu.ts";

const TEXT_FRAME = (payload: Partial<BotMessage>): string =>
  JSON.stringify({
    type: "CALLBACK",
    headers: { topic: TOPIC, messageId: "tr-1" },
    data: JSON.stringify(payload),
  });

interface Harness {
  adapter: DingTalkChannel;
  acks: unknown[];
  arrived: { id: string; kind: string }[];
  decided: { id: string; fate: string; reason?: string }[];
  turns: { text: string; files?: { name: string; base64: string }[]; messageId?: string; identity: string; chatKey: string; senderLabel: string }[];
  pushes: { target: unknown; kind: string; body: string; title?: string }[];
}

/** Builds an adapter with every wire touched by receive() faked out. */
function harness(options?: {
  download?: (code: string) => Promise<{ base64?: string }>;
}): Harness {
  const adapter = new DingTalkChannel("ding123", "secret", () => {});
  const state: Harness = {
    adapter,
    acks: [],
    arrived: [],
    decided: [],
    turns: [],
    pushes: [],
  };
  const ingress = {
    arrived: (a: { id: string; kind: string }) => state.arrived.push({ id: a.id, kind: a.kind }),
    decided: (id: string, fate: string, reason?: string) =>
      state.decided.push({ id, fate, ...(reason !== undefined ? { reason } : {}) }),
  };
  (adapter as unknown as { ingress: unknown }).ingress = ingress;
  if (options?.download !== undefined) {
    (adapter as unknown as { downloadResource: unknown }).downloadResource =
      async (code: string) => options.download!(code);
  }
  (adapter as unknown as { transmit: unknown }).transmit = async (
    target: unknown,
    kind: string,
    body: string,
    title?: string
  ) => {
    state.pushes.push({ target, kind, body, ...(title !== undefined ? { title } : {}) });
  };
  return state;
}

function deliver(state: Harness, raw: string, reply = "here is your answer"): Promise<void> {
  return state.adapter.receive(
    raw,
    {
      respond: (_headers, data) => state.acks.push(JSON.parse(data)),
    },
    async inbound => {
      state.turns.push({
        identity: inbound.identity,
        chatKey: inbound.chatKey ?? "",
        senderLabel: inbound.senderLabel,
        text: inbound.text,
        messageId: inbound.messageId,
        files: inbound.files,
      });
      return reply;
    }
  );
}

const GROUP_TEXT: BotMessage = {
  msgtype: "text",
  msgId: "msg-1",
  conversationId: "cid7",
  conversationType: "2",
  senderStaffId: "staff9",
  senderNick: "chris",
  sessionWebhook: "https://oapi.dingtalk.com/robot/sendBySession?s=abc",
  sessionWebhookExpiredTime: Date.now() + 3_600_000,
  text: { content: "hello there" },
};

test("a text frame becomes one turn addressed to its room, replied in kind", async () => {
  const state = harness();
  await deliver(state, TEXT_FRAME(GROUP_TEXT));

  assert.deepEqual(state.acks, [{ response: {} }]);
  assert.equal(state.arrived.length, 1);
  assert.equal(state.arrived[0]!.kind, "text");
  const turn = state.turns[0]!;
  // The person drives (identity); the room receives (chatKey). The two halves are
  // what keeps results going back to the group that asked for them.
  assert.equal(turn.identity, "dingtalk:staff9");
  assert.equal(turn.chatKey, "dingtalk:cid7");
  assert.equal(turn.senderLabel, "chris");
  assert.equal(turn.text, "hello there");
  const push = state.pushes[0]!;
  assert.equal(push.kind, "text");
  assert.equal(push.body, "here is your answer");
  assert.deepEqual((push.target as { conversationId: string }).conversationId, "cid7");
});

test("a redelivered frame is acked but not turned", async () => {
  // Reconnects replay frames under a fresh transport id with the same business id;
  // dedupe keys on the business id or a turn runs twice.
  const state = harness();
  await deliver(state, TEXT_FRAME(GROUP_TEXT));
  await deliver(state, TEXT_FRAME(GROUP_TEXT).replace('"tr-1"', '"tr-2"'));

  assert.deepEqual(state.acks, [{ response: {} }, { response: {} }]);
  assert.equal(state.turns.length, 1);
  assert.match(state.decided.at(-1)!.reason ?? "", /delivered more than once/);
});

test("every system frame is echoed without becoming an arrival", async () => {
  const state = harness();
  await state.adapter.receive(
    JSON.stringify({ type: "SYSTEM", headers: { messageId: "t2" }, data: '{"ping":1}' }),
    { respond: (_h, data) => state.acks.push(JSON.parse(data)) },
    async () => ""
  );
  assert.deepEqual(state.acks, [{ ping: 1 }]);
  assert.equal(state.arrived.length, 0);
});

test("a foreign topic is acknowledged and ignored", async () => {
  const state = harness();
  await deliver(state, TEXT_FRAME({ text: { content: "hi" }, msgId: "m9" }).replace(TOPIC, "/v1.0/other"));
  assert.deepEqual(state.acks, [{}]);
  assert.equal(state.turns.length, 0);
});

test("a file arrives as bytes attached to the turn", async () => {
  const state = harness({
    download: async code =>
      code === "dc-csv"
        ? { base64: Buffer.from("a,b\n1,2").toString("base64") }
        : {},
  });
  await deliver(
    state,
    TEXT_FRAME({
      ...GROUP_TEXT,
      msgtype: "file",
      text: undefined,
      content: { downloadCode: "dc-csv", fileName: "data.csv" },
    })
  );

  const turn = state.turns[0]!;
  assert.equal(turn.files?.length, 1);
  assert.equal(turn.files![0]!.name, "data.csv");
  assert.equal(Buffer.from(turn.files![0]!.base64, "base64").toString(), "a,b\n1,2");
});

test("media that cannot be fetched is reported dropped, not answered empty", async () => {
  const state = harness({ download: async () => ({}) });
  await deliver(
    state,
    TEXT_FRAME({
      ...GROUP_TEXT,
      msgtype: "picture",
      text: undefined,
      content: { downloadCode: "dc-broken" },
    })
  );
  assert.equal(state.turns.length, 0);
  assert.match(state.decided.at(-1)!.reason ?? "", /media could not be fetched/);
});

test("rich text is flattened whole: words and pasted pictures together", async () => {
  const state = harness({
    download: async code => (code === "pic1" ? { base64: Buffer.from("png!").toString("base64") } : {}),
  });
  await deliver(
    state,
    TEXT_FRAME({
      ...GROUP_TEXT,
      msgtype: "richText",
      text: undefined,
      content: {
        richText: [
          [{ type: "text", text: "look at " }, { type: "picture", downloadCode: "pic1" }],
          [{ type: "text", text: "and tell me" }],
        ],
      },
    })
  );

  const turn = state.turns[0]!;
  assert.match(turn.text, /^look at \[image 1\]\nand tell me$/);
  assert.equal(turn.files?.length, 1);
  assert.equal(turn.files![0]!.name, "image-1.png");
});

test("an empty group message stays silent; an empty direct session gets told we are here", async () => {
  const silent = harness();
  await deliver(
    silent,
    TEXT_FRAME({ ...GROUP_TEXT, msgId: "m-e1", text: { content: "" } })
  );
  assert.equal(silent.turns.length, 0);
  assert.match(silent.decided.at(-1)!.reason ?? "", /no usable text/);

  const nudge = harness();
  await deliver(
    nudge,
    TEXT_FRAME({
      ...GROUP_TEXT,
      msgId: "m-e2",
      conversationType: "1",
      senderStaffId: "solo",
      text: { content: "   " },
    })
  );
  assert.equal(nudge.turns.length, 1);
  assert.match(nudge.turns[0]!.text, /I am here/);
});

test("recorded webhooks expire, and expiry sends pushes over the robot api instead", () => {
  const now = 1_000_000;
  assert.equal(freshWebhookOf({ webhook: "https://w", webhookExpiresAt: now + 1 }, now), "https://w");
  // No death observed yet is not dead: the webhook arrived before the expiry did.
  assert.equal(freshWebhookOf({ webhook: "https://w" }, now), "https://w");
  assert.equal(freshWebhookOf({ webhook: "https://w", webhookExpiresAt: now }, now), undefined);
  assert.equal(freshWebhookOf(undefined, now), undefined);
});

test("a markdown refusal degrades that chunk and the rest to plain text", async () => {
  const state = harness();
  let calls = 0;
  (state.adapter as unknown as { transmit: unknown }).transmit = async (
    _target: unknown,
    kind: string,
    body: string
  ) => {
    calls += 1;
    if (calls === 1) throw new Error("400 invalid format");
    state.pushes.push({ target: null, kind, body });
  };
  await state.adapter.sendToChat("dingtalk:cid7", "**bold** plan");

  assert.deepEqual(
    state.pushes.map(push => push.kind),
    ["text"]
  );
  assert.equal(state.pushes[0]!.body, "**bold** plan");
});

test("a delivery failure that is not about formatting is raised, not degraded", async () => {
  const state = harness();
  (state.adapter as unknown as { transmit: unknown }).transmit = async () => {
    throw new Error("500 internal error");
  };
  await assert.rejects(
    () => state.adapter.sendToChat("dingtalk:cid7", "**bold** plan"),
    /internal error/
  );
});

test("long output leaves in order-sized slices that reassemble intact", async () => {
  const state = harness();
  const original = `${"# report\n\n".repeat(360)}done`;
  await state.adapter.sendToChat("dingtalk:cid7", original);
  assert.ok(state.pushes.length >= 2);
  assert.ok(state.pushes.every(push => push.body.length <= CHUNK_CHARS));
  assert.equal(
    state.pushes.map(push => push.body).join(""),
    original,
    "chunks must reassemble to the whole message"
  );
});

test("probe relays why the account cannot be reached, and says nothing when it can", async () => {
  const broken = harness();
  (broken.adapter as unknown as { accessToken: unknown }).accessToken = async () => {
    throw new Error("400 InvalidAuthentication bad secret");
  };
  assert.match((await broken.adapter.probe()) ?? "", /InvalidAuthentication/);

  const healthy = harness();
  (healthy.adapter as unknown as { accessToken: unknown }).accessToken = async () => "tok";
  assert.equal(await healthy.adapter.probe(), undefined);
});

test("routing decisions have one obvious answer each", () => {
  assert.deepEqual(parseChatKey("dingtalk:cid7"), { conversationId: "cid7" });
  assert.deepEqual(parseChatKey("cid7"), { conversationId: "cid7" });
  assert.deepEqual(parseChatKey("dingtalk:"), { conversationId: "" });

  assert.equal(outboundRoute("2"), "group");
  assert.equal(outboundRoute("1"), "direct");
  assert.equal(outboundRoute(undefined), "group");

  assert.equal(wantsNudge({ conversationType: "1" }), true);
  assert.equal(wantsNudge({ conversationType: "2", atUsers: [{}] }), true);
  assert.equal(wantsNudge({ conversationType: "2" }), false);

  assert.deepEqual(chunkText("abcde", 2), ["ab", "cd", "e"]);
  assert.deepEqual(chunkText("", 5), []);

  assert.equal(markdownTitle("\n\n# 标题\n正文"), "# 标题");
  assert.equal(markdownTitle(`${"长".repeat(41)}尾`), `${"长".repeat(39)}…`);
});

test("the media readers agree on what carries bytes", () => {
  assert.deepEqual(mediaOf("picture", { downloadCode: "p" }), [
    { kind: "picture", code: "p" },
  ]);
  assert.deepEqual(mediaOf("file", { downloadCode: "f", fileName: "a.pdf" }), [
    { kind: "file", code: "f", name: "a.pdf" },
  ]);
  assert.deepEqual(mediaOf("text", { }), []);
  // Rich text's pictures belong to flattenRichText; a flat read must not take them.
  assert.deepEqual(mediaOf("richText", {}), []);
  assert.deepEqual(mediaOf("picture", {}), []);
  assert.deepEqual(flattenRichText([[{ type: "text", text: "plain" }]]), {
    text: "plain",
    pictureCodes: [],
  });
  assert.deepEqual(flattenRichText("not an array"), { text: "", pictureCodes: [] });
});

test("refusals about formatting degrade; refusals about delivery do not", () => {
  assert.equal(isContentRefusal(new Error("400 invalid format")), true);
  assert.equal(isContentRefusal(new Error("400 content too long")), true);
  assert.equal(isContentRefusal(new Error("500 internal error")), false);
});

test("one shared markdown verdict across every rendering adapter", () => {
  // Two verdicts drifted once, which rendered the same sentence differently per
  // channel; equality of the functions themselves keeps them incapable of drifting.
  assert.equal(fromShared, fromFeishu);
  assert.equal(typeof fromShared("**b**"), "boolean");
});

test("card buttons subscribe only when a template exists", () => {
  assert.deepEqual(subscriptionsFor(undefined), [{ type: "CALLBACK", topic: TOPIC }]);
  assert.deepEqual(subscriptionsFor(""), [{ type: "CALLBACK", topic: TOPIC }]);
  assert.deepEqual(subscriptionsFor("73370521-7e23-4c8b-9f5f-7fc10a98fbf2.schema"), [
    { type: "CALLBACK", topic: TOPIC },
    { type: "CALLBACK", topic: CARD_CALLBACK_TOPIC },
  ]);
});

test("a card press parses into a decision or refuses to", () => {
  const base = { userId: "staff9", outTrackId: "lumenbox-1-x" };
  assert.equal(approvalPressFrom({ ...base, content: '{"action":"once"}' })?.reply, "once");
  const always = approvalPressFrom({ ...base, content: '{"action":"always"}' });
  assert.equal(always?.reply, "always");
  const deny = approvalPressFrom({ ...base, content: "not json at all" });
  assert.equal(deny, undefined);
  assert.equal(approvalPressFrom({ ...base, content: '{"action":"agree"}' }), undefined);
  assert.equal(approvalPressFrom({ content: '{"action":"once"}' }), undefined,
    "no user id — nobody to attribute the decision to");
  assert.equal(approvalPressFrom({ userId: "s", outTrackId: "", content: '{"action":"deny"}' }),
    undefined, "no instance id — no approval this could answer");
});

test("approval card variables keep the action verbatim and stakes attached", () => {
  const vars = approvalVarsFor({
    approvalId: "appr-9",
    agentName: "Ada",
    description: "curl -X POST https://example.com/export",
    stakes: "Until someone answers, this work is stopped.",
  });
  assert.match(vars.title, /Ada needs your consent/);
  // Verbatim action first; the stakes sentence follows, ours not the agent's.
  assert.match(vars.description, /^curl -X POST https:\/\/example\.com\/export\n\nUntil someone/);
});

test("the same card lands in a group space or a robot space depending on route", () => {
  assert.equal(imSpaceIdFor("group", "cid7"), "dtv1.card//IM_GROUP.cid7");
  assert.equal(imSpaceIdFor("direct", "staff9"), "dtv1.card//IM_ROBOT.staff9");
});

test("button approvals exist only when a card template was configured", async () => {
  const bare = new DingTalkChannel("d1", "s", () => {});
  assert.equal(bare.postApprovalCard, undefined,
    "no template, no buttons — the manager must run its text-verb path");

  const withCards = new DingTalkChannel("d1", "s", () => {}, undefined, "tpl.schema");
  assert.notEqual(withCards.postApprovalCard, undefined);
  // The handler registration path exists on both: it is inert without presses.
  withCards.onApprovalAction(async () => "answered");
});

test("a card press resolves the pending approval and answers in its room", async () => {
  const state = harness();
  (state.adapter as unknown as { cardTemplateId: unknown }).cardTemplateId = "tpl.schema";
  const decisions: { approvalId: string; reply: string; identity: string }[] = [];
  (state.adapter as unknown as { approvalHandler: unknown }).approvalHandler = async (
    press: { approvalId: string; reply: string; identity: string }
  ) => {
    decisions.push(press);
    return `${press.reply} recorded`;
  };

  // Delivery would record the mapping; simulate a live one directly.
  const map = (state.adapter as unknown as { cardApprovals: Map<string, { approvalId: string }> })
    .cardApprovals;
  map.set("lumenbox-1-a", { approvalId: "appr-9" });

  const frame = JSON.stringify({
    userId: "staff9",
    outTrackId: "lumenbox-1-a",
    content: '{"action":"always"}',
    spaceType: "IM_GROUP",
    spaceId: "cid7",
    type: "actionCallback",
  });
  await state.adapter.receive(
    JSON.stringify({
      type: "CALLBACK",
      headers: { topic: CARD_CALLBACK_TOPIC, messageId: "tr-c1" },
      data: frame,
    }),
    { respond: (_h, data) => state.acks.push(JSON.parse(data)) },
    async () => ""
  );

  assert.deepEqual(decisions, [{ approvalId: "appr-9", reply: "always", identity: "dingtalk:staff9" }]);
  // Answered exactly once; a replay of the same press finds nothing waiting.
  await state.adapter.receive(
    JSON.stringify({
      type: "CALLBACK",
      headers: { topic: CARD_CALLBACK_TOPIC, messageId: "tr-c2" },
      data: frame,
    }),
    { respond: (_h, data) => state.acks.push(JSON.parse(data)) },
    async () => ""
  );
  assert.equal(decisions.length, 1);
});

test("one send delivered twice under two msgIds runs once", async () => {
  // The wire mints a fresh msgId when a sender's client retries, so the business-id
  // dedupe passes both frames; the words are what repeat. Observed 0.9s apart.
  const state = harness();
  await deliver(state, TEXT_FRAME({ ...GROUP_TEXT, msgId: "msg-a" }));
  await deliver(state, TEXT_FRAME({ ...GROUP_TEXT, msgId: "msg-b" }).replace('"tr-1"', '"tr-2"'));
  // Whitespace collapses, so a text-vs-richtext pair of the same send meets too.
  await deliver(
    state,
    TEXT_FRAME({ ...GROUP_TEXT, msgId: "msg-c", text: { content: "hello  there\n" } }).replace(
      '"tr-1"',
      '"tr-3"'
    )
  );

  assert.equal(state.turns.length, 1);
  assert.match(state.decided.at(-1)!.reason ?? "", /same words arrived twice/);
});

test("the same words in another room, or after the window, are a new message", async () => {
  const state = harness();
  await deliver(state, TEXT_FRAME({ ...GROUP_TEXT, msgId: "msg-a" }));
  await deliver(
    state,
    TEXT_FRAME({ ...GROUP_TEXT, msgId: "msg-b", conversationId: "cid9" }).replace('"tr-1"', '"tr-2"')
  );
  assert.equal(state.turns.length, 2, "another room saying the same thing is not a duplicate");

  const recent = (state.adapter as unknown as { recentTexts: Map<string, number> }).recentTexts;
  for (const [key, at] of recent) recent.set(key, at - 20_000);
  await deliver(state, TEXT_FRAME({ ...GROUP_TEXT, msgId: "msg-c" }).replace('"tr-1"', '"tr-3"'));
  assert.equal(state.turns.length, 3, "a repeat past the window is somebody saying it again");
});

test("task card variables are the template's whole contract, blanks for what is absent", () => {
  const full = taskVarsFor({
    title: "Draft the plan",
    agentName: "Ada",
    requesterLabel: "chris",
    status: "working",
    action: "bash: npm test",
    ahead: 2,
    taskId: "t70",
    taskUrl: "https://box/tasks/t70",
  });
  assert.equal(full.status, "working");
  assert.equal(full.ahead, "2", "cardParamMap carries strings only");
  assert.equal(full.taskId, "t70");
  assert.equal(full.action, "bash: npm test");
  assert.equal(full.taskUrl, "https://box/tasks/t70");

  const bare = taskVarsFor({ title: "hi", agentName: "", requesterLabel: "x", status: "done" });
  assert.equal(bare.action, "", "absent variables are blanked, not omitted — no stale lines");
  assert.equal(bare.ahead, "");
  assert.equal(bare.taskId, "");
  assert.equal(bare.taskUrl, "");
});

test("task cards exist only when a task template was configured", () => {
  const bare = new DingTalkChannel("d1", "s", () => {});
  assert.equal(bare.postTaskCard, undefined,
    "no task template, no card — the manager must run its plain ack line");
  assert.equal(bare.updateTaskCard, undefined);

  const withCards = new DingTalkChannel("d1", "s", () => {}, undefined, "approval.schema", "task.schema");
  assert.notEqual(withCards.postTaskCard, undefined);
  assert.notEqual(withCards.updateTaskCard, undefined);
});

/** Swaps global fetch for a recorder; restored when the test ends. */
function recordedFetch(
  t: { after: (hook: () => void) => unknown },
  state: { calls: { method: string; url: string; body: unknown }[] },
  answers: (url: string) => { status: number; payload: unknown }
): void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const { status, payload } = answers(url);
    state.calls.push({
      method: init?.method ?? "GET",
      url,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
    });
    return new Response(JSON.stringify(payload), { status });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
}

const TOKEN_ANSWER = { status: 200, payload: { accessToken: "tok-1", expireIn: 7200 } };

test("a task card is created into the room's space and rewritten by its handle", async t => {
  const recorder: { calls: { method: string; url: string; body: unknown }[] } = { calls: [] };
  recordedFetch(t, recorder, url =>
    url.includes("oauth2/accessToken") ? TOKEN_ANSWER : { status: 200, payload: {} });

  const adapter = new DingTalkChannel("d1", "s", () => {}, undefined, undefined, "task.schema");
  const conversations = (adapter as unknown as {
    conversations: Map<string, { conversationType?: string; userId?: string }>;
  }).conversations;
  conversations.set("cid7", { conversationType: "2" });

  const handle = await adapter.postTaskCard!(
    "dingtalk:cid7",
    {
      title: "Draft the plan",
      agentName: "Ada",
      requesterLabel: "chris",
      status: "working",
      action: "bash: ls",
    }
  );
  assert.match(handle ?? "", /^lumenbox-/);
  const created = recorder.calls.find(call => call.url.endsWith("/card/instances") && call.method === "POST");
  assert.ok(created !== undefined);
  const createdBody = created.body as { cardTemplateId: string; cardData: { cardParamMap: Record<string, string> } };
  assert.equal(createdBody.cardTemplateId, "task.schema");
  assert.equal(createdBody.cardData.cardParamMap.status, "working");
  const delivered = recorder.calls.find(call => call.url.endsWith("/card/instances/deliver"));
  assert.ok(delivered !== undefined);
  assert.equal(
    (delivered.body as { openSpaceId: string }).openSpaceId,
    "dtv1.card//IM_GROUP.cid7",
    "a group chatKey lands the card in the group's space"
  );

  await adapter.updateTaskCard!(
    handle!,
    { title: "Draft the plan", agentName: "Ada", requesterLabel: "chris", status: "done" }
  );
  const rewritten = recorder.calls.find(call => call.url.endsWith("/card/instances") && call.method === "PUT");
  assert.ok(rewritten !== undefined);
  const rewrittenBody = rewritten.body as { outTrackId: string; cardData: { cardParamMap: Record<string, string> } };
  assert.equal(rewrittenBody.outTrackId, handle);
  assert.equal(rewrittenBody.cardData.cardParamMap.status, "done");
  assert.equal(rewrittenBody.cardData.cardParamMap.action, "", "a finished card carries no stale action");
});

test("a direct session's task card addresses its recorded sender", async t => {
  const recorder: { calls: { method: string; url: string; body: unknown }[] } = { calls: [] };
  recordedFetch(t, recorder, url =>
    url.includes("oauth2/accessToken") ? TOKEN_ANSWER : { status: 200, payload: {} });

  const adapter = new DingTalkChannel("d1", "s", () => {}, undefined, undefined, "task.schema");
  const conversations = (adapter as unknown as {
    conversations: Map<string, { conversationType?: string; userId?: string }>;
  }).conversations;
  conversations.set("cid8", { conversationType: "1", userId: "staff3" });

  await adapter.postTaskCard!("dingtalk:cid8", {
    title: "Draft the plan",
    agentName: "Ada",
    requesterLabel: "chris",
    status: "queued",
  });
  const delivered = recorder.calls.find(call => call.url.endsWith("/card/instances/deliver"));
  assert.ok(delivered !== undefined);
  assert.equal(
    (delivered.body as { openSpaceId: string }).openSpaceId,
    "dtv1.card//IM_ROBOT.staff3",
    "a direct session has no room id to address — the last sender is who is there"
  );
});

test("files and images ride the robot api on an uploaded media id", async t => {
  const recorder: { calls: { method: string; url: string; body: unknown }[] } = { calls: [] };
  recordedFetch(t, recorder, url =>
    url.includes("oauth2/accessToken")
      ? TOKEN_ANSWER
      : url.includes("media/upload")
        ? { status: 200, payload: { errcode: 0, media_id: "media-1" } }
        : { status: 200, payload: {} });

  const adapter = new DingTalkChannel("robot1", "s", () => {});
  const conversations = (adapter as unknown as {
    conversations: Map<string, { conversationType?: string }>;
  }).conversations;
  conversations.set("cid7", { conversationType: "2" });

  await adapter.sendFile("dingtalk:cid7", "TEAM-v1.md", Buffer.from("# team").toString("base64"));
  await adapter.sendImage("dingtalk:cid7", Buffer.from("pngbytes").toString("base64"));

  const upload = recorder.calls.find(call => call.url.includes("media/upload"));
  assert.ok(upload !== undefined);
  assert.match(upload.url, /type=file/);
  const sends = recorder.calls.filter(call => call.url.includes("robot/groupMessages/send"));
  assert.equal(sends.length, 2);

  const fileSend = sends[0]!.body as { msgKey: string; msgParam: string };
  assert.equal(fileSend.msgKey, "sampleFile");
  assert.deepEqual(JSON.parse(fileSend.msgParam), {
    mediaId: "media-1",
    fileName: "TEAM-v1.md",
    fileType: "md",
  });
  const imageSend = sends[1]!.body as { msgKey: string; msgParam: string };
  assert.equal(imageSend.msgKey, "sampleImageMsg");
  assert.equal(JSON.parse(imageSend.msgParam).photoURL, "media-1");
});

test("an upload past the type's cap refuses loudly instead of shipping a stub", async () => {
  const adapter = new DingTalkChannel("robot1", "s", () => {});
  await assert.rejects(
    adapter.sendFile("dingtalk:cid7", "big.bin", Buffer.alloc(21 * 1024 * 1024).toString("base64")),
    /too large/
  );
  await assert.rejects(
    adapter.sendImage("dingtalk:cid7", Buffer.alloc(11 * 1024 * 1024).toString("base64")),
    /too large/
  );
});

test("a direct session's card prefers the asker's identity over the last-sender record", async t => {
  const recorder: { calls: { method: string; url: string; body: unknown }[] } = { calls: [] };
  recordedFetch(t, recorder, url =>
    url.includes("oauth2/accessToken") ? TOKEN_ANSWER : { status: 200, payload: {} });

  // Direct on record, but no sender seen since the process came up — the identity
  // the manager hands over is what the robot space addresses.
  const adapter = new DingTalkChannel("d1", "s", () => {}, undefined, undefined, "task.schema");
  const conversations = (adapter as unknown as {
    conversations: Map<string, { conversationType?: string; userId?: string }>;
  }).conversations;
  conversations.set("cidX", { conversationType: "1" });

  const handle = await adapter.postTaskCard!(
    "dingtalk:cidX",
    { title: "Draft the plan", agentName: "Ada", requesterLabel: "chris", status: "working" },
    undefined,
    "dingtalk:staff5"
  );
  assert.match(handle ?? "", /^lumenbox-/);
  const delivered = recorder.calls.find(call => call.url.endsWith("/card/instances/deliver"));
  assert.ok(delivered !== undefined);
  assert.equal(
    (delivered.body as { openSpaceId: string }).openSpaceId,
    "dtv1.card//IM_ROBOT.staff5",
    "the robot space addresses who asked, not the room the chatKey carries"
  );

  // An unknown conversation counts as a group, and the chatKey's id is its address.
  const fresh = new DingTalkChannel("d1", "s", () => {}, undefined, undefined, "task.schema");
  await fresh.postTaskCard!("dingtalk:cidY", {
    title: "x",
    agentName: "",
    requesterLabel: "c",
    status: "working",
  });
  const delivered2 = recorder.calls.filter(call => call.url.endsWith("/card/instances/deliver")).at(-1);
  assert.ok(delivered2 !== undefined);
  assert.equal(
    (delivered2.body as { openSpaceId: string }).openSpaceId,
    "dtv1.card//IM_GROUP.cidY",
    "a wrong guess fails loudly once rather than silently always"
  );
});

test("the duplicate guard stays armed after an expired repeat", async () => {
  // The original bug: the timestamp was pinned at first-ever sight, so the guard
  // caught the first retry and went blind from the second occurrence onward —
  // expiry passed, admission refreshed nothing, and the next retry ran free.
  const state = harness();
  await deliver(state, TEXT_FRAME({ ...GROUP_TEXT, msgId: "msg-a" }));
  await deliver(state, TEXT_FRAME({ ...GROUP_TEXT, msgId: "msg-b" }).replace('"tr-1"', '"tr-2"'));
  const recent = (state.adapter as unknown as { recentTexts: Map<string, number> }).recentTexts;
  for (const [key, at] of recent) recent.set(key, at - 20_000);
  await deliver(state, TEXT_FRAME({ ...GROUP_TEXT, msgId: "msg-c" }).replace('"tr-1"', '"tr-3"'));
  assert.equal(state.turns.length, 2, "expired repeat is a fresh message — and refreshes");
  await deliver(state, TEXT_FRAME({ ...GROUP_TEXT, msgId: "msg-d" }).replace('"tr-1"', '"tr-4"'));
  assert.equal(state.turns.length, 2, "its own retry seconds later is caught again");
});

test("image uploads declare the bytes' true format, sniffed from magic", async () => {
  assert.equal(imageFormatOf(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])), "png");
  assert.equal(imageFormatOf(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00])), "jpeg");
  assert.equal(
    imageFormatOf(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")])),
    "webp"
  );
  assert.equal(imageFormatOf(Buffer.from("GIF89a")), "gif");
  assert.equal(imageFormatOf(Buffer.from("BM\x00\x00")), "bmp");
  assert.equal(imageFormatOf(Buffer.from("\u{f8ff}???")), "png", "unknown falls to png, the wire's default");
});

test("a second dingtalk door mints its own namespace", () => {
  // docs/22 §7 item 3, dingtalk half: the record id is the prefix, so two apps on
  // one installation are two namespaces. parseChatKey reads any door's keys — the
  // first segment is the id, never the address.
  const work = new DingTalkChannel("a", "b", () => {}, undefined, undefined, undefined, "dingtalk-work");
  assert.equal(work.name, "dingtalk-work");
  const legacy = new DingTalkChannel("a", "b", () => {});
  assert.equal(legacy.name, "dingtalk");
  assert.deepEqual(parseChatKey("dingtalk-work:cidXYZ"), { conversationId: "cidXYZ" });
  assert.deepEqual(parseChatKey("dingtalk:cidXYZ"), { conversationId: "cidXYZ" });
});
