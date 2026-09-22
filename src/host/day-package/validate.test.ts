/**
 * Tests for the rule that carries the whole feature.
 *
 * The ask had a parenthesis doing most of the work: summarise the day *across* it, not by
 * listing what happened. Whether a synthesis is good is a judgement and is not testable.
 * Whether it has given up and gone back to enumerating is a string fact, and that is what
 * these tests are about — including the case that matters most, a list whose headings have
 * been reworded so that a naive detector would wave it through.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  citationsIn,
  describeValidation,
  enumerationRun,
  headings,
  MAX_ENUMERATION_RUN,
  sentences,
  SHORT_VERSION_MAX_CHARS,
  validateDigest,
} from "./validate.ts";
import { similarity } from "../quote-check.ts";
import type { DayManifest } from "./assemble.ts";

const MESSAGES = [
  { id: "aaaaaaaa1111", text: "看看这个 agent 评估的帖子 https://x.com/a/status/1" },
  { id: "bbbbbbbb2222", text: "RAG 的 chunk 大小到底怎么选，有没有实测" },
  { id: "cccccccc3333", text: "这家公司的定价页改了，帮我看看变了什么" },
  { id: "dddddddd4444", text: "顺便查一下他们的融资情况" },
];

function manifest(over: Partial<DayManifest> = {}): DayManifest {
  return {
    schema: "lumenbox.day-package/v1",
    runKey: "2026-09-20-abc123",
    window: { date: "2026-09-20", from: "2026-09-19T16:00:00.000Z", to: "2026-09-20T16:00:00.000Z", offsetMinutes: 480 },
    messages: MESSAGES.map(one => ({ ...one, at: "2026-09-20T02:00:00.000Z", chars: one.text.length, source: "ledger" as const })),
    turns: [{ id: "77777777aaaa", at: "2026-09-20T02:01:00.000Z", about: "read the link" }],
    sources: [
      { key: "5f5f5f5f", state: "kept" as const, url: "https://example.com/a" },
      { key: "6a6a6a6a", state: "kept" as const, url: "https://example.com/b" },
    ],
    replies: [],
    gaps: [],
    redactions: { exact: 0, pattern: 0 },
    ...over,
  };
}

test("citations are found with their kind, and nothing else is mistaken for one", () => {
  const found = citationsIn("A claim [msg:aaaaaaaa] and a read [source:5f5f5f5f] and analysis [turn:77777777].");
  assert.deepEqual(
    found.map(one => `${one.kind}:${one.key}`),
    ["msg:aaaaaaaa", "source:5f5f5f5f", "turn:77777777"]
  );
  // A markdown link is not a citation, and neither is prose in brackets.
  assert.deepEqual(citationsIn("[a link](https://x.test) and [an aside] and [unit:x/1]"), []);
});

test("a digest that walks the day's messages in order is refused, and told why", () => {
  const list = `# 今天的内容

## 看看这个 agent 评估的帖子
读了。[msg:aaaaaaaa]

## RAG 的 chunk 大小到底怎么选
查了。[msg:bbbbbbbb]

## 这家公司的定价页改了
看了。[msg:cccccccc]

## 顺便查一下他们的融资情况
查到了。[msg:dddddddd]
`;
  const report = validateDigest({ draft: list, manifest: manifest() });
  assert.equal(report.ok, false);
  assert.ok(report.enumerationRun > MAX_ENUMERATION_RUN, `run was ${report.enumerationRun}`);
  const problem = report.problems.find(one => one.kind === "enumeration")!;
  assert.match(problem.detail, /walk the day's messages in order/);
  assert.match(problem.detail, /Organise by what the day was about/);
});

test("rewording the headings does not get a list past the gate", () => {
  // The first thing anybody would try. A detector that only caught verbatim headings
  // would be defeated by five minutes of paraphrasing, so the match is approximate.
  const reworded = `# 今天

## 关于 agent 评估的那个帖子
[msg:aaaaaaaa]

## chunk 大小怎么选这件事
[msg:bbbbbbbb]

## 那家公司改了定价页
[msg:cccccccc]
`;
  const report = validateDigest({ draft: reworded, manifest: manifest() });
  assert.ok(
    report.enumerationRun > MAX_ENUMERATION_RUN,
    `reworded headings still marched but scored only ${report.enumerationRun}`
  );
  assert.equal(report.ok, false);
});

test("a real synthesis passes, even when it has one section about one message", () => {
  // Organised by what the day was about. One heading happens to be close to one message,
  // which a day with one big thing in it legitimately produces — a run, not a count, is
  // why that is allowed.
  const synthesis = `# 2026-09-20

## 主线：评估这件事，两头都在说「先看数据」
两个来源在同一天指向同一条：先手动读真实记录，再决定评估什么 [source:5f5f5f5f] [msg:aaaaaaaa]。
定价页的改动也落在同一条线上 [source:6a6a6a6a] [msg:cccccccc]。

## 张力：chunk 大小的实测和这条主线并不一致
有人要的是参数表 [msg:bbbbbbbb]，而读到的材料说参数不是那个决定点 [source:5f5f5f5f]。
我的看法是这两件事问的不是同一个问题 [turn:77777777] [source:5f5f5f5f]。
`;
  const report = validateDigest({ draft: synthesis, manifest: manifest() });
  assert.deepEqual(report.problems, []);
  assert.equal(report.ok, true);
  assert.ok(report.enumerationRun <= MAX_ENUMERATION_RUN, `run was ${report.enumerationRun}`);
  assert.equal(report.citations.unresolved, 0);
  assert.equal(report.citations.byKind.source, 4);
});

test("a citation that is not in the package is named, not waved through", () => {
  const report = validateDigest({
    draft: "A claim about something [msg:99999999] and another [source:00000000].",
    manifest: manifest(),
  });
  assert.equal(report.citations.unresolved, 2);
  assert.equal(report.problems.filter(one => one.kind === "citation-unresolved").length, 2);
  assert.match(describeValidation(report).join("\n"), /\[msg:99999999\] is not in this package/);
});

test("the agent's own turn is not evidence for the agent's own claim", () => {
  const alone = validateDigest({
    draft: "我认为这一天真正的变化是评估方法 [turn:77777777]。",
    manifest: manifest(),
  });
  assert.equal(alone.problems[0]!.kind, "turn-without-backing");
  assert.match(alone.problems[0]!.detail, /cites only the agent's own turn/);

  // The same sentence with something behind it is fine.
  const backed = validateDigest({
    draft: "我认为这一天真正的变化是评估方法 [turn:77777777] [source:5f5f5f5f]。",
    manifest: manifest(),
  });
  assert.deepEqual(backed.problems, []);
});

test("a delta verb without a yesterday to compare against is a guess in measurement's clothes", () => {
  const draft = "评估这条线 STRENGTHENED 了 [source:5f5f5f5f] [msg:aaaaaaaa]。";
  const blind = validateDigest({ draft, manifest: manifest() });
  assert.equal(blind.problems[0]!.kind, "delta-without-baseline");
  assert.match(blind.problems[0]!.detail, /no previous day to compare against/);

  const withBaseline = validateDigest({ draft, manifest: manifest(), previousThemes: ["评估方法"] });
  assert.deepEqual(withBaseline.problems, []);
});

test("the short version is short, or it is not the short version", () => {
  const draft = "一句有据的话 [msg:aaaaaaaa]。";
  const long = validateDigest({ draft, manifest: manifest(), shortVersion: "字".repeat(SHORT_VERSION_MAX_CHARS + 1) });
  assert.equal(long.problems[0]!.kind, "short-version-too-long");
  assert.match(long.problems[0]!.detail, new RegExp(`${SHORT_VERSION_MAX_CHARS} is the limit`));

  const fine = validateDigest({ draft, manifest: manifest(), shortVersion: "字".repeat(SHORT_VERSION_MAX_CHARS) });
  assert.deepEqual(fine.problems, []);
});

test("a day with no messages cannot be an enumeration of them", () => {
  // Degenerate on purpose: the detector must not invent a march through nothing.
  const report = validateDigest({
    draft: "# Nothing arrived\n\nNo messages today.\n",
    manifest: manifest({ messages: [] }),
  });
  assert.equal(report.enumerationRun, 0);
  assert.deepEqual(report.problems, []);
});

test("sentences and headings are split the way the rules need them", () => {
  const split = sentences("第一句。第二句！第三句？\nA fourth one. And 3.5 is not an ending.");
  assert.equal(split.length, 5, JSON.stringify(split.map(one => one.text)));
  // A decimal point is not the end of a sentence, which is the one case worth handling.
  assert.match(split[4]!.text, /3\.5 is not an ending/);

  const found = headings("# One\n\ntext\n\n### Three\n\n#not a heading\n#  \n");
  assert.deepEqual(
    found.map(one => `${one.level}:${one.title}`),
    ["1:One", "3:Three"]
  );
});

test("the report groups its problems, because twelve of one thing is one thing to fix", () => {
  const draft = Array.from({ length: 12 }, (_, n) => `A claim [msg:zzzz${n}zzz].`).join("\n");
  const said = describeValidation(validateDigest({ draft, manifest: manifest() })).join("\n");
  assert.match(said, /citation-unresolved \(12\)/);
  assert.match(said, /… and 7 more/, "five shown, the rest counted");
});

test("the enumeration detector is exported on its own, so a skill can ask before it writes", () => {
  const marching = "## 看看这个 agent 评估的帖子\n## RAG 的 chunk 大小到底怎么选\n## 这家公司的定价页改了\n";
  assert.ok(enumerationRun(marching, MESSAGES) >= 3);
  // Out of order is not a march: a digest that returns to an earlier thread is organising.
  const organised = "## 这家公司的定价页改了\n## 看看这个 agent 评估的帖子\n## 这家公司的定价页改了\n";
  assert.ok(enumerationRun(organised, MESSAGES) < 3);
});

test("the citation shape catches what rewording gets past the headings", () => {
  // Why there are two signals. Measured: these reworded headings score 0.61 to 0.71
  // against the messages they were named after, so a heading test alone is a threshold
  // fight against whoever is rewording. The citation shape is exact and does not care.
  const scores = [
    similarity("关于 agent 评估的那个帖子", "看看这个 agent 评估的帖子 https://x.com/a/status/1"),
    similarity("chunk 大小怎么选这件事", "RAG 的 chunk 大小到底怎么选，有没有实测"),
    similarity("那家公司改了定价页", "这家公司的定价页改了，帮我看看变了什么"),
  ];
  assert.ok(Math.min(...scores) < 0.7, `the weakest reworded heading scored ${Math.min(...scores)}`);

  // Headings with nothing in common with any message, but the sections still march.
  const disguised = `## 第一件事
[msg:aaaaaaaa]

## 第二件事
[msg:bbbbbbbb]

## 第三件事
[msg:cccccccc]
`;
  assert.ok(enumerationRun(disguised, MESSAGES) >= 3, "the citations give it away");
  assert.equal(validateDigest({ draft: disguised, manifest: manifest() }).ok, false);

  // And a section that cites two messages is doing something other than listing one.
  const grouped = `## 一条线把两件事连起来
[msg:aaaaaaaa] 和 [msg:bbbbbbbb] 说的是同一件事。

## 另一条线
[msg:cccccccc] 和 [msg:dddddddd] 也是。
`;
  assert.ok(enumerationRun(grouped, MESSAGES) < 3, "grouping is not marching");
});
