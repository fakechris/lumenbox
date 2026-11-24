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
    const membership = page.locator("#box-members details");
    await membership.locator("summary").click();
    const description = membership.locator("div");
    await description.waitFor();
    assert.match(await description.textContent(), lang === "en" ? /^Shared box: .* or the web UI\.$/ : /^共享 box：.*访问它。$/);
    assert.equal(await description.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true, `${where}: the shared box description is clipped`);
    await membership.locator("summary").click();
    await page.locator(".agent").first().click();
    await page.waitForSelector("[data-result]"); await fits("the conversation");
    // The conversation: the result card and the box you type in sit in the same column, on screen.
    const view = await box("#view"), card = await box("[data-result]"), composer = await box("#composer-text");
    inside(card, view, "the result card"); inside(composer, { x: 0, width }, "the composer");
    // What waits stands above the conversation, which starts under it: no message is half behind the card (INV-1926).
    const dock = await box("#dock"); assert.ok(view.y >= dock.y + dock.height - 1, `${where}: the conversation runs behind the card above it`);
    assert.ok(composer.y + composer.height <= 900 + 1, `${where}: the composer is below the fold`);
    // Its buttons: side by side or wrapped, never on top of each other.
    const buttons = await page.locator("[data-result] .acts button").evaluateAll(nodes => nodes.map(node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, cut: node.scrollWidth > node.clientWidth + 1 }; }));
    assert.equal(buttons.length, 4, `${where}: the card offers accept, changes, open and later`);
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
    if (width === 480) {
      await page.route("**/desktop/**", route => route.fulfill({ contentType: "text/html", body: "<p>Desktop fixture</p>" }));
      await page.route("**/api/desktop/control", route => route.fulfill({ json: { ok: true } }));
      for (const deskWidth of [390, 400]) {
        await page.setViewportSize({ width: deskWidth, height: 679 });
        if (deskWidth === 390) await page.locator("#screen-toggle").click();
        await page.locator(".desk .acts button").first().click();
        const note = page.locator(".desk p");
        await note.waitFor();
        assert.equal(await note.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true, `${lang} ${deskWidth}: the driving instructions are clipped`);
        inside(await box(".desk .act-primary"), { x: 0, width: deskWidth }, "the hand-back button");
        await page.locator(".desk .act-primary").click();
        await note.waitFor({ state: "detached" });
      }
      await page.locator("#screen-close").click();
      await page.setViewportSize({ width, height: 900 });
    }
    if (width < 1000) await page.locator("#back").click();
    for (const nav of ["work", "boxes", "settings"]) {
      await page.locator(`[data-nav="${nav}"]`).click(); await page.waitForTimeout(350); await fits(`the ${nav} view`);
      if (width < 1000) await page.locator("#back").click();
    }
    if (width < 1000) {
      await page.locator('[data-nav="work"]').click();
      await page.locator("#back").click();
      assert.ok(!new URL(page.url()).searchParams.has("view"), `${where}: closing Work clears its route`);
      await page.locator('[data-nav="settings"]').click();
      await page.goBack();
      await page.locator(".agent").first().waitFor();
      assert.ok(!new URL(page.url()).searchParams.has("view"), `${where}: Back from Settings returns to the agent list`);
    }
    await page.route("**/api/boxes?*", async route => {
      const response = await route.fetch(), result = await response.json();
      const shared = result.boxes.find(machine => machine.members === "everyone");
      result.boxes.push({ ...shared, id: "layout-shared", name: "Second shared box", agents: 0 });
      await route.fulfill({ response, json: result });
    });
    const checkMembershipRedraw = async what => {
      const folds = page.locator("#view details.box-members");
      await folds.nth(1).locator("summary").click();
      await page.evaluate(() => render());
      assert.deepEqual(await folds.evaluateAll(nodes => nodes.map(node => node.open)), [false, true], `${where}: ${what} should keep only the second box open after a redraw`);
    };
    await page.locator('[data-nav="boxes"]').click();
    await page.evaluate(() => refresh());
    await checkMembershipRedraw("Boxes");
    await page.locator("#view section.setting button").click();
    await checkMembershipRedraw("Settings → Boxes");
    // The way to the other language and the other page: on screen, side by side.
    if (width < 1000) { await page.goto(`${meta.base}/?ui=next&lang=${lang}`); await page.waitForSelector(".agent"); }
    const foot = [await box("#theme"), await box("#lang"), await box("#classic")];
    assert.ok(foot[1].height < 40, `${where}: the language switch wraps onto two lines`);
    assert.ok(foot[0].x + foot[0].width <= foot[1].x + 1 && foot[1].x + foot[1].width <= foot[2].x + 1 && foot[2].x + foot[2].width <= width + 1, `${where}: the foot controls overlap or leave the screen`);
    // A link to one piece of work opens it.
    await page.goto(`${meta.base}/?ui=next&lang=${lang}&task=${meta.task}`);
    await page.waitForSelector("#panel-inner h3"); inside(await box("#panel"), { x: 0, width }, "the linked work");
    assert.deepEqual(errors, [], `${where}: the page reported errors`);
    await context.close(); cases++;
  }
  const admin = await browser.newContext({
    extraHTTPHeaders: { authorization: "Bearer layout-fixture", "x-agentbox-user": "web:layout-viewer" },
  });
  const settings = await admin.newPage();
  const people = settings.getByRole("heading", { name: "People", exact: true });
  const overview = settings.getByRole("heading", { name: "Other settings", exact: true });
  await settings.goto(`${meta.base}/?ui=next&lang=en`);
  await settings.locator('[data-nav="settings"]').click();
  await overview.waitFor();
  await settings.getByRole("button", { name: /^Team\b/ }).click();
  await people.waitFor();
  const teamUrl = settings.url();
  assert.equal(new URL(teamUrl).searchParams.get("pane"), "team");
  await settings.reload();
  await people.waitFor();
  await settings.goBack();
  await overview.waitFor();
  await settings.goForward();
  await people.waitFor();
  await settings.locator('[data-nav="work"]').click();
  await settings.goBack();
  await people.waitFor();
  assert.equal(settings.url(), teamUrl);
  await settings.getByRole("button", { name: /Settings · Team/ }).click();
  await overview.waitFor();
  assert.equal(new URL(settings.url()).searchParams.has("pane"), false);

  const deepLink = await admin.newPage();
  await deepLink.goto(teamUrl.replace("pane=team", "pane=constructor"));
  await deepLink.getByRole("heading", { name: "Other settings", exact: true }).waitFor();
  await deepLink.goto(teamUrl);
  await deepLink.getByRole("heading", { name: "People", exact: true }).waitFor();
  await deepLink.getByRole("button", { name: "Make an invitation" }).click();
  const invite = deepLink.locator("#view .card-code");
  await invite.waitFor();
  const guest = await browser.newContext();
  const redeemed = await guest.request.post(`${meta.base}/api/login`, {
    data: { code: await invite.textContent(), name: "Invited colleague" },
  });
  assert.ok(redeemed.ok(), "the other browser can redeem the invite");
  await invite.waitFor({ state: "hidden", timeout: 8000 });
  await deepLink.locator(".person-row strong", { hasText: "Invited colleague" }).waitFor();
  assert.equal(deepLink.url(), teamUrl, "the invite updates without navigating away");
  await guest.close();
  await admin.close();
  console.log("settings: deep links, browser history and invite redemption passed");
  console.log(`next layout: ${cases} real browser cases passed`);
} finally {
  await browser?.close();
  child.kill("SIGTERM");
  if (child.exitCode === null) await new Promise(resolveExit => child.once("exit", resolveExit));
  rmSync(home, { recursive: true, force: true });
}
