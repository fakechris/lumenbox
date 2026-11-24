import { test } from "node:test";
import assert from "node:assert/strict";
import { SharedBoxStart } from "./shared-box-start.ts";

test("INV-2041: every member sees the same startup state and duplicate starts are rejected", async () => {
  let release!: (result: { connected: boolean; detail: string }) => void;
  const gate = new Promise<{ connected: boolean; detail: string }>(resolve => { release = resolve; });
  let finish!: () => void;
  const completed = new Promise<void>(resolve => { finish = resolve; });
  let starts = 0;
  const service = new SharedBoxStart({
    kubernetes: false,
    current: () => ({ connected: false, detail: "offline" }),
    up: () => { starts++; return gate; },
    broadcast: event => {
      assert.equal(service.starting, !event.done);
      if (event.done) finish();
    },
  });
  assert.equal(service.request().status, 202);
  assert.equal(service.starting, true);
  assert.equal(service.request().status, 409);
  assert.equal(starts, 1);
  release({ connected: false, detail: "start failed" });
  await completed;
  assert.equal(service.starting, false);
});
