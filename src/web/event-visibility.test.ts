import { test } from "node:test";
import assert from "node:assert/strict";
import { mayReadScopedEvent } from "./event-visibility.ts";
const access = {
  agent: (id: string) => id === "mine",
  box: (id: string) => id === "shared",
  task: (id: string) => id === "my-task",
  defaultBox: "shared",
};
test("member streams preserve box setup, health and owned task notices without exposing private scopes", () => {
  for (const event of [
    { type: "box_setup", done: true },
    { type: "error", boxId: "shared" },
    { type: "task_aging", taskId: "my-task" },
    { type: "error", agentId: "mine" },
    { type: "activation_progress" }, // "re-read", with nothing in it: the read is the Admin's route
  ])
    assert.equal(mayReadScopedEvent(event, access), true);
  for (const event of [
    { type: "error", boxId: "private" },
    { type: "task_aging", taskId: "other-task" },
    { type: "error", message: "unknown private details" },
    { type: "error", agentId: "missing" },
    { type: "activation_progress", name: "somebody" }, // anything put in it is not carried unscoped
  ])
    assert.equal(mayReadScopedEvent(event, access), false);
});
test("a message between agents requires visibility of both endpoints", () => {
  assert.equal(mayReadScopedEvent({ type: "message_sent", fromId: "mine", toId: "other" }, access), false);
  assert.equal(mayReadScopedEvent({ type: "message_sent", fromId: "mine", toId: "mine" }, access), true);
});
