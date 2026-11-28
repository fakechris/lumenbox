/**
 * Real-browser click-through E2E for the local / port-forward first-Admin bootstrap flow (INV-2260).
 *
 * Starts `startWebServer({ host: "0.0.0.0", port: 0, useBox: false })` with `AGENTBOX_EXPOSURE=local`
 * and NO `AGENTBOX_PUBLIC_URL` or pre-set token — matching a port-forwarded k3s organisation pod —
 * and drives headless Chromium through every click:
 *   1. `/` -> `Set up the first administrator` -> `/bootstrap`, which is only the operator unlock
 *   2. Enter the operator credential -> back to `/bootstrap`, now only the callback address
 *   3. `Use current origin` -> only the vendor choice -> DingTalk -> both credentials, with the exact callback
 *   4. Save -> the review, and only `Confirm and continue` reaches the one-use code
 *   5. Enter `bootstrap-code`, click `Sign in with DingTalk`, follow the mocked OAuth callback,
 *      land as `admin` (`dingtalk:ana-staff`), and confirm `/bootstrap` is 404.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { resetConfigEnvForTests } from "../src/config.ts";
import { Principals } from "../src/host/principals.ts";
import { startWebServer } from "../src/web/server.ts";

const home = mkdtempSync(join(tmpdir(), "lumen-bootstrap-e2e-"));
const KEYS = ["AGENTBOX_HOME", "AGENTBOX_PUBLIC_URL", "AGENTBOX_EXPOSURE", "AGENTBOX_UI_TOKEN", "DINGTALK_CLIENT_ID", "DINGTALK_CLIENT_SECRET", "FEISHU_APP_ID", "FEISHU_APP_SECRET"];
const savedEnv = Object.fromEntries(KEYS.map(key => [key, process.env[key]]));
for (const key of KEYS) delete process.env[key];
resetConfigEnvForTests();
process.env.AGENTBOX_HOME = home;
process.env.AGENTBOX_EXPOSURE = "local";
writeFileSync(join(home, "principals.json"), JSON.stringify({ principals: [], installation: { mode: "organisation" } }));

const loginFetch = async (input, init) => {
  const url = new URL(String(input));
  const body = init?.body === undefined ? {} : JSON.parse(String(init.body));
  if (url.href === "https://api.dingtalk.com/v1.0/oauth2/userAccessToken") return Response.json({ accessToken: body.code, expireIn: 7200 });
  if (url.href === "https://api.dingtalk.com/v1.0/contact/users/me") return Response.json({ unionId: new Headers(init?.headers).get("x-acs-dingtalk-access-token"), nick: "Ana" });
  if (url.href === "https://api.dingtalk.com/v1.0/oauth2/accessToken") return Response.json({ accessToken: "app-token", expireIn: 7200 });
  if (url.origin + url.pathname === "https://oapi.dingtalk.com/topapi/user/getbyunionid") return Response.json({ errcode: 0, errmsg: "ok", result: { userid: "ana-staff", contact_type: 0 } });
  throw new Error(`unexpected vendor call ${url.href}`);
};

let stop;
let browser;
try {
  let listenUrl = "";
  stop = await startWebServer({
    port: 0,
    host: "0.0.0.0",
    useBox: false,
    loginFetch,
    onLog: () => {},
    onReady: url => { listenUrl = url; },
  });
  const port = new URL(listenUrl).port;
  const base = `http://127.0.0.1:${port}`;
  const uiCred = readFileSync(join(home, "ui-token"), "utf8").trim();
  const bootstrapCode = readFileSync(join(home, "bootstrap-code"), "utf8").trim();

  const executablePath = [
    process.env.UI_LAYOUT_BROWSER,
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].find(candidate => candidate && existsSync(candidate));
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const context = await browser.newContext({ locale: "en-US", viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", err => pageErrors.push(err.message));

  // Intercept external DingTalk OAuth authorize redirect and bounce straight back to our local callback!
  await page.route("https://login.dingtalk.com/**", async route => {
    const target = new URL(route.request().url());
    const redirectUri = target.searchParams.get("redirect_uri");
    const state = target.searchParams.get("state");
    assert.equal(redirectUri, `${base}/auth/dingtalk/callback`, "DingTalk redirect_uri matches saved callback base URL");
    assert.ok(state, "OAuth state present");
    await route.fulfill({
      status: 302,
      headers: { location: `${redirectUri}?state=${encodeURIComponent(state)}&code=union-ana&authCode=union-ana` },
      body: "",
    });
  });

  // Step 1: Open `/` unauthenticated -> click `Set up the first administrator` -> `/bootstrap`
  await page.goto(`${base}/?lang=en`);
  await page.locator('a[href="/bootstrap"]', { hasText: "Set up the first administrator" }).click();
  await page.waitForURL(`${base}/bootstrap`);
  assert.match(await page.locator("h1").textContent(), /First administrator/);

  // Step 2: The first screen is only the operator credential. It does not ask for the one-use code.
  await page.waitForSelector('[data-step="unlock"] #op-unlock');
  assert.equal(await page.locator("#code").count(), 0);
  await page.locator("#op-cred").fill(uiCred);
  await page.locator("#op-unlock button[type='submit']").click();

  // Step 3: One decision, the callback address. Using this browser's origin warns that the vendor cannot call it.
  await page.waitForSelector('[data-step="url"] #use-origin');
  assert.match(await page.locator("#url-loopback").textContent(), /cannot call it/);
  assert.equal(await page.locator("#op-unlock").count(), 0);
  assert.equal(await page.locator("#code").count(), 0);
  await page.locator("#use-origin").click();

  // Step 4: Pick DingTalk, then both of its credentials, with the exact callback.
  await page.waitForSelector('[data-step="vendor"]');
  await page.locator('a[href*="vendor=dingtalk"]').click();
  await page.waitForSelector('[data-step="credentials"] #cred-step');
  assert.match(await page.locator('[data-step="credentials"]').textContent(), new RegExp(`${base}/auth/dingtalk/callback`));
  await page.locator("#app-id").fill("ding-client-id");
  await page.locator("#app-secret").fill("ding-client-secret");
  await page.locator("#cred-step button[type='submit']").click();

  // Step 5: The review lists what was decided and does not submit. Confirm is what opens the code.
  await page.waitForSelector('[data-step="review"] #confirm');
  assert.equal(await page.locator("#code").count(), 0);
  assert.equal(await page.locator("#op-unlock").count(), 0);
  await page.locator("#confirm").click();
  await page.waitForSelector('[data-step="signin"] #code');
  assert.equal(await page.locator("#op-unlock").count(), 0);

  // Step 6: Enter the one-use code and sign in with DingTalk -> mocked OAuth -> the workspace, as Admin.
  await page.locator("#code").fill(bootstrapCode);
  await page.getByRole("button", { name: "Sign in with DingTalk" }).click();
  await page.waitForURL(url => url.origin === base && url.pathname === "/");

  // Confirm member session is established as Admin `dingtalk:ana-staff` (even without operator cookie!)
  const me = await page.evaluate(async () => (await fetch("/api/me")).json());
  assert.equal(me.identity, "dingtalk:ana-staff");
  assert.equal(me.role, "admin");
  assert.deepEqual(new Principals().list().map(p => [p.id, p.role]), [["dingtalk:ana-staff", "admin"]]);

  // Step 8: `/bootstrap` is now closed (404 already has an administrator)
  const closedRes = await page.goto(`${base}/bootstrap?lang=en`);
  assert.equal(closedRes.status(), 404);
  assert.match(await page.textContent("body"), /already has an administrator/);

  assert.deepEqual(pageErrors, [], `unexpected browser errors: ${pageErrors.join("; ")}`);
  console.log("[ui-bootstrap-e2e] ok: /bootstrap wizard -> review -> DingTalk OAuth -> Admin session");
} finally {
  await browser?.close();
  stop?.();
  resetConfigEnvForTests();
  for (const key of KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rmSync(home, { recursive: true, force: true });
}
