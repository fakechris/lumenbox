import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lastReply } from "./conversation-tail.ts";

test("a conversation's last reply is the agent's last plain answer, not its steps, the host's note or the person's words", () => {
  const dir = mkdtempSync(join(tmpdir(), "tail-"));
  try {
    const path = join(dir, "c.jsonl"), padding = "x".repeat(40_000);
    writeFileSync(path, [
      { role: "user", text: padding }, // pushes the start out of the window: the cut first line is skipped
      { role: "assistant", text: "Here is the breakdown: three layers.", at: "2026-11-16T05:56:00.000Z" },
      { role: "assistant", kind: "blocks", blocks: [{ type: "tool_use", id: "1", name: "bash", input: {} }] },
      { role: "assistant", text: "(no output)", host: true },
      { role: "user", text: "thanks" },
    ].map(entry => JSON.stringify(entry)).join("\n") + "\n");
    assert.deepEqual(lastReply(path), { text: "Here is the breakdown: three layers.", at: "2026-11-16T05:56:00.000Z" });
    assert.equal(lastReply(join(dir, "missing.jsonl")), undefined);
    // A long answer comes whole up to the page's limit, and says when it was cut.
    const long = join(dir, "long.jsonl"), answer = "长".repeat(9_000);
    writeFileSync(long, JSON.stringify({ role: "assistant", text: answer, at: "2026-11-16T06:43:56.531Z" }) + "\n");
    assert.deepEqual(lastReply(long), { text: answer.slice(0, 8_000), cut: true, at: "2026-11-16T06:43:56.531Z" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
