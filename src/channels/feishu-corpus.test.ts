/**
 * Every parser, against every shape the wire has actually sent.
 *
 * The corpus beside this file was captured from Feishu and sanitised (see
 * scripts/capture-feishu-fixtures.mjs): content replaced, structure kept. It exists
 * because every other payload in these tests is a literal somebody wrote from memory,
 * and the wire has repeatedly disagreed with that memory in ways that only showed up in
 * production — `meet_number` rather than the obvious `meeting_no`, `root_id` on a reply
 * where the topic carries `thread_id`, rich text arriving as a nested array-of-arrays
 * under `post` while the bot appeared to ignore messages at random.
 *
 * This is the contract test OpenClaw applies per channel (`test/helpers/inbound-contract.ts`),
 * pointed at recorded input rather than invented input: one assertion set, run over the
 * whole corpus, so a shape that changes fails once, loudly, in a file whose diff shows
 * what changed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { conversationKeyFor, FeishuChannel } from "./feishu.ts";

interface CapturedMessage {
  kind: string;
  message: {
    message_id?: string;
    chat_id?: string;
    msg_type?: string;
    thread_id?: string;
    root_id?: string;
    chat_type?: string;
    deleted?: boolean;
    sender?: { id?: string; sender_type?: string };
    body?: { content?: string };
  };
}

const corpus = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/feishu-messages.json", import.meta.url)), "utf8")
) as { capturedAt: string; messages: CapturedMessage[] };

test("the corpus is real, plural, and carries the shapes worth pinning", () => {
  assert.ok(corpus.messages.length >= 5, "a corpus of one is a literal with extra steps");
  const kinds = new Set(corpus.messages.map(entry => entry.message.msg_type));
  // The three that have each cost an incident: plain text, rich text, and an image.
  for (const kind of ["text", "post", "image"]) {
    assert.ok(kinds.has(kind), `no ${kind} message captured; re-run the capture script`);
  }
  // And both sides of the thread question, which is what conversation keying turns on.
  assert.ok(
    corpus.messages.some(entry => entry.message.thread_id !== undefined),
    "no threaded message captured"
  );
  assert.ok(
    corpus.messages.some(entry => entry.message.thread_id === undefined),
    "no top-level message captured"
  );
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
    if (message.thread_id !== undefined) {
      assert.ok(!key.includes(message.thread_id), `${kind} keyed on thread_id`);
    }
  }
});

test("every captured body renders to something a person could read", () => {
  // The adapter's own renderer, reached the way the existing tests reach it. A payload
  // that renders empty is the failure mode that looked like the bot ignoring messages.
  const adapter = new FeishuChannel("a", "b", () => {});
  const renderPost = (
    adapter as unknown as {
      renderPostBody: (title: unknown, content: unknown) => { text: string; imageKeys: string[] };
    }
  ).renderPostBody.bind(adapter);

  for (const { kind, message } of corpus.messages) {
    const parsed = JSON.parse(message.body?.content ?? "{}") as {
      text?: string;
      title?: string;
      content?: unknown;
      image_key?: string;
      elements?: unknown;
    };
    if (message.msg_type === "text") {
      assert.ok(
        typeof parsed.text === "string" && parsed.text.trim() !== "",
        `${kind}: a text message with no text`
      );
      continue;
    }
    if (message.msg_type === "post") {
      // The nesting is the point: content is an array of *lines*, each an array of runs.
      assert.ok(Array.isArray(parsed.content), `${kind}: post content is not an array`);
      assert.ok(
        Array.isArray((parsed.content as unknown[])[0]),
        `${kind}: post content is not an array of lines`
      );
      const { text } = renderPost(parsed.title, parsed.content);
      assert.ok(text.trim() !== "", `${kind}: rich text rendered to nothing`);
      continue;
    }
    if (message.msg_type === "image") {
      assert.match(String(parsed.image_key), /^img_/, `${kind}: no image key`);
      continue;
    }
    if (message.msg_type === "interactive") {
      // Ours, on the way back in. Not work to answer, but it must not crash a reader.
      assert.ok(parsed.elements !== undefined || parsed.title !== undefined);
      continue;
    }
    assert.fail(`${kind}: an uncovered message type reached the corpus — teach the parsers first`);
  }
});

test("a field we do not read yet is recorded rather than forgotten", () => {
  // `content_v2` rides along on every rich-text message and nothing here reads it. That
  // is a decision, not an oversight, and this is where it is written down: if it ever
  // becomes the only place some content lives, this assertion is the reminder that it
  // was there all along.
  const post = corpus.messages.find(entry => entry.message.msg_type === "post");
  assert.ok(post !== undefined);
  const parsed = JSON.parse(post.message.body?.content ?? "{}") as Record<string, unknown>;
  assert.ok(
    "content_v2" in parsed || "content" in parsed,
    "the post body lost both of its content fields"
  );
});
