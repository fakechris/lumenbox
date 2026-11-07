/** Built-in prompt parts (INV-1465): an override applies, a moved default is flagged, the three decisions, and words equal to the default drop the file. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decidePart, definePart, hashOf, parseOverride, partIn, partText, partView, strayOverrides } from "./prompt-parts.ts";

definePart({ key: "conduct", title: "How a turn works", about: "test", titleZh: "一个回合怎么进行", aboutZh: "测试", text: "Reply first.\nWork out loud." });

function temp(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-prompt-parts-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("the prompt reads the override when one is on file, else the default; an edit equal to the default drops the file", () => {
  const { dir, cleanup } = temp();
  try {
    assert.equal(partText("conduct", dir), "Reply first.\nWork out loud.");
    assert.equal(partView({ key: "conduct", title: "", about: "", titleZh: "", aboutZh: "", text: "Reply first.\nWork out loud." }, dir).status, "default");
    let view = decidePart("conduct", { kind: "edit", text: "Reply first, always.\nWork out loud." }, dir);
    assert.equal(view.status, "overridden");
    // The page reads the title and the line in its language; the words agents read do not change (INV-1686).
    assert.deepEqual([partIn(view, "zh").title, partIn(view, "en").title, partIn(view, "zh").text], ["一个回合怎么进行", "How a turn works", view.text]);
    assert.equal(view.override?.base, hashOf("Reply first.\nWork out loud."));
    assert.equal(partText("conduct", dir), "Reply first, always.\nWork out loud.");
    view = decidePart("conduct", { kind: "edit", text: "  Reply first.\nWork out loud.\n" }, dir);
    assert.equal(view.status, "default", "words equal to the default are not an override");
    assert.equal(existsSync(join(dir, "conduct.md")), false);
  } finally { cleanup(); }
});

test("a moved default marks the override default-updated; keep re-bases it, default removes it, edit writes against today's default", () => {
  const { dir, cleanup } = temp();
  try {
    writeFileSync(join(dir, "conduct.md"), "---\nbase: 0000000000000000\n---\nOur own words.\n");
    assert.equal(partView({ key: "conduct", title: "", about: "", titleZh: "", aboutZh: "", text: "Reply first.\nWork out loud." }, dir).status, "default-updated");
    assert.equal(partText("conduct", dir), "Our own words.", "the team's words still apply while they decide");
    const kept = decidePart("conduct", { kind: "keep" }, dir);
    assert.deepEqual([kept.status, kept.override?.text], ["overridden", "Our own words."]);
    assert.equal(decidePart("conduct", { kind: "default" }, dir).status, "default");
    assert.equal(partText("conduct", dir), "Reply first.\nWork out loud.");
    writeFileSync(join(dir, "typo.md"), "x");
    assert.deepEqual(strayOverrides(dir), ["typo.md"]);
    assert.deepEqual(parseOverride("no frontmatter at all"), { text: "no frontmatter at all", base: "" });
  } finally { cleanup(); }
});
