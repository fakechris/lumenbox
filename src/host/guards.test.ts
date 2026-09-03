import { test } from "node:test";
import assert from "node:assert/strict";
import {
  guardFor,
  guardsEnabled,
  nudgeFor,
  offersToCheck,
  readsAsChinese,
  trailingIntent,
  verdictWithoutCheck,
} from "./guards.ts";

test("the incident's own sentences trip the verdict guard; honest ignorance does not", () => {
  const bob =
    "我先说一个可能影响你选型的事：**Qwen 没有 27B**（Qwen3 的稠密档位是 14B / 32B，27B 是 Gemma 3 的规格），" +
    "**GLM 目前公开到 4.x（GLM-4.5-Air / GLM-4-Flash），没有 5.3-flash**。";
  assert.equal(verdictWithoutCheck(bob), true);
  assert.equal(verdictWithoutCheck("消费级没有 RTX 4090 48G 版本。如果作者用的是 48G 卡, 最可能是 RTX 6000 Ada"), true);
  assert.equal(verdictWithoutCheck("Thor T5000 不存在"), true);
  assert.equal(verdictWithoutCheck("GLM-5.2 这个型号有水分，官方旗舰一般是 4.5"), true);
  assert.equal(verdictWithoutCheck("The Zephyrus QX-880 does not exist; you probably mean the ROG Zephyrus."), true);
  assert.equal(verdictWithoutCheck("Qwen's latest public release is 2.5, so 3.8 is not yet released."), true);
  // Not verdicts: not knowing, asking, and a ruling about the person's own numbers.
  assert.equal(verdictWithoutCheck("我不确定这个型号，需要查一下。"), false);
  assert.equal(verdictWithoutCheck("I don't know this model; let me search."), false);
  assert.equal(verdictWithoutCheck("你的公式里 88.5 × 365 是全年，不是工作日。"), false);
});

test("offering to check is caught in both languages; actually checking is not", () => {
  for (const line of [
    "要不要我现在去核 WIRED 原文？如果要我就开干。",
    "需要的话我就去查一下官方页面。",
    "如果你想确认，我可以去核实一下。",
    "Want me to check the vendor page? I can verify if you like.",
    "Let me know if you want me to look it up.",
  ]) {
    assert.equal(offersToCheck(line), true, line);
  }
  for (const line of ["我查了官方页面：2026 年 8 月 14 日发布。", "Checked: released 2026-08-14.", "要不要我清掉它们？"]) {
    assert.equal(offersToCheck(line), false, line);
  }
});

test("a short reply that ends on 'I'll check now' is a trailing intent; a long one or a done one is not", () => {
  assert.equal(trailingIntent("你说得对，我先查一下。"), true);
  assert.equal(trailingIntent("Good point. Let me check the release page now."), true);
  assert.equal(trailingIntent("我查完了：两个都在 8 月 14 日发布。"), false);
  assert.equal(trailingIntent("我先查一下。".padEnd(500, "补充说明")), false, "long replies are answers, not acks");
  assert.equal(trailingIntent("Let me check that first — done, it exists, released in August."), false);
});

test("the structural condition gates the verdict and offer guards; trailing intent applies always", () => {
  const verdict = "GLM 目前公开到 4.x，没有 5.3。";
  assert.equal(guardFor(verdict, 0), "verdict-without-check");
  assert.equal(guardFor(verdict, 2), undefined, "a ruling after a tool ran is the model's to make");
  assert.equal(guardFor("要不要我去查？", 0), "offers-to-check");
  assert.equal(guardFor("要不要我去查？", 1), undefined);
  assert.equal(guardFor("我先查一下。", 3), "trailing-intent");
  assert.equal(guardFor("查完了，都在。", 0), undefined);
});

test("nudges are written in the person's language, and the switch turns everything off", () => {
  assert.match(nudgeFor("verdict-without-check", true), /先用工具/);
  assert.match(nudgeFor("verdict-without-check", false), /check it with a tool/);
  assert.match(nudgeFor("offers-to-check", true), /不需要征求许可/);
  assert.match(nudgeFor("trailing-intent", false), /Do it in this response/);
  assert.equal(readsAsChinese("GLM-5.3 和 Qwen3.8-27B 都是新发布的！"), true);
  assert.equal(readsAsChinese("Is GLM-5.3 real?"), false);
  assert.equal(guardsEnabled({}), true);
  assert.equal(guardsEnabled({ AGENTBOX_GUARDS: "0" }), false);
});
