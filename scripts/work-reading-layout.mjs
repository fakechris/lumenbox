/** Actual production page, isolated durable fixtures, and bounded rendering at history scale. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { hermeticEnv } from "./test-env.mjs";

const home = mkdtempSync(join(tmpdir(), "work-reading-browser-"));
const output = resolve(process.env.UI_LAYOUT_OUTPUT ?? "research/work-reading-layout");
mkdirSync(output, { recursive: true });
const child = spawn(process.execPath, ["--experimental-transform-types", "scripts/ui-layout-fixture.ts", "--work-scale"], { env: { ...hermeticEnv(), AGENTBOX_HOME: home, AGENTBOX_TRUST_GATEWAY_IDENTITY: "1" }, stdio: ["ignore", "pipe", "pipe"] });
let browser, activePage;
try {
  const meta = await new Promise((done, reject) => {
    let text = "", diagnostic = "";
    const timer = setTimeout(() => reject(new Error("fixture startup: " + diagnostic)), 30000);
    child.stderr.on("data", chunk => { diagnostic = (diagnostic + chunk).slice(-3000); });
    child.once("exit", code => { clearTimeout(timer); reject(new Error("fixture exited " + code + diagnostic)); });
    child.stdout.on("data", chunk => { text += chunk; const line = text.split("\n").find(line => line.startsWith('{"base"')); if (line) { clearTimeout(timer); done(JSON.parse(line)); } });
  });
  browser = await chromium.launch({ headless: true, ...(process.env.UI_LAYOUT_BROWSER ? { executablePath: process.env.UI_LAYOUT_BROWSER } : {}) });
  const results = [];
  for (const lang of ["zh", "en"]) for (const dark of [false, true]) for (const width of [1440, 480]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, extraHTTPHeaders: { authorization: "Bearer layout-fixture", "x-agentbox-user": "web:layout-viewer" }, colorScheme: dark ? "dark" : "light" });
    await context.addInitScript(() => localStorage.setItem("lumen-onboarded", "1"));
    const page = await context.newPage(), errors = [], requests = []; activePage = page;
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => requests.push(request.url()));
    await page.route("**/*", route => route.request().url().startsWith(meta.base) ? route.continue() : route.abort());
    await page.goto(meta.base + "/?lang=" + lang + "&agent=" + meta.agent);
    await page.waitForFunction(() => !!window.openTeamTasks && !!current);
    if (await page.locator("#settingswrap").isVisible()) await page.locator("#setcancel").click();
    // A normal AskUser choice is not a ShowUI surface action. Exercise the actual button.
    let answer;
    await page.route("**/api/prompt", async route => { answer = route.request().postDataJSON(); await route.fulfill({ json: { ok: true } }); });
    await page.evaluate(() => window.pushItem({ kind: "question", question: "Choose installation directory", options: ["Use approved folder"] }));
    const sentAnswer = page.waitForResponse(response => response.url() === meta.base + "/api/prompt");
    await page.locator(".qopt").last().click();
    await sentAnswer;
    assert.equal(answer?.text, "Use approved folder"); assert.equal(answer?.surfaceAction, undefined);
    await page.unroute("**/api/prompt");
    await page.evaluate(dark => { document.documentElement.dataset.theme = dark ? "dark" : "light"; window.openTeamTasks(); }, dark);
    await page.waitForSelector("[data-task-row]");
    assert.ok(await page.locator("[data-task-row]").count() <= 50);
    assert.match(await page.locator("#taskpager").innerText(), /1600/);
    assert.doesNotMatch(await page.locator("#tasklist").innerText(), /Internal probe fixture/);
    const refusedPress = await context.request.post(meta.base + "/api/prompt", { data: { agent: meta.agent, conversation: "main", text: '[Action "confirm" on card missing-fixture-card]', surfaceAction: { surface: "missing-fixture-card", name: "confirm" }, messageId: "missing-card-" + lang + "-" + width } });
    assert.equal(refusedPress.status(), 409, "a missing card cannot admit a new user task or invoke a model");
    const afterPress = await (await context.request.get(meta.base + "/api/tasks/list?records=user&limit=1")).json();
    assert.equal(afterPress.total, 1600);
    await page.locator("#task-search").fill("Target work 1377");
    await page.waitForFunction(() => document.getElementById("tasklist").textContent.includes("Target work 1377"));
    assert.equal(await page.locator("[data-task-row]").count(), 1);
    await page.locator("#task-search").fill("");
    await page.waitForFunction(() => document.querySelectorAll("[data-task-row]").length === 50);
    await page.evaluate(id => window.openTaskFocus(id), meta.task);
    await page.waitForSelector("#tf-title");
    await page.waitForFunction(() => document.getElementById("tf-title").textContent.includes("approved skill"));
    await page.locator('[data-tf-tab="overview"]').click();
    await page.waitForSelector("#tf-reading");
    assert.equal(await page.locator("#tf-reading .wr-check").getAttribute("open"), null);
    assert.equal(requests.filter(url => url.includes("/execution/step?")).length, 0, "no step body is loaded before selection");
    await page.addStyleTag({ content: ":root{--fs-xs:17.6px;--fs-sm:19.2px;--fs-md:20.8px;--fs-body:24px;--fs-lg:28.8px;--fs-xl:35.2px}html{font-size:24px}" });
    const collisions = await page.locator(".tf-head").evaluate(header => {
      const rects = [...header.querySelectorAll("button:not([hidden])")].filter(node => node.getClientRects().length && getComputedStyle(node).visibility !== "hidden").map(node => ({ label: node.textContent, r: node.getBoundingClientRect() }));
      return rects.flatMap((left, n) => rects.slice(n + 1).filter(right => Math.min(left.r.right, right.r.right) - Math.max(left.r.left, right.r.left) > 1 && Math.min(left.r.bottom, right.r.bottom) - Math.max(left.r.top, right.r.top) > 1).map(right => left.label + " / " + right.label));
    });
    assert.deepEqual(collisions, []);
    assert.equal(await page.locator("#taskfocus").evaluate(node => node.scrollWidth > node.clientWidth + 1), false);
    const proof = `${lang}-${dark ? "dark" : "light"}-${width}`;
    await page.screenshot({ path: join(output, proof + ".png") });
    await page.locator('[data-tf-tab="execution"]').click();
    await page.waitForSelector("[data-tf-step]");
    assert.ok(await page.locator("[data-tf-step]").count() <= 100);
    assert.match(await page.locator("#tf-range").innerText(), /2000|2,000/);
    await page.locator("[data-tf-step]").first().click();
    await page.waitForFunction(() => document.getElementById("tf-detail").textContent.includes("Verified original file bytes"));
    const count = await page.locator("[data-tf-step]").count();
    await page.evaluate(id => { for (let n = 0; n < 100; n++) window.taskFocusEvent({ type: "task_changed", taskId: id }); }, meta.task);
    assert.equal(await page.locator("[data-tf-step]").count(), count, "incremental task events do not replace the steps");
    let releaseAuthorization;
    const authorizationHeld = new Promise(done => { releaseAuthorization = done; });
    await page.route("**/api/tasks/item?*", async route => { await authorizationHeld; await route.fulfill({ status: 403, json: { error: "Access no longer available" } }); });
    await page.evaluate(() => { void window.refreshTaskExecution(); });
    assert.equal(await page.locator("#tf-body").innerText(), "");
    assert.equal(await page.locator("#tf-cancel").isVisible(), false);
    releaseAuthorization();
    await page.waitForFunction(() => document.getElementById("tf-body").textContent.includes("Record unavailable") || document.getElementById("tf-body").textContent.includes("记录不可用"));
    await page.unroute("**/api/tasks/item?*");
    await page.evaluate(() => window.openTaskFocus("missing-fixture-record"));
    await page.waitForFunction(() => document.getElementById("tf-body").textContent.includes("Record unavailable") || document.getElementById("tf-body").textContent.includes("记录不可用"));
    assert.equal(await page.locator("#tf-cancel").isVisible(), false);
    assert.deepEqual(errors, []);
    results.push({ lang, dark, width, tasks: 1600, steps: 2000, firstTaskPage: 50, firstStepPage: 100, largeType: true, collisions });
    process.stdout.write(JSON.stringify({ case: proof, passed: true }) + "\n");
    await context.close();
  }
  writeFileSync(join(output, "results.json"), JSON.stringify(results, null, 2));
  process.stdout.write(JSON.stringify({ passed: results.length, output }) + "\n");
} catch (error) {
  if (activePage && !activePage.isClosed()) await activePage.screenshot({ path: join(output, "failure.png") }).catch(() => {});
  throw error;
} finally {
  await browser?.close(); child.kill("SIGTERM"); rmSync(home, { recursive: true, force: true });
}
