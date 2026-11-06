/**
 * The Manual link (INV-1683): the top bar points at the manual's one URL, and the desktop
 * shell hands that page to the system browser instead of opening it inside the app.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { APP_PAGE } from "./page-locale.ts";
/** The page as an English reader receives it: its words filled from the bundle (INV-1684). */
const APP_HTML = APP_PAGE("en");
import { MANUAL_URL, MANUAL_URL_ZH } from "./manual-link.ts";
import { MESSAGES } from "../i18n/messages.ts";

type OpenAction = { action: "allow" | "deny" };
const { windowOpenAction } = createRequire(import.meta.url)("../../electron/external-links.cjs") as {
  windowOpenAction(url: string, appOrigin: string, openExternal: (url: string) => unknown): OpenAction;
};

test("the top bar's Manual link opens the manual on GitHub in a new window, beside Settings", () => {
  const anchor = APP_HTML.match(/<a id="manuallink"[^>]*>/)?.[0];
  assert.ok(anchor, "the top bar has a Manual link");
  assert.equal(anchor.match(/href="([^"]*)"/)?.[1], MANUAL_URL);
  assert.equal(APP_PAGE("zh").match(/<a id="manuallink"[^>]*href="([^"]*)"/)?.[1], MANUAL_URL_ZH, "a Chinese reader is sent to the Chinese manual (INV-1684)");
  assert.ok(existsSync(join(import.meta.dirname, "..", "..", "docs", "manual", "README.zh.md")), "which exists");
  assert.match(anchor, /target="_blank"/);
  assert.match(anchor, /rel="noopener noreferrer"/);
  const bar = APP_HTML.slice(APP_HTML.indexOf('<header id="topbar"'), APP_HTML.indexOf("</header>"));
  assert.ok(bar.indexOf('id="manuallink"') > 0 && bar.indexOf('id="manuallink"') < bar.indexOf('id="settingsbtn"'), "it sits in the top bar, just before Settings");
  assert.match(APP_HTML, /<a id="manuallink"[^>]*>Manual<\/a>/, "its label is the bundle's word, in English");
  assert.match(APP_PAGE("zh"), /<a id="manuallink"[^>]*>手册<\/a>/, "and in Chinese");
  assert.equal(MESSAGES.en["ui.manual"], "Manual");
  assert.equal(MESSAGES.zh["ui.manual"], "手册");
});

test("in the desktop shell an off-origin link goes to the system browser; the app's own windows stay", () => {
  const app = "http://127.0.0.1:7777";
  const opened: string[] = [];
  const open = (url: string) => opened.push(url);
  assert.deepEqual(windowOpenAction(MANUAL_URL, app, open), { action: "deny" }, "no child window for the manual");
  assert.deepEqual(opened, [MANUAL_URL]);
  assert.deepEqual(windowOpenAction(`${app}/desktop/ada`, app, open), { action: "allow" }, "a desktop needs the app's session");
  assert.deepEqual(windowOpenAction("file:///etc/passwd", app, open), { action: "deny" });
  assert.deepEqual(windowOpenAction("not a url", app, open), { action: "deny" });
  assert.deepEqual(opened, [MANUAL_URL], "only web links are handed to the OS");
});
