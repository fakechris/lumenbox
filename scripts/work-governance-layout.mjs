/** Global management through real routes and actual controls against an isolated installation. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { hermeticEnv } from "./test-env.mjs";
const home = mkdtempSync(join(tmpdir(), "work-governance-browser-")), output = resolve(process.env.UI_LAYOUT_OUTPUT ?? "research/work-governance-layout"); mkdirSync(output, { recursive: true });
const child = spawn(process.execPath, ["--experimental-transform-types", "scripts/work-governance-fixture.ts"], { env: { ...hermeticEnv(), AGENTBOX_HOME: home, AGENTBOX_TRUST_GATEWAY_IDENTITY: "1" }, stdio: ["ignore", "pipe", "pipe"] });
let browser, active;
try {
  const meta = await new Promise((done, reject) => { let text = "", diagnostic = ""; const timer = setTimeout(() => reject(Error("Fixture startup: " + diagnostic)), 30000); child.stderr.on("data", chunk => { diagnostic = (diagnostic + chunk).slice(-3000); }); child.on("exit", code => { clearTimeout(timer); reject(Error("Fixture exited " + code + ": " + diagnostic)); }); child.stdout.on("data", chunk => { text += chunk; const line = text.split("\n").find(line => line.startsWith('{"base"')); if (line) { clearTimeout(timer); done(JSON.parse(line)); } }); });
  browser = await chromium.launch({ headless: true, ...(process.env.UI_LAYOUT_BROWSER ? { executablePath: process.env.UI_LAYOUT_BROWSER } : {}) });
  const results = []; let caseIndex = 0;
  for (const lang of ["zh", "en"]) for (const dark of [false, true]) for (const width of [1440, 480]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, extraHTTPHeaders: { authorization: "Bearer layout-fixture", "x-agentbox-user": "web:layout-viewer" } }); await context.addInitScript(() => localStorage.setItem("lumen-onboarded", "1"));
    const page = await context.newPage(), errors = []; active = page; page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => route.request().url().startsWith(meta.base) ? route.continue() : route.abort());
    await page.goto(meta.base + "/?lang=" + lang + "&agent=" + meta.agent); await page.waitForFunction(() => !!window.openWorkManagement && !!current);
    await page.locator("#work-management-nav").click(); await page.waitForSelector("[data-wg-resource]"); await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(dark => { document.documentElement.dataset.theme = dark ? "dark" : "light"; }, dark);
    await page.addStyleTag({ content: ":root{--fs-xs:17.6px;--fs-sm:19.2px;--fs-md:20.8px;--fs-body:24px;--fs-lg:28.8px;--fs-xl:35.2px}html{font-size:24px}" });
    const initial = await (await context.request.get(meta.base + "/api/work-management?section=future")).json(); assert.equal(initial.metrics.executions, 0); assert.ok(initial.metrics.future > 0); assert.ok(initial.total > 50); assert.equal(initial.rows.length, 50);
    await page.locator('[data-wg-section="history"]').click(); await page.locator("#wg-search").fill("Legacy installation 1377"); await page.waitForFunction(() => document.getElementById("wg-list").textContent.includes("Legacy installation 1377")); assert.equal(await page.locator("[data-wg-resource]").count(), 1);
    await page.locator("#wg-search").fill("Ended internal probe"); await page.waitForFunction(() => document.getElementById("wg-pager").textContent.includes("/ 0")); await page.locator("#wg-archive").check(); await page.waitForFunction(() => document.querySelectorAll("[data-wg-resource]").length === 20); await page.locator("#wg-archive").uncheck(); await page.waitForFunction(() => document.querySelectorAll("[data-wg-resource]").length === 0);
    await page.locator("#wg-search").fill(""); await page.waitForFunction(() => document.querySelectorAll("[data-wg-resource]").length > 0);
    await page.locator('[data-wg-section="future"]').click(); await page.waitForSelector("[data-wg-select]");
    await page.locator("[data-wg-select]").nth(0).check(); await page.locator("[data-wg-select]").nth(1).check(); await page.locator("#wg-preview-action").click(); await page.waitForFunction(() => !document.getElementById("wg-confirm").disabled);
    assert.equal(await page.locator("#wg-preview-body article").count(), 2); await page.locator("#wg-confirm").click(); await page.waitForFunction(() => document.getElementById("wg-confirm").textContent.includes("重试") || document.getElementById("wg-confirm").textContent.includes("Retry")); assert.equal(await page.locator("#wg-confirm").isDisabled(), true);
    await page.evaluate(() => document.getElementById("wg-preview").close());
    const after = await (await context.request.get(meta.base + "/api/work-management?section=future")).json(); assert.equal(after.total, initial.total - 2, "only the selected messages stop");
    await page.locator('[data-wg-section="history"]').click(); const reply = "Old reply " + (149 - caseIndex); await page.locator("#wg-search").fill(reply); await page.waitForFunction(text => document.getElementById("wg-list").textContent.includes(text), reply); await page.locator("[data-wg-select]").first().check(); await page.locator("#wg-preview-action").click(); await page.waitForFunction(() => !document.getElementById("wg-confirm").disabled); await page.locator("#wg-confirm").click(); await page.waitForFunction(() => document.getElementById("wg-confirm").disabled && (document.getElementById("wg-confirm").textContent.includes("重试") || document.getElementById("wg-confirm").textContent.includes("Retry"))); await page.evaluate(() => document.getElementById("wg-preview").close());
    await page.locator("#wg-search").fill(""); await page.waitForFunction(() => document.querySelectorAll("[data-wg-resource]").length === 50);
    assert.equal(await page.locator("#wg-panel").evaluate(n => n.scrollWidth > n.clientWidth + 1), false);
    const collisions = await page.locator(".wg-tools").evaluate(n => { const rects = [...n.children].map(child => child.getBoundingClientRect()); return rects.some((a, i) => rects.slice(i + 1).some(b => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1)); }); assert.equal(collisions, false);
    const name = `${lang}-${dark ? "dark" : "light"}-${width}`; await page.screenshot({ path: join(output, name + ".png") }); assert.deepEqual(errors, []); results.push({ name, records: 1600, pageLimit: 50, zeroExecutionsWithFuture: true, stoppedMessages: 2, discardedReply: reply, largeType: true }); process.stdout.write(JSON.stringify({ case: name, passed: true }) + "\n"); caseIndex++; await context.close();
  }
  writeFileSync(join(output, "results.json"), JSON.stringify(results, null, 2)); process.stdout.write(JSON.stringify({ passed: results.length }) + "\n");
} catch (error) { if (active && !active.isClosed()) await active.screenshot({ path: join(output, "failure.png") }).catch(() => {}); throw error; }
finally { await browser?.close(); child.kill("SIGTERM"); rmSync(home, { recursive: true, force: true }); }
