import { test } from "node:test";
import assert from "node:assert/strict";
import { DesktopOperations } from "./desktop-operations.ts";

test("native/browser work serializes per desktop while other desktops remain independent", async () => {
  const queue = new DesktopOperations();
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const native = queue.run(1, async () => { order.push("native"); await gate; order.push("finished"); });
  const browser = queue.run(1, async () => { order.push("browser"); });
  await queue.run(2, async () => { order.push("other desktop"); });
  assert.deepEqual(order, ["native", "other desktop"]);
  release();
  await Promise.all([native, browser]);
  assert.deepEqual(order, ["native", "other desktop", "finished", "browser"]);
});

test("revocation is immediate; queued authorization runs after wait; failures release the queue", async () => {
  const queue = new DesktopOperations();
  let authorized = true;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first = queue.run(1, async () => { await gate; throw new Error("first failed"); });
  const second = queue.run(1, async () => { assert.ok(authorized, "revoked"); });
  authorized = false;
  release();
  await assert.rejects(first, /first failed/);
  await assert.rejects(second, /revoked/);
  assert.equal(await queue.run(1, async () => 42), 42);
});
