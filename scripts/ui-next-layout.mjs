/** Real browser geometry for the rebuilt page (INV-1825), beside ui-layout.mjs which checks the classic one. See docs/92. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { hermeticEnv } from "./test-env.mjs";

const home = mkdtempSync(join(tmpdir(), "lumen-next-layout-"));
const child = spawn(process.execPath, ["--experimental-transform-types", "scripts/ui-layout-fixture.ts"], {
  env: { ...hermeticEnv(), AGENTBOX_HOME: home, AGENTBOX_TRUST_GATEWAY_IDENTITY: "1" }, stdio: ["ignore", "pipe", "pipe"],
});
let browser, cases = 0;
try {
  const meta = await new Promise((resolveReady, reject) => {
    let text = "", diagnostics = "";
    const timer = setTimeout(() => reject(new Error("layout server did not start: " + diagnostics)), 30000);
    child.stderr.on("data", data => { diagnostics = (diagnostics + data).slice(-4000); });
    child.once("exit", code => { clearTimeout(timer); reject(new Error("layout server exited " + code + ": " + diagnostics)); });
    child.stdout.on("data", data => {
      text += data;
      const line = text.split("\n").find(line => line.startsWith('{"base"'));
      if (line) { clearTimeout(timer); resolveReady(JSON.parse(line)); }
    });
  });
  browser = await chromium.launch({ headless: true, ...(process.env.UI_LAYOUT_BROWSER ? { executablePath: process.env.UI_LAYOUT_BROWSER } : {}) });
  for (const lang of ["en", "zh"]) for (const width of [1440, 480]) {
    const where = `${lang} ${width}`;
    const context = await browser.newContext({ viewport: { width, height: 900 }, extraHTTPHeaders: { authorization: "Bearer layout-fixture", "x-agentbox-user": "web:layout-viewer" } });
    const page = await context.newPage(), errors = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    // Nothing may be wider than the window: a sideways scrollbar is a control somebody cannot reach.
    const fits = async what => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${where}: ${what} is wider than the window`);
    const box = async selector => { const found = await page.locator(selector).first().boundingBox(); assert.ok(found, `${where}: ${selector} is not drawn`); return found; };
    const inside = (inner, outer, what) => assert.ok(inner.x >= outer.x - 1 && inner.x + inner.width <= outer.x + outer.width + 1, `${where}: ${what} leaves its column`);
    await page.goto(`${meta.base}/?ui=next&lang=${lang}`);
    await page.waitForSelector(".agent"); await fits("the landing");
    await page.locator(".agent").first().click();
    await page.waitForSelector("[data-result]"); await fits("the conversation");
    // The conversation: the result card and the box you type in sit in the same column, on screen.
    const view = await box("#view"), card = await box("[data-result]"), composer = await box("#composer-text");
    inside(card, view, "the result card"); inside(composer, { x: 0, width }, "the composer");
    assert.ok(composer.y + composer.height <= 900 + 1, `${where}: the composer is below the fold`);
    // Its buttons: side by side or wrapped, never on top of each other.
    const buttons = await page.locator("[data-result] .acts button").evaluateAll(nodes => nodes.map(node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, cut: node.scrollWidth > node.clientWidth + 1 }; }));
    assert.equal(buttons.length, 3, `${where}: the card offers accept, changes and open`);
    for (const [index, a] of buttons.entries()) {
      assert.equal(a.cut, false, `${where}: a card button's words are cut off`);
      for (const b of buttons.slice(index + 1)) assert.ok(a.x + a.w <= b.x + 1 || b.x + b.w <= a.x + 1 || a.y + a.h <= b.y + 1 || b.y + b.h <= a.y + 1, `${where}: two card buttons overlap`);
    }
    // Wide, the agent list stays beside the conversation; narrow, the conversation has the screen and a way back.
    if (width >= 1000) { const side = await box("#agents"); assert.ok(side.x + side.width <= view.x + 1, `${where}: the agent list covers the conversation`); }
    else assert.equal(await page.locator("#back").isVisible(), true, `${where}: no way back to the agent list`);
    // The work panel opens over it and stays on screen.
    await page.locator("[data-result] .acts button").nth(2).click();
    await page.waitForSelector("#panel-inner h3"); await page.waitForTimeout(350);
    inside(await box("#panel"), { x: 0, width }, "the work panel"); await fits("the work panel");
    await page.locator("#panel-close").click();
    if (width < 1000) await page.locator("#back").click();
    for (const nav of ["work", "boxes", "settings"]) {
      await page.locator(`[data-nav="${nav}"]`).click(); await page.waitForTimeout(350); await fits(`the ${nav} view`);
      if (width < 1000) await page.locator("#back").click();
    }
    // The way to the other language and the other page: on screen, side by side.
    if (width < 1000) { await page.goto(`${meta.base}/?ui=next&lang=${lang}`); await page.waitForSelector(".agent"); }
    const foot = [await box("#theme"), await box("#lang"), await box("#classic")];
    assert.ok(foot[0].x + foot[0].width <= foot[1].x + 1 && foot[1].x + foot[1].width <= foot[2].x + 1 && foot[2].x + foot[2].width <= width + 1, `${where}: the foot controls overlap or leave the screen`);
    // A link to one piece of work opens it.
    await page.goto(`${meta.base}/?ui=next&lang=${lang}&task=${meta.task}`);
    await page.waitForSelector("#panel-inner h3"); inside(await box("#panel"), { x: 0, width }, "the linked work");
    assert.deepEqual(errors, [], `${where}: the page reported errors`);
    await context.close(); cases++;
  }
  console.log(`next layout: ${cases} real browser cases passed`);
} finally {
  await browser?.close();
  child.kill("SIGTERM");
  if (child.exitCode === null) await new Promise(resolveExit => child.once("exit", resolveExit));
  rmSync(home, { recursive: true, force: true });
}
