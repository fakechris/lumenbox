/**
 * The review of a guest answer is the guest's (INV-1721): no eval case, no member paying.
 *
 * Run inside a member turn on purpose. The review's model call used to take its payer from the
 * execution it happened to run in, so a guest answer reviewed while Chris's turn was on the model
 * was billed to Chris and filed among Ada's eval cases with the guest's words in it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { AgentRegistry } from "../agents/registry.ts";
import { guestAnswerReview } from "./answer-review.ts";
import { readEvalCases } from "./eval-cases.ts";
import { Orchestrator } from "./orchestrator.ts";
import { resolveProvider } from "./provider.ts";
import type { SpendLimits, SpendRow } from "./spend-limits.ts";
import { fakeModel } from "./testing/fake-model.ts";

const reply = (text: string): Anthropic.Message =>
  ({ id: "m", type: "message", role: "assistant", model: "fake", content: [{ type: "text", text, citations: null }], stop_reason: "end_turn", stop_sequence: null,
    usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }) as Anthropic.Message;

test("a guest answer reviewed during a member turn is a guest usage row on the guest turn, noted against the agent's spend, and never an eval case; the member's review is unchanged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-guest-review-"));
  const saved = { home: process.env.AGENTBOX_HOME, review: process.env.AGENTBOX_ANSWER_REVIEW };
  process.env.AGENTBOX_HOME = dir;
  process.env.AGENTBOX_ANSWER_REVIEW = "shadow";
  try {
    const registry = new AgentRegistry(join(dir, "agents"));
    const ada = registry.create({ name: "Ada" });
    const provider = { ...resolveProvider("anthropic"), label: "Fake", model: "fake" };
    let orchestrator: Orchestrator;
    const client = fakeModel(
      async () => {
        // Chris's turn is on the model: the execution says Chris drives Ada right now.
        await orchestrator.reviewAnswer(guestAnswerReview({ agentName: "Ada", turnId: "guest-t1", door: "feishu", chatKey: "feishu:oc_g", question: "GUEST_QUESTION refund?", answer: "GUEST_ANSWER sure, refunded today", knowledge: "" }));
        await orchestrator.reviewAnswer({ source: "member", agentName: "Ada", messageId: "member-m1", conversation: "main", request: "MEMBER_REQUEST", answer: "MEMBER_ANSWER later" });
        return reply("done");
      },
      { create: () => reply('{"category":"NON_ANSWER","confidence":0.9,"reason":"no answer"}') }
    );
    orchestrator = new Orchestrator({ registry, provider, client, useBox: false, inbox: null, turns: null });
    const noted: SpendRow[] = [];
    orchestrator.spendLimits = { note: (row: SpendRow) => { noted.push(row); return { kind: "ok" }; } } as unknown as SpendLimits;

    await orchestrator.prompt(ada.id, "start", { userId: "chris" });

    const rows = orchestrator.usage.since(0, 1_000);
    const guest = rows.filter(row => row.turnId === "guest-t1");
    assert.equal(guest.length, 1, "one review call, on the guest turn");
    assert.equal(guest[0]!.kind, "guest");
    assert.equal(guest[0]!.principal, undefined, "no member pays for a guest's review");
    assert.equal(guest[0]!.door, "feishu");
    assert.equal(guest[0]!.conversation, "guest:feishu:oc_g");
    assert.equal(noted.filter(row => row.turnId === "guest-t1").length, 1, "counted against Ada's spend lines as the guest turn's wake");

    const member = rows.filter(row => row.kind === "review");
    assert.equal(member.length, 1, "the member's review is still a review row");
    assert.equal(member[0]!.principal, "chris", "paid by the member driving the turn, as before");

    const cases = readEvalCases(join(dir, "evals"), "Ada");
    assert.deepEqual(cases.map(c => c.case.messageId), ["member-m1"], "the member's bad reply is a case; the guest's is not");
    assert.doesNotMatch(JSON.stringify(cases), /GUEST_/);
  } finally {
    if (saved.home === undefined) delete process.env.AGENTBOX_HOME; else process.env.AGENTBOX_HOME = saved.home;
    if (saved.review === undefined) delete process.env.AGENTBOX_ANSWER_REVIEW; else process.env.AGENTBOX_ANSWER_REVIEW = saved.review;
    rmSync(dir, { recursive: true, force: true });
  }
});
