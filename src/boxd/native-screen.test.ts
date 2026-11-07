/**
 * A node's open screen as the box's desktop 1, behind the same gates as any desktop (INV-1707).
 * The hands are fakes: nothing here touches a real screen or asks macOS for a permission.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DisplayManager, DisplayOwnershipError, UserInControlError } from "./displays.ts";
import { NATIVE_SCREEN_INDEX, nativeScreenFor } from "./native-screen.ts";
import { headlessRefusal } from "./headless.ts";
import type { ComputerExecutionError } from "../cua/execution.ts";
import type { HelperRequest, MacScreenPorts } from "../cua/macos-executor.ts";

function screen(options: { onHelper?: (request: HelperRequest) => void } = {}) {
  const sent: HelperRequest[] = [];
  const ports: MacScreenPorts = {
    async helper(request, authorize) {
      authorize();
      if (request.op === "state") return { ok: true, screen: true, input: true, width: 1440, height: 900, cursor: { x: 0, y: 0 } };
      options.onHelper?.(request);
      authorize();
      sent.push(request);
      return { ok: true };
    },
    async capture(_width, authorize) { authorize(); return Buffer.from("PNG"); },
  };
  let stop: (() => void) | undefined;
  const native = nativeScreenFor({ headless: true, enabled: true, platform: "darwin", ports, screenshotDelayMs: 0, log: () => {}, onStop: close => { stop = close; } })!;
  const dir = mkdtempSync(join(tmpdir(), "inv1707-native-screen-"));
  const displays = new DisplayManager(() => {}, dir, native.runtime);
  // What boxd's /computer does before every input (main.ts handleComputer).
  const authorize = () => { displays.assertAgentControls(NATIVE_SCREEN_INDEX); };
  return { native, displays, sent, authorize, stop: () => stop?.(), cleanup: () => { rmSync(dir, { recursive: true, force: true }); rmSync(`/tmp/agentbox-display-${NATIVE_SCREEN_INDEX}.owner`, { force: true }); } };
}

test("the screen opens only on a headless box whose node asked for it, and only on macOS", () => {
  const base = { log: () => {}, onStop: () => {} };
  assert.equal(nativeScreenFor({ ...base, headless: true, enabled: false, platform: "darwin" }), undefined, "host up never opens it");
  assert.equal(nativeScreenFor({ ...base, headless: false, enabled: true, platform: "darwin" }), undefined, "a container has its own desktops");
  const lines: string[] = [];
  assert.equal(nativeScreenFor({ ...base, log: line => lines.push(line), headless: true, enabled: true, platform: "linux" }), undefined);
  assert.match(lines.join("\n"), /macOS only/);
  assert.ok(nativeScreenFor({ ...base, headless: true, enabled: true, platform: "darwin", ports: { helper: async () => ({}), capture: async () => Buffer.from("") } }));
});

test("the machine's screen is desktop 1 and nothing else, one agent at a time, and is never stopped", async () => {
  const s = screen();
  try {
    const desktop = await s.displays.ensure(NATIVE_SCREEN_INDEX, "token-ada");
    assert.equal(desktop.display, "native");
    assert.equal(desktop.executor.capabilities.backend, "macos-cg");
    await assert.rejects(s.displays.ensure(2, "token-ada"), DisplayOwnershipError, "a second desktop would be a second name for one screen");
    await assert.rejects(s.displays.ensure(NATIVE_SCREEN_INDEX, "token-rex"), DisplayOwnershipError, "a second agent does not get the screen");
    const result = await desktop.executor.execute([{ action: "click", coordinate: [10, 10] }], { authorize: s.authorize });
    assert.equal(result.success, true);
    await s.displays.reapIdle();
    assert.ok(s.displays.has(NATIVE_SCREEN_INDEX), "the machine's screen is never reaped");
    assert.ok(s.displays.resources().desktops.some(entry => entry.index === NATIVE_SCREEN_INDEX && entry.retained_reason !== undefined));
  } finally { s.cleanup(); }
});

test("a person's takeover stops the agent at the next input, and nothing more reaches the screen until they hand back", async () => {
  let takeOver = () => {};
  const s = screen({ onHelper: request => { if (request.op === "click") takeOver(); } });
  takeOver = () => { s.displays.takeOver(NATIVE_SCREEN_INDEX); };
  try {
    const desktop = await s.displays.ensure(NATIVE_SCREEN_INDEX, "token-ada");
    await assert.rejects(desktop.executor.execute([{ action: "click", coordinate: [5, 5] }, { action: "type", text: "hello" }], { authorize: s.authorize }), (error: unknown) => {
      assert.ok((error as ComputerExecutionError).original instanceof UserInControlError);
      return true;
    });
    assert.equal(s.sent.length, 0, "the click's own receipt check saw the takeover; the typing never started");
    await assert.rejects(desktop.executor.execute([{ action: "key", key: "Return" }], { authorize: s.authorize }), (error: unknown) => (error as ComputerExecutionError).original instanceof UserInControlError);
    assert.equal(s.sent.length, 0);
    s.displays.handBack(NATIVE_SCREEN_INDEX);
    await desktop.executor.execute([{ action: "key", key: "Return" }], { authorize: s.authorize });
    assert.deepEqual(s.sent.map(request => request.op), ["key"]);
  } finally { s.cleanup(); }
});

test("once the daemon stops, the batch in flight sends nothing more and no new one starts", async () => {
  let stopNow: () => void = () => {};
  const s = screen({ onHelper: request => { if (request.op === "click") stopNow(); } });
  stopNow = s.stop;
  try {
    const desktop = await s.displays.ensure(NATIVE_SCREEN_INDEX, "token-ada");
    await assert.rejects(desktop.executor.execute([{ action: "click", coordinate: [5, 5] }, { action: "type", text: "after the stop" }], { authorize: s.authorize }), /closed/);
    assert.deepEqual(s.sent, [], "zero input after the stop");
    await assert.rejects(desktop.executor.execute([{ action: "screenshot" }], { authorize: s.authorize }), /closed/);
  } finally { s.cleanup(); }
});

test("with the screen open the box serves the computer tool and a takeover, and still nothing else that needs a desktop", () => {
  for (const route of ["POST /computer", "POST /displays/ensure", "POST /displays/control", "GET /displays"]) {
    assert.equal(headlessRefusal(route, true), undefined, route);
    assert.match(headlessRefusal(route) ?? "", /no desktop/, `${route} stays refused on a box whose screen is not open`);
  }
  for (const route of ["POST /browser", "POST /record/start", "POST /clipboard/read", "POST /teach/start"]) {
    assert.match(headlessRefusal(route, true) ?? "", /machine's own/, route);
  }
});
