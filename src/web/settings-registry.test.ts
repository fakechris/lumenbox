/**
 * The Settings panes as listed are the panes as served (INV-1660): the dialog's tab row is the
 * registry's, and what a pane says it edits exists — a config.json key in AgentboxConfig, an API
 * route a server module answers — so the generated reference cannot name a field that is gone.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SETTINGS_DIALOG_HTML } from "./settings-dialog-html.ts";
import { SETTINGS_PANES } from "./settings-registry.ts";

const SRC = join(import.meta.dirname, "..");

test("the dialog's tabs are the registry's page panes, in its order, the first one on", () => {
  const tabs = [...SETTINGS_DIALOG_HTML.matchAll(/<a href="#" class="tab( on)?" data-settab="([\w-]+)">([^<]+)<\/a>/g)];
  const page = SETTINGS_PANES.filter(pane => pane.mounted === "page");
  assert.deepEqual(tabs.map(m => [m[2], m[3]]), page.map(pane => [pane.key, pane.title]));
  assert.deepEqual(tabs.map(m => m[1] === " on"), page.map((_, i) => i === 0));
});

test("every config key a pane names is in AgentboxConfig, and every API it names is served", () => {
  const config = readFileSync(join(SRC, "config.ts"), "utf8");
  const shape = /export interface AgentboxConfig \{([\s\S]*?)\n\}/.exec(config)![1]!;
  const keys = new Set([...shape.matchAll(/^ {2}(\w+)\??:/gm)].map(m => m[1]));
  const servers = readdirSync(join(SRC, "web"))
    .filter(name => name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith("-ui.ts") && name !== "app-html.ts" && name !== "settings-registry.ts")
    .map(name => readFileSync(join(SRC, "web", name), "utf8"))
    .join("\n");
  for (const pane of SETTINGS_PANES) {
    for (const key of pane.config) assert.ok(keys.has(key), `${pane.key}: config.json has no ${key}`);
    for (const api of pane.apis) assert.ok(servers.includes(`${api}"`) || servers.includes(`${api}/`) || servers.includes(`${api}'`), `${pane.key}: nothing serves ${api}`);
  }
});
