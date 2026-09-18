import { test } from "node:test";
import assert from "node:assert/strict";
import { diffSummary, editDiffOf, lineDiff } from "./line-diff.ts";

test("a one-line change is one minus and one plus, with the rest as context", () => {
  assert.deepEqual(lineDiff("a\nb\nc", "a\nB\nc"), [
    { op: " ", text: "a" },
    { op: "-", text: "b" },
    { op: "+", text: "B" },
    { op: " ", text: "c" },
  ]);
});

test("an insertion and a deletion are marked without disturbing the lines around them", () => {
  assert.deepEqual(lineDiff("a\nb", "a\nx\nb"), [{ op: " ", text: "a" }, { op: "+", text: "x" }, { op: " ", text: "b" }]);
  assert.deepEqual(lineDiff("a\nx\nb", "a\nb"), [{ op: " ", text: "a" }, { op: "-", text: "x" }, { op: " ", text: "b" }]);
});

test("identical texts are all context; an empty new text deletes every line", () => {
  assert.deepEqual(lineDiff("same", "same"), [{ op: " ", text: "same" }]);
  assert.deepEqual(lineDiff("gone\nalso", ""), [{ op: "-", text: "gone" }, { op: "-", text: "also" }]);
  assert.deepEqual(lineDiff("", "new"), [{ op: "+", text: "new" }]);
});

test("CRLF is read as newline so a Windows file does not diff every line", () => {
  assert.deepEqual(lineDiff("a\r\nb", "a\nb"), [{ op: " ", text: "a" }, { op: " ", text: "b" }]);
});

test("past the size cap the two blocks are shown whole rather than aligned", () => {
  const big = Array.from({ length: 401 }, (_, i) => `line ${i}`).join("\n");
  const lines = lineDiff(big, `${big}\nmore`);
  assert.equal(lines.filter(line => line.op === " ").length, 0);
  assert.equal(lines.filter(line => line.op === "-").length, 401);
  assert.equal(lines.filter(line => line.op === "+").length, 402);
});

test("only an edit_file call with both texts becomes a diff", () => {
  assert.deepEqual(editDiffOf("edit_file", { path: "/w/a.ts", old: "x", new: "y" }), {
    path: "/w/a.ts",
    lines: [{ op: "-", text: "x" }, { op: "+", text: "y" }],
  });
  assert.equal(editDiffOf("write_file", { path: "/w/a.ts", content: "x" }), undefined);
  assert.equal(editDiffOf("edit_file", { path: "/w/a.ts", old: "x" }), undefined, "a malformed call is shown as it was, not guessed at");
});

test("the summary counts what changed", () => {
  assert.equal(diffSummary(lineDiff("a\nb\nc", "a\nB\nC\nD")), "+3 −2");
});
