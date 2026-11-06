/**
 * The Manual link (INV-1683): the top bar points at the manual's one URL, and the desktop
 * shell hands that page to the system browser instead of opening it inside the app.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { APP_HTML } from "./app-html.ts";
import { MANUAL_URL } from "./manual-link.ts";
import { MESSAGES } from "../i18n/messages.ts";

type OpenAction = { action: "allow" | "deny" };
const { windowOpenAction } = createRequire(import.meta.url)("../../electron/external-links.cjs") as {
  windowOpenAction(url: string, appOrigin: string, openExternal: (url: string) => unknown): OpenAction;
};

test("the top bar's Manual link opens the manual on GitHub in a new window, beside Settings", () => {
  const anchor = APP_HTML.match(/<a id="manuallink"[^>]*>/)?.[0];
  assert.ok(anchor, "the top bar has a Manual link");
  assert.equal(anchor.match(/href="([^"]*)"/)?.[1], MANUAL_URL);
  assert.match(anchor, /target="_blank"/);
  assert.match(anchor, /rel="noopener noreferrer"/);
  const bar = APP_HTML.slice(APP_HTML.indexOf('<header id="topbar"'), APP_HTML.indexOf("</header>"));
  assert.ok(bar.indexOf('id="manuallink"') > 0 && bar.indexOf('id="manuallink"') < bar.indexOf('id="settingsbtn"'), "it sits in the top bar, just before Settings");
  assert.match(APP_HTML, /\$\("manuallink"\)\.textContent = t\("ui\.manual"\)/, "its label goes through the page's words");
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
