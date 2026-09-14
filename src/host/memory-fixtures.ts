/**
 * The memory-selection fixtures (INV-147): what a turn must recall, may recall, and must
 * never recall, in six shapes that each broke something once.
 *
 * Synthetic, on purpose: real transcripts are private and stay local. These are a
 * regression floor, not a benchmark — twenty-four cases say "this shape works", not
 * "the selector is good". Every case names its required, allowed and forbidden records
 * by text, and the test checks them against candidates, the prompt body and the index.
 *
 *   relevant     — the fact the question is about, among distractors
 *   synonym      — the same fact in several phrasings, and one different fact that must survive
 *   conflict     — two facts that contradict; both stay, dated, for the reader to weigh
 *   retracted    — a fact withdrawn (and, once, re-recorded after the withdrawal)
 *   wrong-box    — a shared record from another box; never seen (tested against the registry)
 *   distractor   — long notes that would eat the budget around one short required fact
 */

import type { MemoryRecord } from "./memory.ts";

export interface MemoryFixture {
  id: string;
  shape: "relevant" | "synonym" | "conflict" | "retracted" | "wrong-box" | "distractor";
  query: string;
  records: MemoryRecord[];
  /** Character budget for the prompt body. */
  budget: number;
  /** Texts that must be in the body. */
  required: string[];
  /** Texts that may be in the body or the index. Everything else not forbidden is also allowed. */
  allowed?: string[];
  /** Texts that must appear nowhere: not the body, not the index, not the selector's candidates. */
  forbidden: string[];
  /** For wrong-box: which records live in the other box (by text). */
  otherBox?: string[];
}

const NOW = Date.parse("2026-09-13T00:00:00.000Z");
const DAY = 86_400_000;
const at = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();
const fact = (text: string, daysAgo = 1): MemoryRecord => ({ at: at(daysAgo), kind: "fact", text });
const note = (text: string, daysAgo = 1): MemoryRecord => ({ at: at(daysAgo), kind: "note", text });
const retraction = (text: string, daysAgo = 0): MemoryRecord => ({ at: at(daysAgo), kind: "retraction", text });

const DISTRACTORS = [
  "the office printer on floor 3 needs a toner change every six weeks",
  "the weekly sync moved to Thursdays at 10",
  "Mia prefers Slack over email for quick questions",
  "the marketing site is built with Astro and deployed on Vercel",
  "invoices go to accounts@ with the PO number in the subject",
  "the test suite takes about eight minutes on the CI runner",
  "Enzo owns the on-call rotation for September",
  "the design system lives in the figma file named Lumen UI",
];
const distractors = (n: number, daysAgo = 2): MemoryRecord[] => DISTRACTORS.slice(0, n).map(text => fact(text, daysAgo));
const longNote = (i: number) => note(`meeting ${i} notes: ${"discussed roadmap items and follow-ups; ".repeat(9)}nothing decided`, 1);

export const MEMORY_FIXTURES: readonly MemoryFixture[] = [
  // ── relevant ─────────────────────────────────────────────────────────────────────────
  { id: "relevant-region", shape: "relevant", query: "which region do we deploy to", budget: 220, records: [fact("the deployment region is eu-west-1", 40), ...distractors(8, 1)], required: ["the deployment region is eu-west-1"], forbidden: [] },
  { id: "relevant-db", shape: "relevant", query: "what is the database and where does it run", budget: 220, records: [fact("the production database is Postgres 16 on RDS", 30), ...distractors(8, 1)], required: ["the production database is Postgres 16 on RDS"], forbidden: [] },
  { id: "relevant-cjk", shape: "relevant", query: "数据库密码放在哪里", budget: 220, records: [fact("数据库密码保存在 vault 的 DB_PASSWORD 条目里", 20), ...distractors(8, 1)], required: ["数据库密码保存在 vault 的 DB_PASSWORD 条目里"], forbidden: [] },
  { id: "relevant-two", shape: "relevant", query: "how do we release and who signs off", budget: 260, records: [fact("releases are cut from main on Fridays", 25), fact("Chris signs off every release", 26), ...distractors(8, 1)], required: ["releases are cut from main on Fridays", "Chris signs off every release"], forbidden: [] },
  // ── synonym ──────────────────────────────────────────────────────────────────────────
  { id: "synonym-short-answers", shape: "synonym", query: "how should I answer and where do we deploy", budget: 200, records: [fact("the user prefers short answers", 1), note("user prefers short answers (said again)", 1), fact("the user prefers short answers, always", 1), note("prefers short answers — the user", 1), fact("the deployment region is eu-west-1", 30)], required: ["the deployment region is eu-west-1"], forbidden: [] },
  { id: "synonym-branch", shape: "synonym", query: "which branch and what is the budget", budget: 200, records: [fact("work happens on the develop branch", 1), fact("work happens on the develop branch (confirmed)", 1), note("the develop branch is where work happens", 1), fact("work happens on the develop branch, not main", 1), fact("the monthly API budget is $50", 15)], required: ["the monthly API budget is $50"], forbidden: [] },
  { id: "synonym-cjk", shape: "synonym", query: "部署到哪个区域，回复风格是什么", budget: 200, records: [fact("用户喜欢简短的回答", 1), fact("用户喜欢简短的回答（再次确认）", 1), note("用户喜欢简短的回答 说过", 1), fact("部署区域是 eu-west-1", 20)], required: ["部署区域是 eu-west-1"], forbidden: [] },
  { id: "synonym-many", shape: "synonym", query: "timezone and where is the runbook", budget: 260, records: [fact("the user is in the Asia/Shanghai timezone", 1), fact("the user is in the Asia/Shanghai timezone (Shanghai)", 1), note("user is in Asia/Shanghai timezone", 1), fact("the user is in the Asia/Shanghai timezone, confirmed", 1), note("timezone: the user is in Asia/Shanghai", 1), fact("the runbook is at /home/box/work/runbook.md", 12)], required: ["the runbook is at /home/box/work/runbook.md"], forbidden: [] },
  // ── conflict ─────────────────────────────────────────────────────────────────────────
  { id: "conflict-region", shape: "conflict", query: "which region do we deploy to", budget: 300, records: [fact("the deployment region is eu-west-1", 40), fact("the deployment region is us-east-1", 3)], required: ["the deployment region is eu-west-1", "the deployment region is us-east-1"], forbidden: [] },
  { id: "conflict-owner", shape: "conflict", query: "who owns the billing service", budget: 300, records: [fact("Mia owns the billing service", 60), fact("Enzo owns the billing service", 5)], required: ["Mia owns the billing service", "Enzo owns the billing service"], forbidden: [] },
  { id: "conflict-corrected", shape: "conflict", query: "which region do we deploy to", budget: 300, records: [fact("the deployment region is eu-west-1", 40), retraction("the deployment region is eu-west-1", 3), fact("the deployment region is us-east-1", 3)], required: ["the deployment region is us-east-1"], forbidden: ["the deployment region is eu-west-1"] },
  { id: "conflict-cjk", shape: "conflict", query: "发版日是哪天", budget: 300, records: [fact("发版日是周五", 30), fact("发版日是周三", 2)], required: ["发版日是周五", "发版日是周三"], forbidden: [] },
  // ── retracted ────────────────────────────────────────────────────────────────────────
  { id: "retracted-plain", shape: "retracted", query: "what is the api key name", budget: 300, records: [fact("the api key is stored under OLD_KEY", 20), retraction("the api key is stored under OLD_KEY", 2), ...distractors(3)], required: [], forbidden: ["the api key is stored under OLD_KEY"] },
  { id: "retracted-rephrased", shape: "retracted", query: "what is the api key name", budget: 300, records: [fact("The API key is stored under OLD_KEY.", 20), retraction("the api key is stored under old_key", 2), ...distractors(3)], required: [], forbidden: ["The API key is stored under OLD_KEY."] },
  { id: "retracted-then-rerecorded", shape: "retracted", query: "what is the api key name", budget: 300, records: [fact("the api key is stored under OLD_KEY", 20), retraction("the api key is stored under OLD_KEY", 5), fact("the api key is stored under OLD_KEY", 1), ...distractors(3)], required: ["the api key is stored under OLD_KEY"], forbidden: [] },
  { id: "retracted-cjk", shape: "retracted", query: "旧密码是什么", budget: 300, records: [fact("旧密码是 hunter2", 10), retraction("旧密码是 hunter2", 1), ...distractors(3)], required: [], forbidden: ["旧密码是 hunter2"] },
  // ── wrong-box ────────────────────────────────────────────────────────────────────────
  { id: "wrongbox-shared", shape: "wrong-box", query: "what did the finance team decide", budget: 400, records: [fact("finance decided to close the books on the 5th", 2), fact("our team ships on Fridays", 2)], required: ["our team ships on Fridays"], forbidden: ["finance decided to close the books on the 5th"], otherBox: ["finance decided to close the books on the 5th"] },
  { id: "wrongbox-everyone", shape: "wrong-box", query: "what is the company holiday policy", budget: 400, records: [{ ...fact("the company holiday policy is 20 days plus public holidays", 2), audience: "everyone" }, fact("our team ships on Fridays", 2)], required: ["the company holiday policy is 20 days plus public holidays", "our team ships on Fridays"], forbidden: [], otherBox: ["the company holiday policy is 20 days plus public holidays"] },
  { id: "wrongbox-secret", shape: "wrong-box", query: "what is the vpn address", budget: 400, records: [fact("the finance vpn is at 10.9.0.1", 2), fact("our vpn is at 10.8.0.1", 2)], required: ["our vpn is at 10.8.0.1"], forbidden: ["the finance vpn is at 10.9.0.1"], otherBox: ["the finance vpn is at 10.9.0.1"] },
  { id: "wrongbox-retraction-across", shape: "wrong-box", query: "who is on call", budget: 400, records: [fact("Enzo is on call this week", 3), fact("the finance on-call is Lee", 3)], required: ["Enzo is on call this week"], forbidden: ["the finance on-call is Lee"], otherBox: ["the finance on-call is Lee"] },
  // ── distractor ───────────────────────────────────────────────────────────────────────
  { id: "distractor-notes", shape: "distractor", query: "what is the deployment region", budget: 500, records: [fact("the deployment region is eu-west-1", 20), ...Array.from({ length: 6 }, (_, i) => longNote(i))], required: ["the deployment region is eu-west-1"], forbidden: [] },
  { id: "distractor-episodes", shape: "distractor", query: "where is the runbook", budget: 500, records: [fact("the runbook is at /home/box/work/runbook.md", 30), ...Array.from({ length: 6 }, (_, i) => ({ ...longNote(i), kind: "episode" as const }))], required: ["the runbook is at /home/box/work/runbook.md"], forbidden: [] },
  { id: "distractor-cjk", shape: "distractor", query: "部署区域", budget: 500, records: [fact("部署区域是 eu-west-1", 20), ...Array.from({ length: 6 }, (_, i) => note(`第${i}次会议记录：${"讨论了路线图和后续事项；".repeat(12)}没有结论`, 1))], required: ["部署区域是 eu-west-1"], forbidden: [] },
  { id: "distractor-old-fact", shape: "distractor", query: "what is the budget cap", budget: 500, records: [fact("the monthly API budget cap is $50", 120), ...Array.from({ length: 6 }, (_, i) => longNote(i))], required: ["the monthly API budget cap is $50"], forbidden: [] },
];
