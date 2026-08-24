/**
 * The state→card mapping, which can be wrong quietly: a done card that stays blue, or
 * a queued one that hides its position, misleads a room at a glance — and nothing else
 * in the system would notice.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { looksLikeMarkdown, markdownPost, renderCard } from "./feishu.ts";
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
  assert.match(queued.elements[0]!.text!.content, /Queued — 2 ahead/);
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
  assert.match(card.elements[0]!.text!.content, /\*\*Rex\*\* · Working/);
  assert.match(card.elements[0]!.text!.content, /`bash: build-report`/);
  const note = card.elements.find(element => element.tag === "note");
  assert.match(note!.elements![0]!.content, /chris/);

  // No addressed agent: the team as a whole is on it, and the card says so rather
  // than showing an empty name.
  const team = rendered({ title: "t", agentName: "", requesterLabel: "c", status: "working" });
  assert.match(team.elements[0]!.text!.content, /\*\*The team\*\*/);
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
  }) as {
    header: { title: { content: string }; template: string };
    elements: {
      tag: string;
      text?: { content: string };
      actions?: { text: { content: string }; value: { approval: string; reply: string } }[];
    }[];
  };
  assert.equal(card.header.template, "orange");
  assert.match(card.header.title.content, /Ada needs your consent/);
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
  assert.match(action.actions![0]!.text.content, /workshop/i);
});
