/**
 * Every parser, against every shape the wire has actually sent (INV-128).
 *
 * The corpus beside this file was captured from Feishu and sanitised (see
 * scripts/capture-feishu-fixtures.mjs): content replaced, structure kept. It exists
 * because every other payload in these tests is a literal somebody wrote from memory,
 * and the wire has repeatedly disagreed with that memory in ways that only showed up in
 * production — `meet_number` rather than the obvious `meeting_no`, `root_id` on a reply
 * where the topic carries `thread_id`, rich text arriving as a nested array-of-arrays
 * under `post` while the bot appeared to ignore messages at random.
 *
 * Three files, three claims. `feishu-messages.json` is **captured** — 27 shapes of real
 * messages from the operator's own tenant, each with its provenance and the outcome the
 * receiver owes it (`normalize` or `ignore`). `feishu-negatives.json` is **synthetic** and
 * says so — shapes the receiver must refuse. This file drives the real receiver
 * (`receiverFor`, the same seam the socket and the catch-up sweep use) over both and checks
 * the manifest, the sanitisation and the outcomes, with no credentials and no network.
 *
 * One honest gap: the captured shapes are the *API history* shape. The live event carries
 * `mentions[].id.open_id` where the history carries `mentions[].id` as a string; the test maps
 * that one field and the manifest records it. Recorded live events would close the gap.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { conversationKeyFor, FeishuChannel } from "./feishu.ts";
import type { InboundMessage } from "./manager.ts";

interface CapturedMessage {
  kind: string;
  source: string;
  sanitised: string;
  expect: "normalize" | "ignore";
  message: {
    message_id?: string;
    chat_id?: string;
    msg_type?: string;
    thread_id?: string;
    root_id?: string;
    parent_id?: string;
    chat_type?: string;
    create_time?: string;
    deleted?: boolean;
    updated?: boolean;
    mentions?: { key?: string; id?: string }[];
    sender?: { id?: string; sender_type?: string };
    body?: { content?: string };
  };
}
interface NegativeEvent {
  kind: string;
  expect: "reject";
  reason: string;
  data: unknown;
  deliverTwice?: boolean;
}
const here = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const corpus = JSON.parse(readFileSync(here("feishu-messages.json"), "utf8")) as { capturedAt: string; messages: CapturedMessage[] };
const negatives = JSON.parse(readFileSync(here("feishu-negatives.json"), "utf8")) as { events: NegativeEvent[] };

/** A receiver over a fresh adapter: what it admitted, what it dropped and why. */
function receiver(botOpenId = "ou_bot") {
  const dropped: string[] = [];
  const inbound: InboundMessage[] = [];
  const adapter = new FeishuChannel("app", "secret", line => dropped.push(line));
  const internals = adapter as unknown as {
    ownOpenIdCache?: string;
    sendToChat: unknown;
    downloadResource: unknown;
    receiverFor: (handler: (message: InboundMessage) => Promise<string | undefined>) => (data: unknown) => unknown;
  };
  internals.ownOpenIdCache = botOpenId;
  internals.sendToChat = async () => undefined;
  internals.downloadResource = async () => ({ base64: "QUJD", fileName: "fixture.bin" });
  const receive = internals.receiverFor(async message => {
    inbound.push(message);
    return undefined;
  });
  return { receive, inbound, dropped, settle: () => new Promise(resolve => setTimeout(resolve, 20)) };
}

/** A captured history message as the event the socket would have delivered. */
function eventOf(message: CapturedMessage["message"]) {
  return {
    ...(message.sender?.id !== undefined ? { sender: { sender_id: { open_id: message.sender.id } } } : {}),
    message: {
      message_id: message.message_id,
      chat_id: message.chat_id,
      message_type: message.msg_type,
      content: message.body?.content,
      // The one translation (see the header): history carries the id as a string.
      ...(message.mentions !== undefined ? { mentions: message.mentions.map(mention => ({ key: mention.key, id: { open_id: mention.id } })) } : {}),
      thread_id: message.thread_id,
      root_id: message.root_id,
      parent_id: message.parent_id,
      chat_type: message.chat_type,
      create_time: message.create_time,
    },
  };
}

test("the corpus is real, plural, provenanced, and carries the shapes worth pinning (A1, A2)", () => {
  assert.ok(corpus.messages.length >= 20, `${corpus.messages.length} captured shapes; the floor is 20`);
  for (const entry of corpus.messages) {
    assert.match(entry.source, /^feishu-api:/, `${entry.kind}: no provenance`);
    assert.ok(entry.sanitised.length > 0, `${entry.kind}: how it was sanitised is not recorded`);
    assert.ok(entry.expect === "normalize" || entry.expect === "ignore", `${entry.kind}: no expected outcome`);
  }
  const kinds = new Set(corpus.messages.map(entry => entry.message.msg_type));
  for (const kind of ["text", "post", "image", "file", "interactive", "system"]) assert.ok(kinds.has(kind), `no ${kind} message captured; re-run the capture script`);
  const flags = corpus.messages.map(entry => entry.kind).join(" ");
  for (const flag of ["threaded", "top-level", "reply", "edited", "deleted", "mention"]) assert.match(flags, new RegExp(flag), `no ${flag} shape captured`);
  assert.ok(negatives.events.every(event => event.expect === "reject"), "negatives are refusals, and say so");
});

test("sanitisation held: no raw ids, long numbers, addresses, hosts or free text survive in either fixture (A3)", () => {
  for (const name of ["feishu-messages.json", "feishu-negatives.json"]) {
    const text = readFileSync(here(name), "utf8");
    assert.equal(text.match(/\b(ou|oc|om|omt|cli|img|file)_(?!fixture)[A-Za-z0-9]{6,}/g), null, `${name}: a raw id`);
    assert.equal((text.match(/(?<![A-Za-z_])\d{10,}(?!\d)/g) ?? []).filter(digits => digits !== "1788000000000").length, 0, `${name}: a real timestamp or number`);
    assert.equal(text.match(/[\w.+-]+@[\w-]+\.[\w.]+/g), null, `${name}: an email address`);
    assert.equal(text.match(/https?:\/\//g), null, `${name}: a URL`);
    const cjk = (text.match(/[一-鿿]{2,}/g) ?? []).filter(run => run !== "示例文本" && run !== "示例");
    assert.deepEqual(cjk, [], `${name}: free text survived`);
  }
});

test("every captured shape through the real receiver does what its manifest says: admitted as work, or dropped and said (A2, A4)", async () => {
  for (const entry of corpus.messages) {
    const mentioned = entry.message.mentions?.[0]?.id;
    const { receive, inbound, dropped, settle } = receiver(mentioned ?? "ou_bot");
    receive(eventOf(entry.message));
    await settle();
    if (entry.expect === "normalize") {
      assert.equal(inbound.length, 1, `${entry.kind}: expected to be admitted, got dropped: ${dropped.join(" | ")}`);
      const message = inbound[0]!;
      assert.match(message.chatKey ?? "", /^feishu:oc_fixture/, `${entry.kind}: unusable chat key ${message.chatKey}`);
      if (entry.message.msg_type === "text" || entry.message.msg_type === "post") assert.ok(message.text.trim() !== "", `${entry.kind}: admitted with no text`);
      if (entry.kind.includes("mention")) assert.equal(message.addressed, true, `${entry.kind}: a mention of the bot is addressed`);
      // A file or image carries no addressing decision yet (undefined); text and post in a group do.
      if ((entry.message.msg_type === "text" || entry.message.msg_type === "post") && entry.message.chat_type === "group" && !entry.kind.includes("mention") && !entry.kind.includes("reply")) assert.equal(message.addressed, false, `${entry.kind}: an unaddressed group message is not addressed`);
    } else {
      assert.equal(inbound.length, 0, `${entry.kind}: expected to be ignored, was admitted as ${JSON.stringify(inbound[0]?.text)}`);
      assert.ok(dropped.some(line => /dropped/.test(line)), `${entry.kind}: ignored silently; the drop must be said`);
    }
  }
});

test("every captured message keys to a conversation, and a topic keys to its root", () => {
  for (const { kind, message } of corpus.messages) {
    const key = conversationKeyFor(
      {
        ...(message.message_id !== undefined ? { message_id: message.message_id } : {}),
        ...(message.chat_id !== undefined ? { chat_id: message.chat_id } : {}),
        ...(message.thread_id !== undefined ? { thread_id: message.thread_id } : {}),
        ...(message.root_id !== undefined ? { root_id: message.root_id } : {}),
        ...(message.chat_type !== undefined ? { chat_type: message.chat_type } : {}),
      },
      "feishu"
    );
    assert.match(key, /^feishu:oc_/, `${kind} produced an unusable conversation key: ${key}`);
    // Never keyed on `thread_id`: it is minted when the first reply arrives, so the
    // opening message never carries it and preferring it split every topic in two.
    if (message.thread_id !== undefined) assert.ok(!key.includes(message.thread_id), `${kind} keyed on thread_id`);
  }
});

test("every synthetic negative is refused by the receiver and the refusal is said", async () => {
  for (const event of negatives.events) {
    const { receive, inbound, dropped, settle } = receiver();
    receive(event.data);
    if (event.deliverTwice === true) {
      await settle();
      inbound.length = 0;
      dropped.length = 0;
      receive(event.data);
    }
    await settle();
    assert.equal(inbound.length, 0, `${event.kind}: admitted as work (${event.reason})`);
    assert.ok(dropped.length > 0, `${event.kind}: refused silently (${event.reason})`);
  }
});

test("a field we do not read yet is recorded rather than forgotten", () => {
  // `content_v2` rides along on every rich-text message and nothing here reads it. That
  // is a decision, not an oversight, and this is where it is written down.
  const post = corpus.messages.find(entry => entry.message.msg_type === "post" && entry.expect === "normalize");
  assert.ok(post !== undefined);
  const parsed = JSON.parse(post.message.body?.content ?? "{}") as Record<string, unknown>;
  assert.ok("content_v2" in parsed || "content" in parsed, "rich text carries content (or content_v2)");
});
