import { test } from "node:test";
import assert from "node:assert/strict";
import { CdpSession, withCdpAuthority } from "./cdp.ts";

test("CDP rechecks authority between commands, permits release, and keeps concurrent scopes separate", async () => {
  const sent: string[] = [];
  const session = Reflect.construct(CdpSession, ["fixture"]) as CdpSession;
  Reflect.set(session, "socket", {
    readyState: WebSocket.OPEN,
    send(raw: string) {
      const message = JSON.parse(raw);
      sent.push(`${message.method}:${message.params.type ?? ""}`);
      queueMicrotask(() => Reflect.get(session, "receive").call(session, JSON.stringify({ id: message.id, result: {} })));
    },
  });
  let allowed = true;
  await withCdpAuthority(() => { if (!allowed) throw new Error("revoked"); }, async () => {
    await session.send("Input.dispatchKeyEvent", { type: "keyDown" });
    allowed = false;
    await assert.rejects(session.send("Input.insertText", { text: "must not be sent" }), /revoked/);
    await session.send("Input.dispatchKeyEvent", { type: "keyUp" });
    await withCdpAuthority(() => {}, () => session.send("Runtime.evaluate", { expression: "1" }));
    await assert.rejects(session.send("Runtime.evaluate"), /revoked/);
  });
  allowed = true;
  await withCdpAuthority(() => { if (!allowed) throw new Error("revoked"); }, () => session.send("Runtime.evaluate"));
  allowed = false;
  // A callback can arrive after the request that attached this socket has ended.
  await assert.rejects(session.send("Page.handleJavaScriptDialog", {accept:true}), /revoked/);
  // A screenshot during human control may read, but cannot grant background input.
  await withCdpAuthority(() => {}, async () => {
    await session.send("Runtime.evaluate", {expression:"1"});
    await assert.rejects(session.send("Page.handleJavaScriptDialog", {accept:true}), /human control/);
  }, () => { throw new Error("human control"); });
  await assert.rejects(session.send("Page.handleJavaScriptDialog", {accept:true}), /human control/);
  assert.deepEqual(sent, ["Input.dispatchKeyEvent:keyDown", "Input.dispatchKeyEvent:keyUp", "Runtime.evaluate:", "Runtime.evaluate:", "Runtime.evaluate:"]);
});
