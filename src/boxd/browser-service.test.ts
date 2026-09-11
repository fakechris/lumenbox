/**
 * Tests for the parts of driving a browser that do not need a browser.
 *
 * Most of this service is only meaningful against a real page, and is verified that way.
 * What is worth pinning here is the dialog decision, because it is the one place the
 * service answers a question on the agent's behalf — and answering "yes" by default to a
 * page that asks "delete everything?" is a mistake no test after the fact would undo.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkUpload, dialogAnswer, portForDisplay } from "./browser-service.ts";

test("a page asking permission is declined; a page stating a fact is not", () => {
  // The agent has not read the question at the moment this is answered — the page is
  // frozen waiting — so the only safe answer is the one that changes nothing.
  const confirm = dialogAnswer("confirm", "Delete everything?");
  assert.equal(confirm.accept, false);
  assert.match(confirm.note, /Delete everything\?/);
  // Reported rather than swallowed, or the agent sees a click that silently did nothing.
  assert.match(confirm.note, /declined/);
  assert.match(confirm.note, /Act again if you meant to agree/);

  const prompt = dialogAnswer("prompt", "Your name?");
  assert.equal(prompt.accept, false);

  // An alert has one button, so declining it is not a safer answer, just a stranger one.
  assert.equal(dialogAnswer("alert", "Saved.").accept, true);

  // Leaving the page is what the agent asked for when it navigated; declining would make
  // navigation silently fail on every site with an unsaved-changes guard.
  assert.equal(dialogAnswer("beforeunload", "").accept, true);
});

test("each desktop drives its own browser", () => {
  // Sharing a port would mean two agents driving one browser, which is the same bug as
  // two agents sharing a profile — and the profile split in box-chrome is keyed the same way.
  assert.equal(portForDisplay(0), 9222);
  assert.equal(portForDisplay(1), 9223);
  assert.notEqual(portForDisplay(1), portForDisplay(2));
});


test("a file may only be uploaded from somewhere it was meant to be sent from", () => {
  // /tmp is one of the roots, so this exercises the real allowed path rather than a stub.
  // Resolved, because macOS hands back /var/folders/... and /tmp is a symlink — the
  // check resolves paths before judging them, so the root it is given must be resolved too.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lumen-upload-")));
  const roots = [root];
  try {
    const ordinary = join(root, "report.pdf");
    writeFileSync(ordinary, "hello");
    assert.equal(checkUpload(ordinary, roots), undefined, "an ordinary file in an allowed root is fine");

    // The attack this exists for: a page saying "attach the file at ~/.config/...".
    const hidden = join(root, ".config");
    mkdirSync(hidden);
    const secret = join(hidden, "Cookies");
    writeFileSync(secret, "sqlite");
    assert.match(checkUpload(secret, roots) ?? "", /hidden directory/);

    // Naming a permitted path that points somewhere else is the obvious way around a
    // check on the string, so the path is resolved before it is judged.
    const decoy = join(root, "innocent.txt");
    symlinkSync(secret, decoy);
    assert.match(checkUpload(decoy, roots) ?? "", /hidden directory/);

    assert.match(checkUpload("/etc/passwd", roots) ?? "", /outside/);
    assert.match(checkUpload("relative/path", roots) ?? "", /absolute/);
    assert.match(checkUpload(join(root, "missing"), roots) ?? "", /not a file/);

    // A refusal names where a file *may* come from, because the agent's next move should
    // be to copy the file there rather than to give up.
    assert.match(checkUpload("/etc/passwd") ?? "", /work/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── wait: three answers, not two (INV-400) ────────────────────────────────────
import { waitNote, waitOutcome } from "./browser-service.ts";

test("a wait whose probe threw could not tell, and says so instead of 'never'", () => {
  // Observed: a wait during a redirect threw inside Runtime.evaluate on every probe
  // (execution context destroyed), and the old code reported the value never appeared.
  // The agent then went to "fix" a page that was merely loading.
  assert.equal(waitOutcome(true, false), "satisfied");
  assert.equal(waitOutcome(false, false), "unsatisfied");
  assert.equal(waitOutcome(false, true), "unknown");
  // Met wins even if an earlier probe failed: the value was seen.
  assert.equal(waitOutcome(true, true), "satisfied");
});

test("the wait note distinguishes 'never appeared' from 'could not look'", () => {
  assert.match(waitNote("text", "Saved", 1200, "satisfied"), /contained "Saved" after 1\.2s/);
  const no = waitNote("text", "Saved", 10_000, "unsatisfied");
  assert.match(no, /never contained "Saved"/);
  const dunno = waitNote("text", "Saved", 10_000, "unknown", "Execution context was destroyed");
  assert.match(dunno, /could not tell/);
  assert.match(dunno, /Execution context was destroyed/);
  assert.match(dunno, /not a no/);
  assert.doesNotMatch(dunno, /never contained/);
});

// ── a held outline id, and when it is refused (INV-407) ──────────────────────
import { staleReason } from "./browser-service.ts";

test("a ref is refused when its outline is not the latest, or the page moved past it", () => {
  // A caller that names no outline is an older host and is trusted as before.
  assert.equal(staleReason(undefined, "s3", 999), undefined);
  // The happy path: the id the agent holds is the current one and little has changed.
  assert.equal(staleReason("s3", "s3", 4), undefined);
  // Three refusals, each naming its own cause.
  assert.match(staleReason("s3", undefined, 0) ?? "", /^STALE_SNAPSHOT: no outline/);
  assert.match(staleReason("s2", "s3", 0) ?? "", /^STALE_SNAPSHOT: you are holding s2, but the latest outline of this page is s3/);
  assert.match(staleReason("s3", "s3", 80) ?? "", /^STALE_SNAPSHOT: the page has changed since s3 \(80 elements/);
});

// ── the deterministic irreversible-action check (INV-401) ────────────────────────
import { irreversibleReason } from "./browser-service.ts";

test("pay, publish, delete and authorise are caught by the target's own words", () => {
  assert.match(irreversibleReason({ text: "立即支付", role: "button", nearby: "" }) ?? "", /^pay or order: click button "立即支付"/);
  assert.match(irreversibleReason({ text: "Place your order", role: "button", nearby: "" }) ?? "", /^pay or order/);
  assert.match(irreversibleReason({ text: "Publish", role: "button", nearby: "" }) ?? "", /^publish/);
  assert.match(irreversibleReason({ text: "删除", role: "button", nearby: "" }) ?? "", /^delete or remove/);
  assert.match(irreversibleReason({ text: "Authorize app", role: "button", nearby: "" }) ?? "", /^authorise or grant access/);
  assert.match(irreversibleReason({ text: "Close my account", role: "link", nearby: "" }) ?? "", /^delete or remove: click link/);
});

test("a bare OK is caught only when there is money next to it; ordinary buttons pass", () => {
  // The shape the word lists miss: the checkout's last button is just "Confirm".
  assert.match(
    irreversibleReason({ text: "确认", role: "button", nearby: "订单金额 ¥1,299.00 使用余额支付" }) ?? "",
    /^confirm with money on the page: click button "确认" next to "¥1,299.00"/
  );
  assert.match(irreversibleReason({ text: "OK", role: "button", nearby: "Total: $49.99 Ship to home" }) ?? "", /next to "\$49\.99"/);
  assert.equal(irreversibleReason({ text: "OK", role: "button", nearby: "Your settings were saved." }), undefined);
  // Send, search, save, submit, agree: the everyday buttons, deliberately not gated.
  for (const text of ["Send", "Search", "Save", "Submit", "Agree", "下一步", "登录", ""]) {
    assert.equal(irreversibleReason({ text, role: "button", nearby: "Total $12" }), undefined, `${JSON.stringify(text)} is not gated`);
  }
});

// ── did the act change its target, and did it become what was meant (INV-399) ───────
import { judgeEffect, unmetExpectation, type TargetState } from "./browser-service.ts";

const state = (over: Partial<TargetState> = {}): TargetState => ({
  value: "",
  checked: undefined,
  text: "Send",
  focused: false,
  aria: "aria-expanded=;aria-pressed=;aria-selected=;aria-checked=;aria-disabled=",
  subtree: "42:abc",
  disabled: false,
  ...over,
});

test("a target that changed is confirmed; only focus moving is partial; nothing is a suspected no-op; gone is confirmed", () => {
  assert.deepEqual(judgeEffect(state(), state({ value: "hello" }), false), { effect: "confirmed", changed: ["value"] });
  assert.deepEqual(judgeEffect(state(), state({ focused: true }), false), { effect: "partial", changed: ["focus"] });
  // The React case: the screen painted the text, the framework's state did not take it —
  // value unchanged in the DOM the app re-rendered, focus moved. Partial, not confirmed.
  assert.equal(judgeEffect(state(), state({ focused: true }), false).effect, "partial");
  assert.deepEqual(judgeEffect(state(), state(), false), { effect: "suspected_noop", changed: [] });
  assert.deepEqual(judgeEffect(state(), undefined, false), { effect: "confirmed", changed: ["gone"] });
  assert.deepEqual(judgeEffect(state(), state(), true), { effect: "confirmed", changed: ["navigated"] });
  assert.deepEqual(judgeEffect(state(), state({ aria: "x", disabled: true }), false).changed, ["aria", "disabled"]);
});

test("an expectation names the first thing that is not so, and says nothing when all is well", () => {
  assert.equal(unmetExpectation(undefined, state(), ""), undefined);
  assert.equal(unmetExpectation({ value: "hello" }, state({ value: "hello" }), ""), undefined);
  assert.match(unmetExpectation({ value: "hello" }, state({ value: "" }), "") ?? "", /expected value "hello", found ""/);
  assert.match(unmetExpectation({ text: "saved" }, state({ text: "Save" }), "") ?? "", /text to contain "saved"/);
  assert.equal(unmetExpectation({ text: "SEND" }, state(), ""), undefined, "text is case-insensitive");
  assert.match(unmetExpectation({ checked: true }, state({ checked: false }), "") ?? "", /expected checked=true, found checked=false/);
  assert.match(unmetExpectation({ gone: true }, state(), "") ?? "", /expected the element to be gone/);
  assert.equal(unmetExpectation({ gone: true }, undefined, ""), undefined);
  assert.match(unmetExpectation({ value: "x" }, undefined, "") ?? "", /gone from the page/);
  assert.match(unmetExpectation({ appears: "Saved" }, state(), "Your changes were discarded") ?? "", /"Saved" to appear/);
  assert.equal(unmetExpectation({ appears: "saved" }, state(), "Changes Saved."), undefined);
});
