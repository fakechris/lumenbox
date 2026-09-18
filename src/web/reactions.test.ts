import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REACTIONS, isReactionEmoji, readReactions, setReaction } from "./reactions.ts";

const scratch = () => join(mkdtempSync(join(tmpdir(), "reactions-")), "conversation.jsonl.reactions.json");

test("a message carries at most one reaction; setting again replaces, null clears", () => {
  const path = scratch();
  assert.deepEqual(readReactions(path), {}, "no file is no reactions");
  setReaction(path, { index: 3, emoji: "👍", by: "dana", at: "2026-09-18T00:00:00.000Z" });
  assert.deepEqual(readReactions(path), { "3": { emoji: "👍", by: "dana", at: "2026-09-18T00:00:00.000Z" } });
  setReaction(path, { index: 3, emoji: "🎉", by: "vic", at: "2026-09-18T00:01:00.000Z" });
  assert.equal(readReactions(path)["3"]!.emoji, "🎉", "one emoji per message: the later one replaces");
  assert.equal(readReactions(path)["3"]!.by, "vic");
  const after = setReaction(path, { index: 3, emoji: null, by: "vic" });
  assert.deepEqual(after, {});
});

test("only the fixed set is a reaction", () => {
  for (const emoji of REACTIONS) assert.equal(isReactionEmoji(emoji), true);
  assert.equal(isReactionEmoji("🍕"), false);
  assert.equal(isReactionEmoji("<script>"), false);
  assert.equal(isReactionEmoji(undefined), false);
});

test("a hand-edited or damaged file yields only the rows that are well-formed", () => {
  const path = scratch();
  writeFileSync(path, JSON.stringify({ "1": { emoji: "👍", by: "dana", at: "x" }, "2": { emoji: "🍕", by: "dana" }, abc: { emoji: "👍", by: "dana" }, "4": { emoji: "✅" } }));
  assert.deepEqual(Object.keys(readReactions(path)), ["1"]);
  writeFileSync(path, "not json");
  assert.deepEqual(readReactions(path), {});
});
