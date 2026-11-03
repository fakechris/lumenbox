/** No page script asks with prompt(): the desktop app is Electron, where it throws (INV-1540). */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const DIR = join(import.meta.dirname, "");

/** A call to the browser's prompt: `prompt(` or `window.prompt(`, not a method like `orchestrator.prompt(`. */
export function promptCalls(source: string): string[] {
  return source.split("\n").map(line => line.trim())
    .filter(line => !line.startsWith("*") && !line.startsWith("//") && !line.startsWith("/*"))
    .filter(line => /(^|[^.\w$])prompt\s*\(|window\.prompt\s*\(/.test(line));
}

test("the check finds a browser prompt and ignores a method called prompt", () => {
  assert.equal(promptCalls(`var to = prompt("Rename to:", from);`).length, 1);
  assert.equal(promptCalls(`var t = window.prompt("When?", "");`).length, 1);
  assert.equal(promptCalls(`void orchestrator.prompt(agent.id, text);`).length, 0);
  assert.equal(promptCalls(`const systemPrompt = buildPrompt(x);`).length, 0);
  assert.equal(promptCalls(` * the desktop app has no prompt().`).length, 0, "prose in a comment is not a call");
});

test("no page script calls prompt(); askInline asks instead", () => {
  const found = readdirSync(DIR)
    .filter(name => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .flatMap(name => promptCalls(readFileSync(join(DIR, name), "utf8")).map(line => `${name}: ${line}`));
  assert.deepEqual(found, []);
});
