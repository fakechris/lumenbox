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
  CHUNK_CHARS,
  DingTalkChannel,
  chunkText,
  flattenRichText,
  freshWebhookOf,
  isContentRefusal,
  markdownTitle,
  mediaOf,
  outboundRoute,
  parseChatKey,
  TOPIC,
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
