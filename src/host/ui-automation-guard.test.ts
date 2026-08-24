/**
 * Tests for the boundary between the shell and the browser.
 *
 * Both directions matter and they fail differently. A hole means the approval rules on
 * browser actions are advisory, which nobody finds out about until something was clicked
 * that should not have been. A false positive means an agent is refused ordinary work —
 * and because the refusal is confident and specific, it will believe it and stop, which
 * is a worse experience than the hole is a risk on any given day.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { guardShellCommand } from "./ui-automation-guard.ts";

test("reaching around the browser tools is refused, and pointed at the tool that works", () => {
  const reaching = [
    "curl http://127.0.0.1:9222/json/list",
    "curl -s localhost:9223/json/version | jq .",
    "chromium --remote-debugging-port=9333 --headless",
    "chromium --remote-debugging-pipe",
    "npx playwright open https://example.com",
    "python3 -c \"import puppeteer\"",
    "wget http://127.0.0.1:9222/json/new?about:blank",
  ];
  for (const command of reaching) {
    const verdict = guardShellCommand(command);
    assert.ok(verdict.refusal !== undefined, command);
    // A refusal that only says no gets retried with a different spelling, which wastes a
    // turn and is exactly the behaviour this exists to prevent.
    assert.match(verdict.refusal, /browser_open|browser_act/, command);
  }
});

test("driving the screen from a shell is refused, and pointed at `computer`", () => {
  for (const command of [
    "xdotool key Return",
    "DISPLAY=:2 wmctrl -a Firefox",
    "python3 -c 'import pyautogui; pyautogui.click()'",
    "ydotool type hello",
  ]) {
    const verdict = guardShellCommand(command);
    assert.ok(verdict.refusal !== undefined, command);
    assert.match(verdict.refusal, /computer/, command);
  }
});

test("ordinary work is not refused, which is the failure that would actually be felt", () => {
  // Each of these has a word in it that a lazier pattern would catch: a port number, a
  // library name inside a longer word, a file that merely mentions the browser.
  for (const command of [
    "npm test",
    "curl https://api.example.com/v1/items",
    "python3 -m http.server 9222",
    "git commit -m 'add playwright-style retries to our own harness'",
    "grep -rn 'import' src/",
    "cat notes/chromedriver-alternatives.md",
    "node build.js --port 9222",
    "ls /usr/local/bin",
    "echo 'scrotum' | wc -c",
  ]) {
    assert.equal(guardShellCommand(command).refusal, undefined, command);
  }
});
