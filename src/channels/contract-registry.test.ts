/**
 * The roll call (INV-129 A4): every adapter class in the tree is under contract, and a
 * contract test names it. A new door without one fails here, in the suite, not in a
 * group chat where a message went nowhere.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONTRACTED_ADAPTERS } from "./contract.ts";

const here = new URL(".", import.meta.url).pathname;

test("every ChannelAdapter implementation is listed and driven by a contract test", () => {
  const files = readdirSync(here).filter(name => name.endsWith(".ts"));
  const implementations: string[] = [];
  for (const name of files) {
    if (name.endsWith(".test.ts")) continue;
    const source = readFileSync(join(here, name), "utf8");
    for (const match of source.matchAll(/export class (\w+) implements ChannelAdapter/g)) implementations.push(match[1]!);
  }
  assert.ok(implementations.length >= 3, `found ${implementations.join(", ")}`);
  for (const name of implementations) {
    assert.ok((CONTRACTED_ADAPTERS as readonly string[]).includes(name), `${name} implements ChannelAdapter but is not in CONTRACTED_ADAPTERS`);
  }
  const tests = files.filter(name => name.endsWith(".test.ts")).map(name => readFileSync(join(here, name), "utf8")).join("\n");
  for (const name of CONTRACTED_ADAPTERS) {
    assert.ok(tests.includes(`adapterClass: "${name}"`), `${name} is listed but no test runs the contract for it`);
  }
});
