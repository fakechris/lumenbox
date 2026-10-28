/** The desktop read by the decision model (INV-1417): one dispatch in every mode, and only ever more careful. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { type ComputerAction, type ComputerResult, computerOutcome } from "../protocol/index.ts";
import { computerWithVision, LOOKS_UNSATISFIED_AT, visionExpectSchema } from "./computer-vision.ts";
import type { JevMode, ShadowEntry, SwitchDeps } from "./jev.ts";

const click: ComputerAction[] = [{ action: "click", coordinate: [100, 200] } as ComputerAction];

function fakeBox(result: Partial<ComputerResult> = {}) {
  const calls: { actions: readonly ComputerAction[]; options: Record<string, unknown> }[] = [];
  return {
    calls,
    computer: async (actions: readonly ComputerAction[], options: Record<string, unknown> = {}) => {
      calls.push({ actions, options });
      return { success: true, screenshot: "WEBP", action_count: actions.length, duration_ms: 5, progress: { executed_count: 1, dispatch: "sent" }, ...(options.jpeg === true ? { screenshot_jpeg: "JPEG" } : {}), ...result } as ComputerResult;
    },
  };
}

function deps(mode: JevMode, p: number | Error, records: ShadowEntry[] = []): SwitchDeps {
  return {
    mode: point => (point === "computer_verify" ? mode : "off"),
    client: () => async request => {
      if (p instanceof Error) throw p;
      assert.equal(request.images?.[0]?.base64, "JPEG", "the question is about the JPEG copy of the same frame");
      return { model: "m", ms: 1, answers: { yes: { type: "noul", noul: p } } };
    },
    record: entry => records.push(entry),
    log: () => {},
  };
}

test("off is the plain call, with looks never sent to the box", async () => {
  const box = fakeBox();
  await computerWithVision(box, click, { display: 2, expect: { looks: "a dialog is open", window_title: "Save" } }, deps("off", 0.9));
  assert.equal(box.calls.length, 1);
  assert.deepEqual(box.calls[0]!.options.expect, { window_title: "Save" });
  assert.equal(box.calls[0]!.options.jpeg, undefined);
  assert.deepEqual(visionExpectSchema(deps("off", 0.9)), {});
  assert.ok("looks" in visionExpectSchema(deps("on", 0.9)));
});

test("on: a clear no fails the batch even over a native yes; a clear yes is evidence and never promotes", async () => {
  const no = await computerWithVision(fakeBox({ verification: { status: "satisfied", source: "native", detail: "title matched" } }), click, { expect: { looks: "a dialog titled Save As" } }, deps("on", 0.05));
  assert.equal(no.verification?.status, "unsatisfied");
  assert.equal(no.verification?.source, "vision");
  assert.equal(computerOutcome(no, true), "failed");
  assert.equal(no.screenshot_jpeg, undefined, "the JPEG copy does not reach the transcript");

  const yes = await computerWithVision(fakeBox(), click, { expect: { looks: "a dialog titled Save As" } }, deps("on", 0.95));
  assert.equal(yes.verification?.status, "unknown", "a picture is evidence, not proof");
  assert.match(yes.verification!.detail, /looks like "a dialog titled Save As" \(0\.95\)/);
  assert.equal(computerOutcome(yes, true), "unknown");
  assert.ok(LOOKS_UNSATISFIED_AT < 0.5);
});

test("on: no JPEG from an older box, or a failed question, leaves the result as the box gave it", async () => {
  const older = fakeBox();
  const oldBox = { computer: async (actions: readonly ComputerAction[], options: Record<string, unknown> = {}) => { const r = await older.computer(actions, { ...options, jpeg: false }); return r; } };
  const noFrame = await computerWithVision(oldBox, click, { expect: { looks: "x" } }, deps("on", 0.05));
  assert.equal(noFrame.verification?.status, "unknown");
  assert.match(noFrame.verification!.detail, /no JPEG frame/);
  const failed = await computerWithVision(fakeBox(), click, { expect: { looks: "x" } }, deps("on", new Error("down")));
  assert.equal(failed.verification, undefined);
});

test("shadow dispatches the batch once, changes nothing, and records both", async () => {
  const box = fakeBox();
  const records: ShadowEntry[] = [];
  const result = await computerWithVision(box, click, { expect: { looks: "a dialog" } }, deps("shadow", 0.05, records));
  assert.equal(box.calls.length, 1, "a desktop batch is never run twice to compare");
  assert.equal(result.verification, undefined);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual({ point: records[0]!.point, own: records[0]!.own, jev: records[0]!.jev }, { point: "computer_verify", own: "none", jev: "unsatisfied" });
});

test("wait_until polls read-only frames until the screen shows it, or says unknown when time runs out", async () => {
  const { WAIT_INTERVAL_MS, visionActionSchema } = await import("./computer-vision.ts");
  let t = 0;
  const clock = { now: () => t, sleep: async (ms: number) => { t += ms; } };
  const answers = [0.1, 0.3, 0.92];
  const polling = (ps: (number | Error)[]): SwitchDeps => ({
    mode: () => "on",
    client: () => async () => { const p = ps.shift() ?? 0.1; if (p instanceof Error) throw p; return { model: "m", ms: 1, answers: { yes: { type: "noul", noul: p } } }; },
    record: () => {},
    log: () => {},
  });
  const wait = [{ action: "wait_until", looks: "the page has finished loading", seconds: 10 } as unknown as ComputerAction];

  const box = fakeBox();
  const done = await computerWithVision(box, wait, {}, polling([...answers]), clock);
  assert.equal(done.verification?.status, "satisfied");
  assert.equal(box.calls.length, 3);
  assert.ok(box.calls.every(call => call.actions.length === 1 && (call.actions[0] as { action: string }).action === "screenshot"), "only screenshots are sent to the box");
  assert.equal(computerOutcome(done, false), "ok", "a read-only wait that saw the screen is ok");

  t = 0;
  const late = await computerWithVision(fakeBox(), wait, {}, polling([new Error("down"), 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2]), clock);
  assert.equal(late.verification?.status, "unknown");
  assert.match(late.verification!.detail, /within 10s/);
  assert.ok(t <= 10_000 && t >= 10_000 - WAIT_INTERVAL_MS * 2, "it stops at the deadline");

  const mixed = await computerWithVision(fakeBox(), [...wait, ...click], {}, polling([0.9]), clock);
  assert.equal(mixed.outcome, "refused");
  const off = await computerWithVision(fakeBox(), wait, {}, { ...polling([0.9]), mode: () => "off" }, clock);
  assert.match(off.error!, /not switched on/);

  const schema = { properties: { action: { type: "string", enum: ["click"] } } };
  const waitOnly: SwitchDeps = { ...polling([]), mode: point => (point === "computer_wait" ? "on" : "off") };
  assert.deepEqual((visionActionSchema(schema, waitOnly).properties.action as { enum: string[] }).enum, ["click", "wait_until"]);
  assert.equal(visionActionSchema(schema, { ...polling([]), mode: () => "off" }), schema);
});

test("click_target finds the control on a fresh frame and sends an ordinary click at its centre, or refuses when unsure", async () => {
  const { jpegSize } = await import("./computer-vision.ts");
  // A real 1280x800 JPEG header, so the size comes from the bytes rather than an assumption.
  const sof = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x03, 0x20, 0x05, 0x00, 0x03]);
  assert.deepEqual(jpegSize(sof.toString("base64")), { width: 1280, height: 800 });
  const boxAnswer = (confidence: number): SwitchDeps => ({
    mode: point => (point === "computer_click" ? "on" : "off"),
    client: () => async request => {
      assert.equal(Object.values(request.questions)[0]!.type, "box");
      return { model: "m", ms: 1, answers: { where: { type: "box", box: { top: 0.89, bottom: 0.95, left: 0.55, right: 0.6 }, confidence } } };
    },
    record: () => {},
    log: () => {},
  });
  const calls: { actions: readonly ComputerAction[]; options: Record<string, unknown> }[] = [];
  const box = {
    computer: async (actions: readonly ComputerAction[], options: Record<string, unknown> = {}) => {
      calls.push({ actions, options });
      return { success: true, screenshot: "WEBP", action_count: actions.length, duration_ms: 5, progress: { executed_count: 1, dispatch: "sent" }, effect: "observed_change", effect_detail: "click@(736,736) observed_change 9%", ...(options.jpeg === true ? { screenshot_jpeg: sof.toString("base64") } : {}) } as ComputerResult;
    },
  };
  const ask = [{ action: "click_target", target: "the Send button" } as unknown as ComputerAction, { action: "key", key: "Return" } as ComputerAction];

  const clicked = await computerWithVision(box, ask, { display: 1 }, boxAnswer(0.84));
  assert.equal(calls.length, 2);
  assert.equal((calls[0]!.actions[0] as { action: string }).action, "screenshot");
  assert.deepEqual(calls[1]!.actions[0], { action: "click", coordinate: [736, 736] }, "the centre of the box, in the frame's pixels");
  assert.equal((calls[1]!.actions[1] as { action: string }).action, "key", "the rest of the batch follows the click");
  assert.match(clicked.effect_detail!, /click_target "the Send button" clicked at \(736, 736\), confidence 0\.84/);

  calls.length = 0;
  const unsure = await computerWithVision(box, ask, {}, boxAnswer(0.31));
  assert.equal(unsure.outcome, "refused");
  assert.match(unsure.error!, /could not find "the Send button" confidently \(0\.31\)/);
  assert.equal(calls.length, 1, "nothing but the screenshot was sent");

  assert.match((await computerWithVision(box, [{ action: "key", key: "a" } as ComputerAction, ask[0]!], {}, boxAnswer(0.9))).error!, /goes first/);
  assert.match((await computerWithVision(box, ask, {}, { ...boxAnswer(0.9), mode: () => "off" })).error!, /not switched on/);
});

test("the guard sends a click on what looks like send/pay/delete to the gate, and only ever adds an approval", async () => {
  const { approvalOf, GUARD_AT } = await import("./computer-vision.ts");
  const reading = (choice: string, confidence: number, mode: JevMode = "on", fail = false): SwitchDeps => ({
    mode: point => (point === "computer_guard" ? mode : "off"),
    client: () => async request => {
      if (fail) throw new Error("down");
      assert.equal(Object.values(request.questions)[0]!.type, "choice");
      return { model: "m", ms: 1, answers: { kind: { type: "choice", choice, confidence, probabilities: { [choice]: confidence } } } };
    },
    record: () => {},
    log: () => {},
  });
  const box = fakeBox();
  const findings: string[] = [];
  const refuse = (finding: string) => { findings.push(finding); return { allow: false as const, reason: "waiting for a person", approvalId: "ap-1" }; };

  const stopped = await computerWithVision(box, click, { guard: refuse }, reading("send", 0.9));
  assert.equal(stopped.outcome, "refused");
  assert.deepEqual(approvalOf(stopped), { approval: { id: "ap-1" } }, "the turn waits on the approval like a browser click's");
  assert.equal(box.calls.length, 1, "only the marked frame was taken; the click was not sent");
  assert.deepEqual(box.calls[0]!.options.mark, { x: 60, y: 180, width: 80, height: 40 });
  assert.equal(findings[0], "click at (100, 200) on a control that looks like it will send (desktop, read from the screen)", "no confidence in the words, so a grant matches the retry");

  box.calls.length = 0;
  await computerWithVision(box, click, { guard: () => ({ allow: true }) }, reading("send", 0.9));
  assert.equal(box.calls.length, 2, "approved: the frame, then the click");
  box.calls.length = 0;
  await computerWithVision(box, click, { guard: refuse }, reading("other", 0.95));
  assert.equal(box.calls.length, 2, "an ordinary control is clicked as before");
  box.calls.length = 0;
  await computerWithVision(box, click, { guard: refuse }, reading("delete", GUARD_AT - 0.1));
  assert.equal(box.calls.length, 2, "an unsure reading adds no gate");
  box.calls.length = 0;
  await computerWithVision(box, click, { guard: refuse }, reading("send", 0.9, "on", true));
  assert.equal(box.calls.length, 2, "a failed reading is today's behaviour");
  box.calls.length = 0;
  await computerWithVision(box, click, { guard: refuse }, reading("send", 0.9, "shadow"));
  assert.equal(box.calls.length, 2, "shadow only records");
  box.calls.length = 0;
  await computerWithVision(box, [{ action: "key", key: "Return" } as ComputerAction, ...click], { guard: refuse }, reading("send", 0.9));
  assert.equal(box.calls.length, 1, "a batch whose first write is not a click is not read");
  assert.equal(approvalOf(await computerWithVision(fakeBox(), click, {}, reading("pay", 0.9))).approval, undefined);
  assert.match((await computerWithVision(fakeBox(), click, {}, reading("pay", 0.9))).error!, /no approval channel/);
});
