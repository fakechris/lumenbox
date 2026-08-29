/**
 * The state→card mapping, which can be wrong quietly: a done card that stays blue, or
 * a queued one that hides its position, misleads a room at a glance — and nothing else
 * in the system would notice.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { FeishuChannel, looksLikeMarkdown, markdownPost, renderCard, renderQuestionCard, splitChatKey } from "./feishu.ts";
import type { TaskCardState } from "./manager.ts";

interface CardShape {
  header: { title: { content: string }; template: string };
  elements: {
    tag: string;
    text?: { content: string };
    elements?: { content: string }[];
  }[];
}

function rendered(card: TaskCardState): CardShape {
  return renderCard(card) as CardShape;
}

test("each status has its colour, and queued says how many are ahead", () => {
  const base: TaskCardState = {
    title: "weekly report",
    agentName: "Rex",
    requesterLabel: "chris",
    status: "working",
  };

  assert.equal(rendered(base).header.template, "blue");
  assert.equal(rendered({ ...base, status: "done" }).header.template, "green");
  assert.equal(rendered({ ...base, status: "failed" }).header.template, "red");

  const queued = rendered({ ...base, status: "queued", ahead: 2 });
  assert.equal(queued.header.template, "grey");
  assert.match(queued.elements[0]!.text!.content, /排队中 — 前面还有 2 件/);
});

test("the card says who is on it, what it is doing, and who asked", () => {
  const card = rendered({
    title: "weekly report",
    agentName: "Rex",
    requesterLabel: "chris",
    status: "working",
    action: "bash: build-report",
  });

  assert.equal(card.header.title.content, "weekly report");
  assert.match(card.elements[0]!.text!.content, /\*\*Rex\*\* · 进行中/);
  assert.match(card.elements[0]!.text!.content, /`bash: build-report`/);
  const note = card.elements.find(element => element.tag === "note");
  assert.match(note!.elements![0]!.content, /chris/);

  // No addressed agent: the team as a whole is on it, and the card says so rather
  // than showing an empty name.
  const team = rendered({ title: "t", agentName: "", requesterLabel: "c", status: "working" });
  assert.match(team.elements[0]!.text!.content, /\*\*团队\*\*/);
});

test("markdown detection catches the constructs prose never contains", () => {
  // The verdict decides the wire form, so a plain sentence must stay plain.
  assert.equal(looksLikeMarkdown("plain words, 2 + 3 = 5, an * stray, a_b_c"), false);
  assert.equal(looksLikeMarkdown("all done, nothing to see"), false);

  assert.equal(looksLikeMarkdown("## 验算结论\n\n**已核对**到原始信源"), true);
  assert.equal(looksLikeMarkdown("| 厂商 | 价格 |\n| --- | --- |\n| A | 1 |"), true);
  assert.equal(looksLikeMarkdown("run `npm test` first"), true);
  assert.equal(looksLikeMarkdown("- one\n- two"), true);
  assert.equal(looksLikeMarkdown("1. first\n2. second"), true);
  assert.equal(looksLikeMarkdown("see [docs](https://example.com)"), true);
  assert.equal(looksLikeMarkdown("```js\ncode\n```"), true);
});

test("markdown rides as a post md element, the form Feishu renders", () => {
  const content = JSON.parse(markdownPost("**done**")) as {
    zh_cn: { content: { tag: string; text: string }[][] };
  };
  assert.equal(content.zh_cn.content[0]![0]!.tag, "md");
  assert.equal(content.zh_cn.content[0]![0]!.text, "**done**");
});

test("the approval card carries the action verbatim and the three answers as buttons", async () => {
  const { renderApprovalCard } = await import("./feishu.ts");
  const card = renderApprovalCard({
    approvalId: "appr-9",
    agentName: "Ada",
    description: "curl -X POST https://example.com/export",
    stakes: "Until someone answers, this work is stopped.",
  }) as {
    header: { title: { content: string }; template: string };
    elements: {
      tag: string;
      text?: { content: string };
      actions?: { text: { content: string }; value: { approval: string; reply: string } }[];
    }[];
  };
  assert.equal(card.header.template, "orange");
  assert.match(card.header.title.content, /Ada 请你确认/);
  assert.equal(card.elements[0]!.text!.content, "curl -X POST https://example.com/export");
  const actions = card.elements.find(element => element.tag === "action")!.actions!;
  assert.deepEqual(
    actions.map(action => action.value),
    [
      { approval: "appr-9", reply: "once" },
      { approval: "appr-9", reply: "always" },
      { approval: "appr-9", reply: "deny" },
    ]
  );
});

test("a task card offers the workshop only when there is somewhere to send people", async () => {
  const base: TaskCardState = {
    title: "weekly report",
    agentName: "Rex",
    requesterLabel: "chris",
    status: "working",
    taskId: "t17",
  };
  const withoutUrl = rendered(base);
  assert.equal(
    withoutUrl.elements.find(element => element.tag === "action"),
    undefined,
    "no public url, no button — a link that opens nothing is worse than none"
  );

  const withUrl = renderCard({ ...base, taskUrl: "https://box.example/?task=t17" }) as {
    elements: { tag: string; actions?: { url?: string; text: { content: string } }[] }[];
  };
  const action = withUrl.elements.find(element => element.tag === "action")!;
  assert.equal(action.actions![0]!.url, "https://box.example/?task=t17");
  assert.match(action.actions![0]!.text.content, /工作台/);
});

test("a rich-text message is read, not dropped", () => {
  // Anything pasted with a link, a line break or an emoji arrives as `post` rather than
  // `text`, which is most of what a person actually sends. The whole type was being
  // dropped in silence, so the bot appeared to ignore messages at random.
  const adapter = new FeishuChannel("a", "b", () => {});
  const body = (
    adapter as unknown as {
      renderPostBody: (title: unknown, content: unknown) => { text: string; imageKeys: string[] };
    }
  ).renderPostBody.bind(adapter);

  const { text } = body("Release notes", [
    [{ tag: "text", text: "See " }, { tag: "a", text: "the docs", href: "https://example.com/d" }],
    [{ tag: "at", user_name: "Ada" }, { tag: "text", text: " please look" }],
  ]);

  assert.match(text, /Release notes/);
  assert.match(text, /See the docs/);
  // The address survives: an agent handed "see the docs" with no URL cannot follow it,
  // and following it is usually why somebody pasted one.
  assert.match(text, /https:\/\/example\.com\/d/);
  assert.match(text, /@Ada please look/);
  // Paragraphs stay separate rather than running together.
  assert.equal(text.split("\n").length, 3);
});

test("a rich-text message with nothing in it is still empty", () => {
  const adapter = new FeishuChannel("a", "b", () => {});
  const body = (
    adapter as unknown as {
      renderPostBody: (title: unknown, content: unknown) => { text: string; imageKeys: string[] };
    }
  ).renderPostBody.bind(adapter);
  assert.equal(body(undefined, []).text.trim(), "");
  // Malformed content is empty rather than a crash: this parses somebody else's wire.
  assert.equal(body(undefined, "not an array").text.trim(), "");
});


test("a picture pasted into rich text is not lost", () => {
  // The words arrived and the picture did not, and nothing said so — the same silent
  // discard as the whole message type before it, one level down.
  const adapter = new FeishuChannel("a", "b", () => {});
  const body = (
    adapter as unknown as {
      renderPostBody: (title: unknown, content: unknown) => { text: string; imageKeys: string[] };
    }
  ).renderPostBody.bind(adapter);

  const { text, imageKeys } = body(undefined, [
    [{ tag: "text", text: "before " }, { tag: "img", image_key: "img_v3_abc" }, { tag: "text", text: " after" }],
  ]);
  assert.deepEqual(imageKeys, ["img_v3_abc"]);
  // Marked in place, so the agent knows where in the message the picture sat.
  assert.match(text, /before \[image 1\] after/);
});

test("a thread is the conversation; a direct chat still is", () => {
  const adapter = new FeishuChannel("a", "b", () => {});
  const key = (
    adapter as unknown as { conversationKeyFor: (m: Record<string, string>) => string }
  ).conversationKeyFor.bind(adapter);

  // The case that matters, taken from the ledger. A chain's opening message carries
  // neither field and is keyed on its own id; its replies carry `root_id` equal to that
  // id and a `thread_id` that is something else entirely. Keying on `thread_id` put the
  // question in one conversation and every answer in another.
  const opening = key({ chat_id: "oc_1", chat_type: "group", message_id: "om_root" });
  const reply = key({
    chat_id: "oc_1",
    chat_type: "group",
    message_id: "om_b",
    root_id: "om_root",
    thread_id: "omt_minted_later",
  });
  assert.equal(opening, "feishu:oc_1:om_root");
  assert.equal(reply, opening, "a reply must land in the conversation it answers");

  // A new top-level message in a group is a new subject. Keying it on the room is what
  // made one room one endless conversation, and a finished topic keep steering new ones.
  assert.equal(
    key({ chat_id: "oc_1", chat_type: "group", message_id: "om_c" }),
    "feishu:oc_1:om_c"
  );

  // A direct message is different: there the chat *is* the subject, and a key per message
  // would throw away every follow-up the person makes.
  assert.equal(key({ chat_id: "oc_2", chat_type: "p2p", message_id: "om_d" }), "feishu:oc_2");

  // Two replies to the same opening share a conversation; two new topics do not.
  assert.equal(
    key({ chat_id: "oc_1", chat_type: "group", message_id: "om_e", root_id: "om_root" }),
    key({ chat_id: "oc_1", chat_type: "group", message_id: "om_f", root_id: "om_root" })
  );
  assert.notEqual(
    key({ chat_id: "oc_1", chat_type: "group", message_id: "om_g" }),
    key({ chat_id: "oc_1", chat_type: "group", message_id: "om_h" })
  );
});

test("a push to a topic thread rides as a reply to its root", async () => {
  // conversationKeyFor mints `feishu:{chatId}:{rootId}` for a topic; a push to that key
  // must land in the thread, not at the bottom of the room. The room-level key keeps
  // its old shape and its old behaviour.
  const adapter = new FeishuChannel("a", "b", () => {});
  const posts: { chatId: string; replyTo?: string }[] = [];
  (adapter as unknown as { post: unknown }).post = async (
    chatId: string,
    _type: string,
    _content: string,
    replyTo?: string
  ) => {
    posts.push({ chatId, ...(replyTo !== undefined ? { replyTo } : {}) });
    return undefined;
  };

  await adapter.sendToChat("feishu:oc_room:om_root", "into the thread");
  await adapter.sendToChat("feishu:oc_room", "into the room");
  assert.deepEqual(posts, [
    { chatId: "oc_room", replyTo: "om_root" },
    { chatId: "oc_room" },
  ]);
});

test("every outbound path understands a thread-scoped key, not only the text one", () => {
  // The regression: sendToChat and postTaskCard were taught the `feishu:{chat}:{root}`
  // form and sendFile/sendImage were not, so a file answering a message in a topic was
  // uploaded and then posted to a chat id that does not exist. It surfaced as "it used to
  // send the file, now it just tells me the path". One parser now, so there is no next
  // path to forget.
  assert.deepEqual(splitChatKey("feishu:oc_room"), { chatId: "oc_room" });
  assert.deepEqual(splitChatKey("feishu:oc_room:om_topic"), {
    chatId: "oc_room",
    rootId: "om_topic",
  });
  // A trailing colon is a room key with noise, not a thread whose root is the empty
  // string — the second would anchor a reply to nothing.
  assert.deepEqual(splitChatKey("feishu:oc_room:"), { chatId: "oc_room" });
  assert.deepEqual(splitChatKey("feishu:"), { chatId: "" });
});

test("a file sent into a topic is anchored to that topic", async () => {
  const adapter = new FeishuChannel("a", "b", () => {});
  const posts: { chatId: string; type: string; replyTo?: string }[] = [];
  (adapter as unknown as { post: unknown }).post = async (
    chatId: string,
    type: string,
    _content: string,
    replyTo?: string
  ) => {
    posts.push({ chatId, type, ...(replyTo !== undefined ? { replyTo } : {}) });
    return undefined;
  };
  (adapter as unknown as { apiClient: unknown }).apiClient = {
    im: {
      file: { create: async () => ({ file_key: "f1" }) },
      image: { create: async () => ({ image_key: "i1" }) },
    },
  };

  await adapter.sendFile("feishu:oc_room:om_topic", "report.md", Buffer.from("x").toString("base64"));
  await adapter.sendImage("feishu:oc_room:om_topic", Buffer.from("x").toString("base64"));
  assert.deepEqual(posts, [
    { chatId: "oc_room", type: "file", replyTo: "om_topic" },
    { chatId: "oc_room", type: "image", replyTo: "om_topic" },
  ]);
});

test("a task waiting on a person does not read as finished", () => {
  // t51: the agent produced the answer, moved the task to review and said in the chat that
  // it was waiting for the person's next step. The card said Done. The card could not have
  // said anything else — its vocabulary was queued/working/done/failed, so the one state
  // that means "your turn" had nowhere to render and came out as the state that means
  // "nothing left for you to do".
  const card = rendered({
    title: "size the local models",
    agentName: "Ada",
    requesterLabel: "chris",
    status: "review",
  });
  assert.match(card.elements[0]?.text?.content ?? "", /待你验收/);
  assert.notEqual(card.header.template, "green", "green is the colour of nothing-left-to-do");
});

test("a question card carries each answer as a button that speaks the answer", () => {
  const card = renderQuestionCard({
    agentName: "Ada",
    question: "有 12 份报表缺'成本'列。跳过并在总表标注,还是停下来等你?",
    options: ["跳过并标注", "停下来"],
  }) as {
    header: { title: { content: string }; template: string };
    elements: { tag: string; text?: { content: string }; actions?: { text: { content: string }; value: { ask: string } }[]; elements?: { content: string }[] }[];
  };

  assert.equal(card.header.template, "blue", "a question is not a consent — orange teaches fear");
  assert.match(card.header.title.content, /Ada 有个问题要先问你/);
  const actions = card.elements.find(element => element.tag === "action")!.actions!;
  // The button's value is the answer itself: pressing it goes through the same door as
  // typing it, so downstream there is one reply path, not two.
  assert.deepEqual(
    actions.map(action => action.value),
    [{ ask: "跳过并标注" }, { ask: "停下来" }]
  );
  const note = card.elements.find(element => element.tag === "note");
  assert.match(note!.elements![0]!.content, /直接把答案打在下面/);
});

test("the board card groups tasks under bold headings, links ids, and footnotes the finishes", async () => {
  const { renderBoardCard } = await import("./feishu.ts");
  const card = renderBoardCard({
    liveCount: 2,
    groups: [
      { heading: "待验收", tasks: [{ id: "t1", who: "Ada", title: "整理 Q3 报表", url: "https://box.example/?task=t1" }] },
      { heading: "进行中", tasks: [{ id: "t2", title: "翻译新闻稿" }] },
    ],
    done: [{ id: "t9", title: "周报" }],
  }) as {
    header: { title: { content: string }; template: string };
    elements: { tag: string; text?: { content: string }; elements?: { content: string }[] }[];
  };
  assert.equal(card.header.template, "blue", "informational, nothing to consent to");
  assert.equal(card.header.title.content, "看板 · 2 件在办");
  const body = card.elements.find(element => element.tag === "div")!.text!.content;
  assert.match(body, /\*\*待验收\*\*/);
  assert.match(body, /\[t1\]\(https:\/\/box\.example\/\?task=t1\) @Ada 整理 Q3 报表/);
  assert.match(body, /\*\*进行中\*\*\nt2 翻译新闻稿/);
  const note = card.elements.find(element => element.tag === "note");
  assert.match(note!.elements![0]!.content, /近 24 小时完成:t9 周报/);
});

test("an empty board card says so in the body instead of an empty div", async () => {
  const { renderBoardCard } = await import("./feishu.ts");
  const card = renderBoardCard({ liveCount: 0, groups: [], done: [] }) as {
    elements: { tag: string; text?: { content: string } }[];
  };
  assert.equal(card.elements.find(element => element.tag === "div")!.text!.content, "这个群现在没有挂着的任务。");
});

test("a file the bot cannot pull down is explained to the sender, by cause", async () => {
  const { fileFetchFailed } = await import("./strings.ts");
  // 234037 is what Feishu answered in production: size limit. Replayed by hand to get the
  // code — the SDK surfaces only "Request failed with status code 400".
  assert.match(fileFetchFailed("Q3报表.zip", 234037), /「Q3报表\.zip」太大/);
  assert.match(fileFetchFailed("Q3报表.zip", 234037), /压缩|拆小/);
  // Any other failure: named, numbered when known, with a way forward.
  assert.match(fileFetchFailed("a.pdf", 99991663), /没拿下来.*99991663/);
  assert.match(fileFetchFailed("a.pdf", undefined), /没拿下来/);
});

test("a 1:1 chat is one conversation, whichever bubble the person typed into", async () => {
  const { conversationKeyFor } = await import("./feishu.ts");
  // Observed live: the person talked to the bot "in the same topic the whole time" and
  // watched it forget everything. Their top-level messages keyed to the chat; their
  // in-topic replies carried root_id and keyed to chat:root; the agent entered the
  // reply's conversation with an empty transcript and re-derived work it had already
  // delivered. In a 1:1 the counterpart is one person — a topic bubble is not a subject
  // boundary, and root_id must not outrank that.
  const p2p = { chat_id: "oc_1", chat_type: "p2p" };
  assert.equal(conversationKeyFor({ ...p2p, message_id: "om_a" }), "feishu:oc_1");
  assert.equal(
    conversationKeyFor({ ...p2p, message_id: "om_b", root_id: "om_a", thread_id: "omt_x" }),
    "feishu:oc_1",
    "an in-topic reply in a 1:1 stays in the one conversation"
  );

  // Groups keep topic separation: one room really does hold many subjects.
  const group = { chat_id: "oc_2", chat_type: "group" };
  assert.equal(conversationKeyFor({ ...group, message_id: "om_r" }), "feishu:oc_2:om_r");
  assert.equal(
    conversationKeyFor({ ...group, message_id: "om_s", root_id: "om_r" }),
    "feishu:oc_2:om_r",
    "a group topic's root and its replies agree on the conversation"
  );
});

test("a second door mints its own namespace: nothing it says collides with the first", () => {
  // docs/22 §7 item 3. The channel record's id is the prefix; two Feishu apps on
  // one installation are two namespaces, not one namespace with two writers.
  const work = new FeishuChannel("a", "b", () => {}, undefined, "feishu-work");
  assert.equal(work.name, "feishu-work");
  const key = (
    work as unknown as { conversationKeyFor: (m: Record<string, string>) => string }
  ).conversationKeyFor.bind(work);
  assert.equal(key({ chat_id: "oc_1", chat_type: "p2p" }), "feishu-work:oc_1");
  assert.equal(
    key({ chat_id: "oc_2", chat_type: "group", message_id: "om_r" }),
    "feishu-work:oc_2:om_r"
  );
  // The grandfathered door is untouched by the parameter existing.
  const legacy = new FeishuChannel("a", "b", () => {});
  assert.equal(legacy.name, "feishu");

  // splitChatKey reads any door's keys: the first segment is the id, never the address.
  assert.deepEqual(splitChatKey("feishu-work:oc_room:om_topic"), {
    chatId: "oc_room",
    rootId: "om_topic",
  });
});
