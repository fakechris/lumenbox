import { test } from "node:test";
import assert from "node:assert/strict";
import { replyForMessage } from "./reply.ts";

test("queued requests only receive prose from their own causal turn", () => {
  const entries = [
    { role: "user", causedBy: ["old"], turnId: "t1" },
    { role: "assistant", text: "old answer", turnId: "t1" },
    { role: "user", causedBy: ["new"], turnId: "t2" },
    { role: "assistant", kind: "blocks", text: "research notes", turnId: "t2" },
    { role: "assistant", text: "new answer", turnId: "t2" },
    { role: "assistant", text: "unattributed legacy prose" },
    { role: "user", causedBy: ["later"], turnId: "t3" },
    { role: "assistant", text: "later answer", turnId: "t3" },
  ];
  assert.equal(replyForMessage(entries, "old"), "old answer");
  assert.equal(replyForMessage(entries, "new"), "new answer");
  assert.equal(replyForMessage(entries, "missing"), "", "missing ownership cannot borrow another request's reply");
});
