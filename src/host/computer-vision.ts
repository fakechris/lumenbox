/**
 * The decision model reading the desktop (INV-1417…1420): what the host may ask of a screenshot
 * between the model's computer call and the box.
 *
 * The `computer` tool goes through `computerWithVision` instead of calling the box directly. With
 * every switch off it is exactly that call. With one on it adds, in this order:
 *
 *   - `expect.looks` (INV-1417): the final frame, as JPEG, checked against a sentence the model wrote.
 *   - `wait_until` (INV-1418): a read-only action, alone in its call, that polls the screen until it
 *     shows what `looks` describes or `seconds` run out.
 *
 * The rule from docs/85 holds throughout: an answer read off the screen may make the outcome more
 * careful — a check that fails, a wait that ends unknown, a person asked — and never less.
 */

import type { BoxClient } from "../box/client.ts";
import type { ActionVerification, ComputerAction, ComputerResult, DesktopExpectation } from "../protocol/index.ts";
import { defaultSwitchDeps, type JevAsk, modeFor, noulOf, type SwitchDeps } from "./jev.ts";

type Box = Pick<BoxClient, "computer">;
type Options = Parameters<BoxClient["computer"]>[1];

/** At or below this, the screen is taken not to show what `looks` describes. */
export const LOOKS_UNSATISFIED_AT = 0.2;
/** At or above this, the screen is taken to show it — as evidence only, never as the verdict. */
export const LOOKS_SATISFIED_AT = 0.8;

const IMAGE_REF = "3f6c1a2e-screen";

/** One yes/no question about a JPEG frame. */
export async function askScreen(ask: JevAsk, jpegBase64: string, question: string): Promise<number> {
  const result = await ask({
    state: { screen: IMAGE_REF },
    images: [{ ref: IMAGE_REF, format: "jpg", base64: jpegBase64 }],
    questions: { yes: { type: "noul", instructions: question } },
  });
  return noulOf(result, "yes");
}

/**
 * The verification a `looks` answer leaves. A clear no overrides whatever else was verified; a
 * clear yes is recorded as evidence and leaves the verification it found.
 */
export function looksVerification(existing: ActionVerification | undefined, looks: string, p: number): ActionVerification | undefined {
  const quoted = `"${looks.slice(0, 160)}"`;
  if (p <= LOOKS_UNSATISFIED_AT) {
    return { status: "unsatisfied", source: "vision", detail: `the screen does not look like ${quoted} (${p.toFixed(2)}); look at the screenshot before anything else` };
  }
  const note = p >= LOOKS_SATISFIED_AT ? `the screen looks like ${quoted} (${p.toFixed(2)}), which is evidence, not proof` : `unclear whether the screen looks like ${quoted} (${p.toFixed(2)})`;
  return existing === undefined ? { status: "unknown", source: "vision", detail: note } : { ...existing, detail: `${existing.detail}; ${note}` };
}

/** `expect.looks` in the tool's schema, only while its switch is not off: a field nothing would check is not offered. */
export function visionExpectSchema(jev: SwitchDeps = defaultSwitchDeps): Record<string, unknown> {
  if (modeFor("computer_verify", jev).mode === "off") return {};
  return {
    looks: {
      type: "string",
      description: "What the screen should show after the batch, in one plain sentence (\"a dialog titled Save As is open\"). Checked against the final screenshot; a clear mismatch fails the batch, a match is evidence, not proof.",
    },
  };
}

/** At or above this, a polled frame shows what `wait_until` waits for. */
export const WAIT_SATISFIED_AT = 0.8;
export const WAIT_DEFAULT_SECONDS = 10;
export const WAIT_MAX_SECONDS = 60;
export const WAIT_INTERVAL_MS = 1_500;

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const realClock: Clock = { now: () => Date.now(), sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) };

/** The host-only actions and their fields, added to the tool's action schema while their switches are on. */
export function visionActionSchema<T extends { properties: Record<string, unknown> }>(schema: T, jev: SwitchDeps = defaultSwitchDeps): T {
  const actionField = schema.properties.action as { enum: string[] };
  const extra: string[] = [];
  const fields: Record<string, unknown> = {};
  if (modeFor("computer_wait", jev).mode === "on") {
    extra.push("wait_until");
    fields.looks = { type: "string", description: "For wait_until: what the screen will show when the wait is over, in one plain sentence." };
    fields.seconds = { type: "integer", description: `For wait_until: how long to wait at most. Defaults to ${WAIT_DEFAULT_SECONDS}, at most ${WAIT_MAX_SECONDS}.` };
  }
  if (extra.length === 0) return schema;
  return { ...schema, properties: { ...schema.properties, ...fields, action: { ...actionField, enum: [...actionField.enum, ...extra] } } };
}

function refused(error: string): ComputerResult {
  return { outcome: "refused", success: false, screenshot: "", error, action_count: 0, duration_ms: 0, progress: { executed_count: 0, dispatch: "not_started" } } as ComputerResult;
}

/** Polls the screen until it shows `looks`. Read-only: a satisfied wait is a fact about the screen, not about any write. */
async function waitUntil(box: Box, action: { looks?: unknown; seconds?: unknown }, options: Options, ask: JevAsk, jev: SwitchDeps, clock: Clock): Promise<ComputerResult> {
  const looks = typeof action.looks === "string" ? action.looks.trim() : "";
  if (looks === "") return refused("wait_until needs looks: what the screen will show when the wait is over");
  const seconds = Math.min(WAIT_MAX_SECONDS, Math.max(1, typeof action.seconds === "number" && Number.isFinite(action.seconds) ? action.seconds : WAIT_DEFAULT_SECONDS));
  const deadline = clock.now() + seconds * 1000;
  const quoted = `"${looks.slice(0, 160)}"`;
  for (let polls = 1; ; polls += 1) {
    const frame = await box.computer([{ action: "screenshot" } as ComputerAction], { ...options, expect: undefined, jpeg: true });
    if (frame.screenshot_jpeg === undefined) {
      return { ...withoutJpeg(frame), verification: { status: "unknown", source: "vision", detail: "the box sent no JPEG frame, so wait_until cannot read the screen; update the box image, or use wait" } };
    }
    let p: number | undefined;
    try {
      p = await askScreen(ask, frame.screenshot_jpeg, `Does \`screen\` show this: ${looks}`);
    } catch (error) {
      jev.log(`computer_wait: the decision model failed (${error instanceof Error ? error.message : String(error)}); polling on`);
    }
    if (p !== undefined && p >= WAIT_SATISFIED_AT) {
      return { ...withoutJpeg(frame), verification: { status: "satisfied", source: "vision", detail: `the screen shows ${quoted} (${p.toFixed(2)}) after ${polls} look(s)` } };
    }
    if (clock.now() + WAIT_INTERVAL_MS > deadline) {
      const last = p === undefined ? "the last look could not be judged" : `last look ${p.toFixed(2)}`;
      return { ...withoutJpeg(frame), verification: { status: "unknown", source: "vision", detail: `did not see ${quoted} within ${seconds}s (${last}); the screenshot is the last look` } };
    }
    await clock.sleep(WAIT_INTERVAL_MS);
  }
}

export async function computerWithVision(box: Box, actions: readonly ComputerAction[], options: Options = {}, jev: SwitchDeps = defaultSwitchDeps, clock: Clock = realClock): Promise<ComputerResult> {
  const wait = actions.find(action => (action as { action?: unknown }).action === "wait_until") as { looks?: unknown; seconds?: unknown } | undefined;
  if (wait !== undefined) {
    if (actions.length > 1) return refused("wait_until goes alone in its call: send the actions before it, then wait_until, then the ones after");
    const { mode, ask } = modeFor("computer_wait", jev);
    if (mode !== "on" || ask === undefined) return refused("wait_until is not switched on here; use wait with a number of milliseconds and look at the screenshot");
    return waitUntil(box, wait, options, ask, jev, clock);
  }
  const { looks, ...rest } = options.expect ?? ({} as DesktopExpectation);
  // The box never sees `looks`: an older one would read an expectation it cannot check as a failure.
  const expect = Object.keys(rest).length > 0 ? rest : undefined;
  const plain = { ...options, expect };
  const { mode, ask } = looks === undefined || looks.trim() === "" ? { mode: "off" as const } : modeFor("computer_verify", jev);
  if (mode === "off" || ask === undefined || looks === undefined) return box.computer(actions, plain);
  // One dispatch, whatever the mode: the generic switch runs both of its paths in shadow, and a
  // desktop batch run twice is two sets of clicks.
  const result = await box.computer(actions, { ...plain, jpeg: true });
  const frame = result.screenshot_jpeg;
  const clean = withoutJpeg(result);
  if (frame === undefined) {
    if (mode === "shadow") return clean;
    const note = "the box sent no JPEG frame, so expect.looks was not checked; update the box image";
    return { ...clean, verification: clean.verification ?? { status: "unknown", source: "vision", detail: note } };
  }
  const question = `Does \`screen\` show this: ${looks}`;
  if (mode === "shadow") {
    const started = Date.now();
    void askScreen(ask, frame, question)
      .then(p => jev.record({ at: new Date().toISOString(), point: "computer_verify", own: clean.verification?.status ?? "none", jev: looksVerification(clean.verification, looks, p)?.status ?? "none", ms: Date.now() - started }))
      .catch(error => jev.record({ at: new Date().toISOString(), point: "computer_verify", own: clean.verification?.status ?? "none", error: error instanceof Error ? error.message : String(error) }))
      .catch(() => {});
    return clean;
  }
  try {
    return { ...clean, verification: looksVerification(clean.verification, looks, await askScreen(ask, frame, question)) };
  } catch (error) {
    jev.log(`computer_verify: the decision model failed (${error instanceof Error ? error.message : String(error)}); expect.looks not checked`);
    return clean;
  }
}

/** The JPEG copy is for the host's question only; the transcript keeps the WebP it always kept. */
function withoutJpeg(result: ComputerResult): ComputerResult {
  const { screenshot_jpeg: _dropped, ...rest } = result;
  return rest;
}
