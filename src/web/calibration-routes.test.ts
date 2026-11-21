/**
 * The calibration page's routes (INV-1773): what the sheet may show of each judge's verdicts, and
 * a label being taken. Synthetic throughout, in a temporary home: no line here was said by anyone,
 * and no number here measures a judge.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AgentRegistry } from "../agents/registry.ts";
import { AnswerReviewer } from "../host/answer-review.ts";
import { AutoReviewer } from "../host/auto-review.ts";
import { appendLine } from "../host/jsonl.ts";
import { JUDGE_LEDGERS, provenanceOf } from "../host/judge-record.ts";
import { outputDigestOf } from "../evals/corpus.ts";
import { calibrationRoute } from "./calibration-routes.ts";

const TOKEN = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ab";

async function installation() {
  const root = mkdtempSync(join(tmpdir(), "inv1773-routes-"));
  const registry = new AgentRegistry(join(root, "agents"));
  const ada = registry.create({ name: "Ada", boxId: registry.box.id }).id;
  const write = (ledger: keyof typeof JUDGE_LEDGERS) => (line: unknown) => appendLine(join(root, JUDGE_LEDGERS[ledger]), JSON.stringify(line));

  // A reply the answer review judged: the door kept the message, the transcript the turn.
  const asked = `Where is my parcel? The courier token is ${TOKEN}`;
  writeFileSync(join(root, "messages.jsonl"), `${JSON.stringify({ schema: "lumenbox.message/v1", id: "m1", channel: "feishu-personal", chatKey: "c", identity: "ou_p", senderLabel: "A person", conversationKey: "main", receivedAt: "2026-11-20T09:00:00Z", text: asked, textChars: asked.length })}\n`);
  registry.appendTranscript(ada, { role: "user", text: asked, at: "2026-11-20T09:00:01Z", causedBy: ["m1"], fromPerson: true, turnId: "t1" });
  registry.appendTranscript(ada, { role: "assistant", text: "I will look into it.", at: "2026-11-20T09:00:05Z", turnId: "t1" });
  await new AnswerReviewer({ ask: async () => JSON.stringify({ category: "NON_ANSWER", confidence: 0.9, reason: "r" }), mode: () => "shadow", model: () => "m", record: write("answer-review") })
    .review({ source: "member", agentName: "Ada", messageId: "m1", conversation: "main", request: asked, answer: "I will look into it." });

  // A call the auto-review judged: the transcript holds the call by its id.
  const input = { command: "git push origin main" };
  registry.appendTranscript(ada, { role: "user", text: "tidy the repo", at: "2026-11-20T10:00:01Z", fromPerson: true });
  registry.appendTranscript(ada, { role: "assistant", kind: "blocks", blocks: [{ type: "tool_use", id: "toolu_1", name: "bash", input }], at: "2026-11-20T10:00:02Z" });
  await new AutoReviewer({ ask: async () => JSON.stringify({ verdict: "BLOCK", reason: "r" }), mode: () => "shadow", model: () => "m", record: write("auto-review") })
    .review({ agentName: "Ada", trusted: ["tidy the repo"], untrusted: [], tool: "bash", input, why: "w", callId: "toolu_1", conversation: "main" });
  // One whose call is no longer in any transcript: left out, and counted.
  await new AutoReviewer({ ask: async () => JSON.stringify({ verdict: "ALLOW", reason: "r" }), mode: () => "shadow", model: () => "m", record: write("auto-review") })
    .review({ agentName: "Ada", trusted: [], untrusted: [], tool: "bash", input: { command: "git push x" }, why: "w", callId: "toolu_gone", conversation: "main" });

  // A memory the judge cleared, kept in the agent's ledger.
  registry.appendMemoryRecords(ada, [{ at: "2026-11-20T11:00:00Z", kind: "fact", text: "they use pnpm" }]);
  for (const question of ["memory-judge:fromContent", "memory-judge:duplicate"]) {
    write("memory-judge")({ at: "2026-11-20T11:00:00Z", agent: ada, ...provenanceOf(question, { path: "own", model: "m", version: "v" }, outputDigestOf("they use pnpm")), judged: "absent", confidence: 0.9 });
  }
  return { root, registry, ada, done: () => rmSync(root, { recursive: true, force: true }) };
}

const deps = (root: string, registry: AgentRegistry, body: Record<string, unknown> = {}, admin = true) => ({
  home: root, registry, readJson: async () => body, refusedAdmin: () => !admin, mayReadAgent: () => true, labeller: () => BY, now: () => new Date("2026-11-20T12:00:00Z"),
});
const BY = "synthetic test labeller";

test("the sheet shows what the judge read, found again where it is already kept, scrubbed, and never the judge's answer", async () => {
  const { root, registry, done } = await installation();
  try {
    const got = await calibrationRoute("GET /api/calibration", deps(root, registry));
    const body = got!.body as { judges: { judge: string; calibrated: boolean; questions: { question: string; dimension: string }[] }[]; sheet: { items: { question: string; parts: { key: string; text: string }[] }[]; unshown: number } };
    assert.ok(body.judges.every(judge => !judge.calibrated), "no labels: nothing is calibrated");
    assert.equal(body.judges.find(one => one.judge === "answer-review")!.questions[0]!.dimension, "satisfaction");
    const by = Object.fromEntries(body.sheet.items.map(item => [item.question, item.parts]));
    assert.deepEqual(Object.keys(by).sort(), ["answer-review:not-answered", "auto-review:unauthorised", "memory-judge:fromContent"], "a duplicate needs the line it was compared with: never asked");
    assert.equal(by["answer-review:not-answered"]![1]!.text, "I will look into it.");
    assert.ok(!by["answer-review:not-answered"]![0]!.text.includes(TOKEN), "a credential-shaped string is masked");
    assert.deepEqual(by["auto-review:unauthorised"]!.map(part => [part.key, part.text.slice(0, 13)]), [["said", "Where is my p"], ["said", "tidy the repo"], ["call", "bash {\n  \"com"]], "the person's latest words before the call, then the call");
    assert.deepEqual(by["memory-judge:fromContent"], [{ key: "memory", text: "they use pnpm" }]);
    assert.equal(body.sheet.unshown, 1, "the call no transcript holds");
    assert.ok(!JSON.stringify(body.sheet).includes("NON_ANSWER") && !JSON.stringify(body.sheet).includes("BLOCK"), "a person shown the verdict agrees with it");
  } finally {
    done();
  }
});

test("a label is signed and kept, leaves the sheet, and only a verdict the installation holds can be labelled — by an admin", async () => {
  const { root, registry, done } = await installation();
  try {
    const digest = outputDigestOf("they use pnpm");
    const ok = await calibrationRoute("POST /api/calibration/label", deps(root, registry, { question: "memory-judge:fromContent", digest, label: "absent" }));
    assert.equal(ok!.status, 200);
    assert.deepEqual(JSON.parse(readFileSync(join(root, "judge-labels.jsonl"), "utf8").trim()), { question: "memory-judge:fromContent", outputDigest: digest, label: "absent", by: BY, at: "2026-11-20T12:00:00.000Z" });
    const after = (await calibrationRoute("GET /api/calibration", deps(root, registry)))!.body as { labels: number; sheet: { items: { question: string }[] } };
    assert.equal(after.labels, 1);
    assert.ok(!after.sheet.items.some(item => item.question === "memory-judge:fromContent"));

    for (const wrong of [{ question: "memory-judge:duplicate", digest, label: "absent" }, { question: "memory-judge:fromContent", digest: outputDigestOf("never judged"), label: "present" }, { question: "memory-judge:fromContent", digest, label: "maybe" }]) {
      assert.equal((await calibrationRoute("POST /api/calibration/label", deps(root, registry, wrong)))!.status, 400, JSON.stringify(wrong));
    }
    assert.equal((await calibrationRoute("GET /api/calibration", deps(root, registry, {}, false)))!.status, 0, "refused, and the refusal already sent");
    assert.equal(await calibrationRoute("GET /api/elsewhere", deps(root, registry)), undefined);
  } finally {
    done();
  }
});
