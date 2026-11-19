/** A delivery read back into its parts (INV-1922): what a person is shown depends on this reading being forgiving. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DELIVERY_ORDER, DELIVERY_SECTIONS, deliveryLabel, limitsOwedToChat, parseDelivery, saysNone } from "./delivery-report.ts";
import { TaskStore } from "./tasks.ts";

test("a note written in the order reads as its parts, in either language and however the names are dressed", () => {
  const en = parseDelivery([
    "The export now keeps the time zone.",
    "Main change: `src/export.ts:41` formats in the account's zone — look at the DST branch.",
    "Verified: 12 unit tests on commit 3f2a9c1.",
    "Not done or limits: not run against the live account.",
    "Next: you confirm one real export.",
  ].join("\n"));
  assert.deepEqual(en?.parts.map(part => part.key), ["result", "main", "verified", "limits", "next"], "what leads a note is its result; an optional part left out is left out");
  assert.equal(en?.parts[0]?.text, "The export now keeps the time zone.");
  assert.equal(en?.parts.find(part => part.key === "limits")?.text, "not run against the live account.");
  assert.equal(en?.lang, "en");

  const zh = parseDelivery("## 结论\n导出已保留时区。\n\n**主要改动：** 见 src/export.ts 第 41 行\n- 夏令时分支\n\n5. 未做与局限：线上账号没有验证\n⑥ 下一步: 你确认一次真实导出");
  assert.deepEqual(zh?.parts.map(part => part.key), ["result", "main", "limits", "next"]);
  assert.equal(zh?.parts[1]?.text, "见 src/export.ts 第 41 行\n- 夏令时分支", "a part runs until the next name");
  assert.equal(zh?.lang, "zh");

  // Out of order and said twice: still one part each, shown in the fixed order.
  const mixed = parseDelivery("Next: Bob reviews.\nLimits: no load test.\nResult: shipped.\nLimits: one flaky test left.");
  assert.deepEqual(mixed?.parts, [{ key: "result", text: "shipped." }, { key: "limits", text: "no load test.\none flaky test left." }, { key: "next", text: "Bob reviews." }]);
});

test("a note that is not written as a delivery is left as it was written", () => {
  for (const note of ["", "Done: see report.md", "Next: I will call the supplier tomorrow.", "Checked the numbers.\nAll three reports agree.", "Next week we verify.\nNot done yet"]) {
    assert.equal(parseDelivery(note), undefined, JSON.stringify(note));
  }
  assert.equal(parseDelivery("Here is the config:\n```\nNext: 1\nVerified: true\n```"), undefined, "names inside a code block are code");
  assert.equal(parseDelivery(undefined), undefined);
});

test("every part can be read back under the name it is asked for, and the prompt asks for all of them", () => {
  for (const key of DELIVERY_SECTIONS) for (const lang of ["en", "zh"] as const) {
    const label = deliveryLabel(key, lang);
    assert.deepEqual(parseDelivery(`${label}: x\n${deliveryLabel(key === "next" ? "main" : "next", lang)}: y`)?.parts.find(part => part.text === "x"), { key, text: "x" }, label);
    assert.ok(DELIVERY_ORDER.includes(label), `the rule names ${label}`);
  }
  assert.ok(saysNone("None.") && saysNone("无") && !saysNone("none of the live checks ran"));
});

test("a chat is told what was not verified when the reply left it out, once, and never for \"none\"", () => {
  const board = new TaskStore(null), fresh = () => limitsOwedToChat(id => board.get(id)), owed = fresh();
  const deliver = (note: string) => {
    const task = board.create({ title: "Fix the export", requester: "feishu:ou_1", assigneeId: "mia" })!;
    board.update(task.id, { status: "done", note }, "mia");
    return task.id;
  };
  const task = deliver("导出已修好。\n主要改动：src/export.ts\n未做与局限：线上账号没有验证\n下一步：你确认");
  assert.equal(owed(task, "修好了，看 src/export.ts。"), "未做与局限：线上账号没有验证");
  assert.equal(owed(task, "修好了。"), undefined, "said once for this delivery");
  assert.equal(fresh()(task, "修好了。\n未做与局限：线上没验证"), undefined, "the reply already carries the part");
  assert.equal(fresh()(deliver("Fixed.\nMain change: src/export.ts\nNot done or limits: none"), "Fixed."), undefined);
  assert.equal(fresh()(deliver("Fixed the export, not verified live."), "Fixed."), undefined, "a note not written in the order adds nothing");
  assert.equal(fresh()("t999", "Fixed."), undefined);
});
