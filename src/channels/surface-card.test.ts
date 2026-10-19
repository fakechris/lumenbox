/**
 * A card read into a chat: the lines are the components in document order, the buttons
 * are the presses, and the words path says exactly what to type. The mapping is the part
 * that can be wrong quietly — a button that speaks a different line from the page's
 * would split one card into two conversations.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { buttonText, surfaceCard, surfaceText } from "./surface-card.ts";
import type { A2uiMessage } from "../host/show-ui-catalog.ts";

const messages: A2uiMessage[] = [
  { version: "v0.9", createSurface: { surfaceId: "plan", catalogId: "x" } },
  {
    version: "v0.9",
    updateComponents: {
      surfaceId: "plan",
      components: [
        { id: "root", component: "Column", children: ["h", "line", "d", "pick", "name", "row"] },
        { id: "h", component: "Text", text: "Which plan?", variant: "h3" },
        { id: "line", component: "Text", text: { path: "/note" } },
        { id: "d", component: "Divider" },
        { id: "pick", component: "ChoicePicker", label: "Plan", options: [{ label: "Plan A", value: "a" }, { label: "Plan B", value: "b" }], value: { path: "/plan" } },
        { id: "name", component: "TextField", label: "Your name", value: { path: "/name" } },
        { id: "row", component: "Row", children: ["go", "skip"] },
        { id: "go", component: "Button", child: "gol", action: { event: { name: "confirm", context: { plan: { path: "/plan" }, fixed: "yes" } } } },
        { id: "gol", component: "Text", text: "Confirm" },
        { id: "skip", component: "Button", child: "skipl", action: { event: { name: "skip" } } },
        { id: "skipl", component: "Text", text: "Skip" },
      ],
    },
  },
  { version: "v0.9", updateDataModel: { surfaceId: "plan", path: "/", value: { note: "Two plans, one week.", plan: ["a"], name: "" } } },
];

test("the lines follow the document order and read bindings from the data model", () => {
  const card = surfaceCard({ surfaceId: "plan", agentName: "Ada", title: "Plans", messages });
  assert.deepEqual(card.lines, ["**Which plan?**", "Two plans, one week.", "---", "Plan", "· Plan A", "· Plan B", "Your name：在聊天里回复"]);
});

test("a Button is a press with its static context and the bound values as they are now; a ChoicePicker option chooses", () => {
  const card = surfaceCard({ surfaceId: "plan", agentName: "Ada", messages });
  assert.deepEqual(card.buttons.map(button => button.label), ["Plan A", "Plan B", "Confirm", "Skip"]);
  assert.equal(buttonText(card, card.buttons[0]!), '[Action "choose" on card plan: {"pick":["a"]}]');
  assert.equal(buttonText(card, card.buttons[2]!), '[Action "confirm" on card plan: {"plan":["a"],"fixed":"yes"}]');
  assert.equal(buttonText(card, card.buttons[3]!), '[Action "skip" on card plan]');
});

test("the words path carries the title, the lines and what to type for each press", () => {
  const text = surfaceText(surfaceCard({ surfaceId: "plan", agentName: "Ada", title: "Plans", messages }));
  assert.ok(text.startsWith("**Plans**\n**Which plan?**"), text);
  assert.match(text, /Skip：回复 \[Action "skip" on card plan\]/);
});

test("a closed surface reads as nothing; a cycle in children does not loop", () => {
  const closed = surfaceCard({ surfaceId: "plan", agentName: "Ada", messages: [...messages, { version: "v0.9", deleteSurface: { surfaceId: "plan" } }] });
  assert.deepEqual(closed.lines, []);
  const loop = surfaceCard({
    surfaceId: "s",
    agentName: "Ada",
    messages: [{ version: "v0.9", updateComponents: { surfaceId: "s", components: [{ id: "root", component: "Column", children: ["a"] }, { id: "a", component: "Column", children: ["root"] }] } }],
  });
  assert.deepEqual(loop.lines, []);
});

test("a Table reads as a heading line and the first rows, then how many more are in the app (INV-1280)", () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ name: `f${i}.txt`, size: i * 10 }));
  const card = surfaceCard({
    surfaceId: "files",
    agentName: "Ada",
    messages: [
      { version: "v0.9", updateComponents: { surfaceId: "files", components: [{ id: "root", component: "Table", columns: [{ key: "name", label: "Name" }, { key: "size", label: "Size" }], rows: { path: "/rows" }, caption: "bytes" }] } },
      { version: "v0.9", updateDataModel: { surfaceId: "files", path: "/", value: { rows } } },
    ],
  });
  assert.equal(card.lines[0], "**Name** | **Size**");
  assert.equal(card.lines[1], "f0.txt | 0");
  assert.equal(card.lines[8], "f7.txt | 70");
  assert.equal(card.lines[9], "… 2 more rows in the app");
  assert.equal(card.lines[10], "bytes");
});

test("an Approve is two presses in a chat, Progress is a checklist, Code is fenced (INV-1280)", () => {
  const card = surfaceCard({
    surfaceId: "d", agentName: "Ada",
    messages: [{ version: "v0.9", updateComponents: { surfaceId: "d", components: [
      { id: "root", component: "Column", children: ["p", "c", "a"] },
      { id: "p", component: "Progress", title: "Deploy", steps: [{ label: "build", status: "done" }, { label: "test", status: "doing" }] },
      { id: "c", component: "Code", text: "x", title: "f.ts" },
      { id: "a", component: "Approve", title: "Ship it?", onApprove: { event: { name: "approve" } }, onReject: { event: { name: "reject", context: { why: "no" } } } },
    ] } }],
  });
  assert.deepEqual(card.lines.slice(0, 3), ["**Deploy 1/2**", "[x] build", "[~] test"]);
  assert.deepEqual(card.lines.slice(3, 7), ["**f.ts**", "```", "x", "```"]);
  assert.equal(card.lines[7], "**Ship it?**");
  assert.deepEqual(card.buttons, [{ label: "Allow", name: "approve" }, { label: "Reject", name: "reject", context: { why: "no" } }]);
  assert.equal(buttonText(card, card.buttons[0]!), '[Action "approve" on card d]');
});
