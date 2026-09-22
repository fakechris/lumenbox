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
  assert.deepEqual(sent, ["Input.dispatchKeyEvent:keyDown", "Input.dispatchKeyEvent:keyUp", "Runtime.evaluate:"]);
});
