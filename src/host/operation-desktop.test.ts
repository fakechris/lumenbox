/** Desktop steps in a taught operation (INV-1421): described, never coordinates; run with the same readings and gates. */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ComputerAction, ComputerResult } from "../protocol/index.ts";
import type { SwitchDeps } from "./jev.ts";
import { casesPass, type DesktopRunner, type Operation, operationProblem, runCases, runOperation } from "./operation.ts";
import { desktopRunner } from "./operation-desktop.ts";

const op: Operation = {
  name: "Post the weekly note",
  input: { note: { type: "string" } },
  output: { status: { type: "string" } },
  steps: [
    { desktop: { click: "the message box" } },
    { desktop: { type: "{note}" } },
    { desktop: { click: "the Send button", commit: "send" } },
    { desktop: { wait: "the note appears in the chat", seconds: 10 } },
    { read: { as: "status", pattern: "(sent)" } },
  ],
};
const browser = async () => ({ text: "sent", url: "x" });

test("a desktop step is one described verb; coordinates and stray fields are refused", () => {
  assert.equal(operationProblem(op), undefined);
  const bad = (step: unknown) => operationProblem({ ...op, steps: [step, ...op.steps.slice(1)] });
  assert.match(bad({ desktop: { click: "x", type: "y" } })!, /exactly one of/);
  assert.match(bad({ desktop: { click: "x", coordinate: [1, 2] } })!, /never by coordinates/);
  assert.match(bad({ desktop: { type: "x", commit: "send" } })!, /on a click/);
});

test("the steps run in order with the input filled in; a failure names its step; a commit needs the run approved", async () => {
  const seen: string[] = [];
  const runner = (failAt?: string): DesktopRunner => async step => {
    seen.push(`${step.verb}:${step.value}:${step.committed}`);
    return step.value === failAt ? { ok: false, detail: "not found" } : { ok: true, detail: "ok" };
  };
  assert.equal((await runOperation(op, { note: "hi" }, browser, false, runner())).ok, false, "a commit step needs approval");
  const done = await runOperation(op, { note: "hi" }, browser, true, runner());
  assert.deepEqual(done, { ok: true, output: { status: "sent" } });
  assert.deepEqual(seen, ["click:the message box:false", "type:hi:false", "click:the Send button:true", "wait:the note appears in the chat:false"]);
  const failed = await runOperation(op, { note: "hi" }, browser, true, runner("the Send button"));
  assert.deepEqual(failed.ok ? undefined : { code: failed.code, step: failed.step }, { code: "step_failed", step: 2 });
  const none = await runOperation(op, { note: "hi" }, browser, true);
  assert.match(none.ok ? "" : none.detail, /nothing here can run them/);
});

function fakeBox() {
  const sent: ComputerAction[][] = [];
  const sof = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x03, 0x20, 0x05, 0x00, 0x03]).toString("base64");
  return {
    sent,
    computer: async (actions: readonly ComputerAction[], options: Record<string, unknown> = {}) => {
      sent.push([...actions]);
      return { success: true, screenshot: "WEBP", action_count: actions.length, duration_ms: 1, progress: { executed_count: 1, dispatch: "sent" }, ...(options.jpeg === true ? { screenshot_jpeg: sof } : {}) } as ComputerResult;
    },
  };
}

const on = (points: string[]): SwitchDeps => ({
  mode: point => (points.includes(point) ? "on" : "off"),
  client: () => async request => {
    const [id, question] = Object.entries(request.questions)[0]!;
    const answer = question.type === "box" ? { type: "box", box: { top: 0.4, bottom: 0.6, left: 0.4, right: 0.6 }, confidence: 0.9 }
      : question.type === "choice" ? { type: "choice", choice: "other", confidence: 0.9, probabilities: { other: 0.9 } }
      : { type: "noul", noul: 0.95 };
    return { model: "m", ms: 1, answers: { [id]: answer } } as never;
  },
  record: () => {},
  log: () => {},
});

test("the runner needs its switches, and with them runs each step as one computer call", async () => {
  const off = desktopRunner(fakeBox(), { display: 1 }, on([]));
  assert.match((await off({ verb: "click", value: "the Send button", committed: false })).detail, /AGENTBOX_JEV_COMPUTER_CLICK on/);
  assert.equal((await off({ verb: "type", value: "hi", committed: false })).ok, true, "typing needs no reading");

  const box = fakeBox();
  const run = desktopRunner(box, { display: 1 }, on(["computer_click", "computer_wait"]), { now: () => 0, sleep: async () => {} });
  assert.equal((await run({ verb: "click", value: "the Send button", committed: false })).ok, true);
  assert.deepEqual(box.sent.at(-1), [{ action: "click", coordinate: [640, 400] }], "found by description, clicked at the centre of the frame's box");
  assert.equal((await run({ verb: "check", value: "the note is in the chat", committed: false })).ok, true);

  const cases = await runCases(op, [{ purpose: "posts", input: { note: "hi" } }], browser, desktopRunner(fakeBox(), {}, on([])));
  assert.equal(casesPass(cases), false, "with the switches off the dry run fails, so the operation cannot be published");
  assert.match(cases.failures[0]!, /COMPUTER_CLICK/);
});
