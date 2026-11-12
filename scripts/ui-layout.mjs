/** Real browser geometry, separate from the hermetic unit-test runner. See docs/92. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { chromium } from "playwright-core";
import { hermeticEnv } from "./test-env.mjs";

const home = mkdtempSync(join(tmpdir(), "lumen-layout-"));
const output = resolve(process.env.UI_LAYOUT_OUTPUT ?? "research/ui-layout");
mkdirSync(output, { recursive: true });
const child = spawn(process.execPath, ["--experimental-transform-types", "scripts/ui-layout-fixture.ts"], {
  env: { ...hermeticEnv(), AGENTBOX_HOME: home, AGENTBOX_TRUST_GATEWAY_IDENTITY: "1" }, stdio: ["ignore", "pipe", "pipe"],
});
let browser;
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
  const metrics = [];
  for (const lang of ["en", "zh"]) {
    const context = await browser.newContext({ viewport: { width: 1800, height: 1100 }, extraHTTPHeaders: {
      authorization: "Bearer layout-fixture", "x-agentbox-user": "web:layout-viewer",
    } });
    await context.addInitScript(() => localStorage.setItem("lumen-onboarded", "1"));
    const page = await context.newPage(), errors = [];
    const actualSetup = await (await context.request.get(meta.base + "/api/setup")).json();
    assert.equal(actualSetup.established, true); assert.equal(actualSetup.box, false);
    assert.equal(typeof actualSetup.installationId, "string");
    let setup = { installationId: "established-fixture", established: true, key: true, box: false, agentTurn: true, door: true, review: true, search: true };
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => route.request().url().startsWith(meta.base) ? route.continue() : route.abort());
    await page.route("**/api/agents/config-versions?*", route => route.fulfill({ json: { current: 123, versions: [], switches: [
      { n: 122, from: "2026-01-01T00:00:00Z", agentId: meta.agent, by: "fixture" },
    ] } }));
    await page.route("**/api/setup", route => route.fulfill({ json: setup }));
    await page.goto(meta.base + "/?ui=classic&lang=" + lang + "&agent=" + meta.agent);
    await page.waitForFunction(() => typeof window.configVersionChip === "function" && typeof current !== "undefined" && current);
    if (await page.locator("#settingswrap").isVisible()) await page.locator("#setcancel").click();
    await page.waitForSelector("#cvchip", { state: "visible" });
    for (const width of [640, 360, 480, 800, 1080]) for (const scale of [1, 1.5, 2]) for (const running of [false, true]) {
      await page.evaluate(({ width, scale, running }) => {
        document.getElementById("setupcard").style.display = "none";
        const pane = document.getElementById("middle"); pane.style.flex = "none"; pane.style.width = width + "px";
        const right = document.getElementById("rightpane"); right.style.flex = "none"; right.style.width = Math.min(width, 480) + "px";
        document.documentElement.style.fontSize = (15 * scale) + "px";
        const header = pane.querySelector(".paneheader");
        for (const el of document.querySelectorAll(".paneheader a,.paneheader button,.paneheader span")) {
          if (!el.dataset.layoutFont) el.dataset.layoutFont = parseFloat(getComputedStyle(el).fontSize);
          el.style.fontSize = (Number(el.dataset.layoutFont) * scale) + "px";
        }
        document.getElementById("title").textContent = "Nova · 长名称与角色 · Research operations coordinator";
        document.getElementById("round").textContent = running ? "round 14 · 92.1k in / 17.3k out" : "";
        document.getElementById("stop").style.display = running ? "" : "none";
      }, { width, scale, running });
      const failures = await page.evaluate(() => {
        const header = document.querySelector("#middle > .paneheader"), bounds = header.getBoundingClientRect();
        const nodes = [...header.querySelectorAll("#title,#titlerole,#convbtn,#agentcfg,#agentdel,#cvchip,#sharebtn,#searchbtn,#foldall,#round,#stop,[data-conversation-tasks]")]
          .filter(el => el.getClientRects().length && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0);
        const failures = [];
        for (const [i, a] of nodes.entries()) {
          const x = a.getBoundingClientRect();
          if (x.left < bounds.left - 1 || x.right > bounds.right + 1 || x.top < bounds.top - 1 || x.bottom > bounds.bottom + 1) failures.push(a.id + " outside header");
          for (const b of nodes.slice(i + 1)) {
            const y = b.getBoundingClientRect();
            if (Math.min(x.right,y.right) - Math.max(x.left,y.left) > 1 && Math.min(x.bottom,y.bottom) - Math.max(x.top,y.top) > 1) failures.push(a.id + " overlaps " + b.id);
          }
        }
        for (const group of document.querySelectorAll(".paneheader .lead,.paneheader .headactions")) {
          const parent = group.getBoundingClientRect();
          if (!parent.width || !parent.height) continue;
          for (const el of group.children) {
            if (getComputedStyle(el).position === "absolute") continue;
            const x = el.getBoundingClientRect(); if (!x.width || !x.height) continue;
            if (x.left < parent.left - 1 || x.right > parent.right + 1 || x.top < parent.top - 1 || x.bottom > parent.bottom + 1) failures.push((el.id || el.tagName) + " outside its group");
          }
        }
        return failures;
      });
      const name = `${lang}-${width}-${scale}-${running ? "busy" : "idle"}`;
      if (failures.length || (width === 640 && running && scale === 1)) await page.locator("#middle").screenshot({ path: join(output, name + ".png") });
      metrics.push({ name, failures });
      assert.deepEqual(failures, [], name);
    }
    // Popovers stay in the panel after controls have wrapped. Their contents remain clickable.
    await page.evaluate(() => { document.documentElement.style.fontSize = "15px"; });
    await page.locator("#cvchip").click();
    await page.waitForSelector("#cvpop");
    assert.ok(await page.locator("#cvpop [data-cvopen]").count());
    const popup = await page.locator("#cvpop").boundingBox(), pane = await page.locator("#middle").boundingBox();
    assert.ok(popup.x >= pane.x && popup.x + popup.width <= pane.x + pane.width + 1);
    await page.locator("#cvchip").click();
    await page.locator("#searchbtn").focus(); await page.keyboard.press("Enter");
    await page.waitForSelector("#searchq", { state: "visible" });
    await page.locator("#searchclose").click();
    await page.locator("#sharebtn").click(); await page.waitForSelector("#sharemenu", { state: "visible" });
    const share = await page.locator("#sharemenu").boundingBox();
    assert.ok(share.x >= pane.x && share.x + share.width <= pane.x + pane.width + 1);
    await page.locator("#sharebtn").click();
    await page.locator("[data-conversation-tasks]").click();
    await page.waitForFunction(() => document.querySelector("#tasksview").style.display !== "none");
    // A used installation's offline box is a connection issue, never first-run setup.
    await page.evaluate(() => refreshSetup()); assert.equal(await page.locator("#setupcard").isVisible(), false);
    await page.locator("#guidebtn").click(); await page.waitForSelector("#setupcard", { state: "visible" });
    assert.ok((await page.locator("#setupcard").innerText()).includes(lang === "en" ? "currently offline" : "离线"));
    await page.locator("[data-setup-close]").click(); await page.evaluate(() => refreshSetup());
    assert.equal(await page.locator("#setupcard").isVisible(), false);
    await page.reload(); await page.waitForFunction(() => typeof refreshSetup === "function"); await page.evaluate(() => refreshSetup());
    assert.equal(await page.locator("#setupcard").isVisible(), false);
    // First run still guides. Closing survives polling and reload, scoped to that installation.
    setup = { installationId: "fresh-fixture", established: false, key: false, box: false, agentTurn: false, door: false, review: false, search: false };
    await page.evaluate(() => refreshSetup()); await page.waitForSelector("#setupcard", { state: "visible" });
    await page.locator("[data-setup-close]").click(); await page.evaluate(() => refreshSetup());
    assert.equal(await page.locator("#setupcard").isVisible(), false);
    await page.reload(); await page.waitForFunction(() => typeof refreshSetup === "function"); await page.evaluate(() => refreshSetup());
    assert.equal(await page.locator("#setupcard").isVisible(), false);
    setup.installationId = "another-installation"; await page.evaluate(() => refreshSetup());
    assert.equal(await page.locator("#setupcard").isVisible(), true);
    assert.deepEqual(errors, []);
    await context.close();
  }
  writeFileSync(join(output, "results.json"), JSON.stringify(metrics, null, 2) + "\n");
  console.log(`layout: ${metrics.length} real browser cases passed`);
} finally {
  await browser?.close();
  child.kill("SIGTERM");
  if (child.exitCode === null) await new Promise(resolveExit => child.once("exit", resolveExit));
  rmSync(home, { recursive: true, force: true });
}
