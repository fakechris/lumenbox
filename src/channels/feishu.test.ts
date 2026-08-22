/**
 * The state→card mapping, which can be wrong quietly: a done card that stays blue, or
 * a queued one that hides its position, misleads a room at a glance — and nothing else
 * in the system would notice.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderCard } from "./feishu.ts";
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
