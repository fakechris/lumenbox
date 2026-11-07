/**
 * The Mac screen driver against fake hands (INV-1707). Nothing here captures, clicks or types on a
 * real screen, or asks macOS for anything: the ports are recorded, and the helper script is only
 * parsed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { helperReply, MAC_HELPER_SOURCE, MacExecutor, macKey, type HelperRequest, type MacScreenPorts, type ScreenState } from "./macos-executor.ts";
import { ComputerExecutionError, DesktopTargetError } from "./execution.ts";
import type { ComputerAction } from "../protocol/index.ts";

/** A Retina MacBook: 1440x900 points, so API (1280x800) coordinates scale by 1.125. */
function fake(state: Partial<ScreenState> = {}, options: { after?: Partial<ScreenState>; onHelper?: (request: HelperRequest) => void } = {}) {
  const sent: HelperRequest[] = [];
  const captures: number[] = [];
  let states = 0;
  const ports: MacScreenPorts = {
    async helper(request, authorize) {
      authorize();
      if (request.op === "state") {
        states++;
        const base = { screen: true, input: true, width: 1440, height: 900, cursor: { x: 720, y: 450 }, ...state };
        return { ok: true, ...(states > 1 && options.after !== undefined ? { ...base, ...options.after } : base) };
      }
      options.onHelper?.(request);
      sent.push(request);
      return { ok: true };
    },
    async capture(width, authorize) {
      authorize();
      captures.push(width);
      return Buffer.from("PNG");
    },
  };
  return { executor: new MacExecutor({ ports, screenshotDelayMs: 0 }), sent, captures };
}

test("a batch reaches the screen in points, and comes back with a PNG at API width", async () => {
  const { executor, sent, captures } = fake();
  const actions: ComputerAction[] = [
    { action: "click", coordinate: [640, 400] },
    { action: "type", text: "订单 42" },
    { action: "key", key: "cmd+s" },
    { action: "scroll", coordinate: [100, 100], direction: "down", amount: 2 },
  ];
  const result = await executor.execute(actions);
  assert.deepEqual(sent, [
    { op: "click", x: 720, y: 450, button: "left", count: 1, flags: 0 },
    { op: "type", text: "订单 42" },
    { op: "key", keycode: 1, flags: 0x100000, hold_ms: 0 },
    { op: "scroll", x: 113, y: 113, dy: -2, dx: 0, flags: 0 },
  ]);
  assert.deepEqual(captures, [1280], "one final capture, resampled to the API width");
  assert.equal(result.screenshot, Buffer.from("PNG").toString("base64"));
  assert.equal(result.screenshotMediaType, "image/png");
  assert.equal(result.progress?.dispatch, "sent");
  assert.equal(result.progress?.delivery, "delivered_unverified", "nothing measured whether it took");
  assert.equal(result.observation?.coordinate_space, "screen");
});

test("key chords are read the way the model writes them", () => {
  assert.deepEqual(macKey("ctrl+shift+t"), { keycode: 17, flags: 0x40000 | 0x20000 });
  assert.deepEqual(macKey("Return"), { keycode: 36, flags: 0 });
  assert.deepEqual(macKey("super+space"), { keycode: 49, flags: 0x100000 });
  assert.deepEqual(macKey("A"), { keycode: 0, flags: 0x20000 }, "a capital is the letter with shift");
  assert.equal(macKey("XF86AudioMute"), undefined);
  assert.equal(macKey("hyper+a"), undefined);
});

test("a permission macOS has not given refuses the batch before anything is sent, and never asks for it", async () => {
  for (const [state, pane] of [[{ screen: false }, "Screen Recording"], [{ input: false }, "Accessibility"]] as const) {
    const { executor, sent, captures } = fake(state);
    await assert.rejects(executor.execute([{ action: "click", coordinate: [10, 10] }]), (error: unknown) => {
      assert.ok(error instanceof ComputerExecutionError);
      assert.ok(error.original instanceof DesktopTargetError);
      assert.equal(error.original.code, "PERMISSION_DENIED");
      assert.match(error.message, new RegExp(pane));
      assert.equal(error.progress.dispatch, "not_started");
      assert.equal(error.progress.delivery, "not_delivered");
      return true;
    });
    assert.deepEqual(sent, [], `${pane}: no input`);
    assert.deepEqual(captures, [], `${pane}: no capture, which would itself prompt`);
  }
  // Looking needs only the screen.
  const { executor } = fake({ input: false });
  assert.equal((await executor.execute([{ action: "screenshot" }])).success, true);
});

test("a permission withdrawn while the batch ran is reported as unknown, not as done", async () => {
  const { executor, sent, captures } = fake({}, { after: { input: false } });
  await assert.rejects(executor.execute([{ action: "click", coordinate: [10, 10] }]), (error: unknown) => {
    assert.ok(error instanceof ComputerExecutionError);
    assert.equal((error.original as DesktopTargetError).code, "PERMISSION_DENIED");
    assert.match(error.message, /withdrew/);
    assert.equal(error.progress.dispatch, "sent", "the click had gone out");
    return true;
  });
  assert.equal(sent.length, 1);
  assert.deepEqual(captures, [], "no capture of a screen that is no longer ours to read");
});

test("what this screen cannot do is refused before the first action, and nothing is sent", async () => {
  for (const unsupported of [{ action: "list_windows" }, { action: "click_element", ref: "e1" }, { action: "activate_window", window_id: "1" }, { action: "key", key: "XF86AudioMute" }, { action: "click", coordinate: [1, 1], button: "back" }] as ComputerAction[]) {
    const { executor, sent } = fake();
    await assert.rejects(executor.execute([{ action: "click", coordinate: [5, 5] }, unsupported]), (error: unknown) => {
      assert.equal(((error as ComputerExecutionError).original as DesktopTargetError).code, "UNSUPPORTED_ACTION");
      assert.equal((error as ComputerExecutionError).progress.dispatch, "not_started");
      return true;
    });
    assert.deepEqual(sent, [], `${unsupported.action}: the click before it was not sent either`);
  }
  const { executor } = fake();
  const read = await executor.execute([{ action: "list_elements" }]);
  assert.match(read.elementsNote ?? "", /no accessibility outline/);
});

test("authority withdrawn after the first action stops the batch: the rest is never sent", async () => {
  let allowed = true;
  const { executor, sent } = fake({}, { onHelper: () => { allowed = false; } });
  await assert.rejects(
    executor.execute([{ action: "click", coordinate: [5, 5] }, { action: "type", text: "secret" }, { action: "key", key: "Return" }], { authorize: () => { if (!allowed) throw new Error("USER_IN_CONTROL"); } }),
    (error: unknown) => {
      assert.equal((error as ComputerExecutionError).progress.dispatch, "partial");
      assert.equal((error as ComputerExecutionError).progress.executed_count, 1);
      return true;
    }
  );
  assert.deepEqual(sent.map(request => request.op), ["click"]);
});

test("the helper script is plain JavaScript that only reads the permissions, and its receipt is its last JSON line", () => {
  assert.doesNotThrow(() => new Function(MAC_HELPER_SOURCE), "it parses; it is never run here");
  assert.match(MAC_HELPER_SOURCE, /CGPreflightScreenCaptureAccess/);
  assert.match(MAC_HELPER_SOURCE, /AXIsProcessTrusted\(\)/);
  for (const prompt of ["CGRequestScreenCaptureAccess", "AXIsProcessTrustedWithOptions", "System Events", "kAXTrustedCheckOptionPrompt"]) {
    assert.ok(!MAC_HELPER_SOURCE.includes(prompt), `${prompt} would put a dialog on the machine's screen`);
  }
  assert.deepEqual(helperReply('{"ok":true}\n'), { ok: true });
  assert.deepEqual(helperReply('{"ok":true,"width":1440}\nundefined\n'), { ok: true, width: 1440 });
  assert.deepEqual(helperReply(""), { ok: false, error: "no receipt" });
});
