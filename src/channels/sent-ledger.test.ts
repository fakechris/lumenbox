import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conversationIdFor } from "../agents/registry.ts";
import type { ChannelAdapter } from "./manager.ts";
import { recording, SentLedger } from "./sent-ledger.ts";
import { withSent } from "../web/sent-in-thread.ts";
import type { DisplayEntry } from "../web/transcript.ts";

test("a door leaves a line for what it sent and none for what failed; the thread gains only what it did not already say", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sent-"));
  try {
    let clock = Date.parse("2026-11-13T00:00:00Z");
    const ledger = new SentLedger(dir, () => {}, () => { clock += 60_000; return new Date(clock); }, text => text.replaceAll("sk-held-1", "[held]"));
    const chat = "feishu:oc_1:om_2", conversation = conversationIdFor(chat);
    let fail = false, handler!: (message: { identity: string; text: string; chatKey?: string }) => Promise<string | undefined>;
    const door = recording({
      name: "feishu", start: async onMessage => { handler = onMessage as never; }, stop() {}, send: async () => undefined,
      postTaskCard: async (_chat: string, card: { title: string }) => card.title.startsWith("posted") ? "handle-1" : undefined,
      sendToChat: async () => { if (fail) throw new Error("wire down"); },
      sendFile: async () => {},
      postQuestionCard: async () => {},
    } as ChannelAdapter, ledger);
    assert.equal(door.sendImage, undefined, "a door that cannot carry images still cannot");
    await door.sendToChat!(chat, "收到，正在处理…");
    await door.sendToChat!(chat, "结论：加权 BM25 够用。\n\n（附：昨晚的定时结果）");
    await door.sendFile!(chat, "brief.md", "aGk=");
    await door.postQuestionCard!("feishu:ou_9", { question: "发给全组还是只发你？" } as never, chat);
    fail = true;
    await assert.rejects(door.sendToChat!(chat, "never arrived"));
    await door.postTaskCard!(chat, { title: "not posted" } as never);
    await door.postTaskCard!(chat, { title: "posted with sk-held-1" } as never);
    // What the handler hands back, the door sends from inside itself: "nobody here may drive", the answer to a command.
    await door.start(async () => "这个群里你没有权限让我做事。");
    await handler({ identity: "feishu:ou_9", text: "做个事", chatKey: chat });
    const rows = ledger.in(conversation);
    assert.deepEqual(rows.map(row => [row.kind, row.card ?? "", row.name ?? row.text]), [
      ["text", "", "收到，正在处理…"], ["text", "", "结论：加权 BM25 够用。\n\n（附：昨晚的定时结果）"], ["file", "", "brief.md"], ["card", "question", "发给全组还是只发你？"],
      ["card", "task", "posted with [held]"], ["text", "", "这个群里你没有权限让我做事。"],
    ], "a line for each thing that went, held values taken out; none for the send that threw or the card the door did not post");
    const thread: DisplayEntry[] = [
      { kind: "text", role: "user", text: "核一下这篇", at: "2026-11-12T23:59:00.000Z" },
      { kind: "text", role: "assistant", text: "结论：加权 BM25 够用。", at: "2026-11-13T00:02:00.000Z" },
      { kind: "text", role: "user", text: "好", at: "2026-11-13T01:00:00.000Z" },
    ];
    assert.deepEqual(withSent(thread, rows).map(entry => entry.kind === "sent" ? `sent:${entry.card ?? entry.what}` : `${(entry as { role: string }).role}`),
      ["user", "assistant", "sent:text", "sent:file", "sent:question", "sent:task", "sent:text", "user"],
      "the reply is the bubble it already is; the acknowledgement, the file and the card are rows before what the person said next");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
