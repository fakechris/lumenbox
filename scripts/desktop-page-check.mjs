/**
 * The desktop page under the browser rules, in a real browser, against a real box (INV-2204).
 *
 * Every response carries a content security policy, `nosniff` and a referrer policy, and every
 * socket upgrade is checked for where it came from (src/web/browser-guard.ts). The page those
 * rules are most likely to break is the one this repository does not write: noVNC's, served by
 * the box and proxied under `/desktop/`. A unit test cannot see that; a browser can. So: a
 * disposable box and a temporary home (the same ones `npm run smoke` uses — nothing of the
 * installation is read or touched), the web server in front of it, and headless Chrome loading
 * the desktop the three ways a person meets it — the page itself, the page as a viewer (the
 * view-only stream), and embedded in the app's page as an iframe — and a card drawn by the A2UI
 * bundle, the other script here that is somebody else's.
 *
 * What fails it: a policy violation in the console, an asset refused for its content type, a
 * socket that does not open, or a socket no frame arrives on.
 *
 *   npm run check:desktop-page            creates and removes lumenbox-eval-desktop-page-<id>
 *   UI_LAYOUT_BROWSER=/path/to/chrome     the browser to use (default: Playwright's, else Chrome)
 */

import { existsSync } from "node:fs";
import { chromium } from "playwright-core";
import { defaultBoxImage } from "../src/box/docker.ts";
import { openEvalBox } from "./lib/eval-box.mjs";
import { smokeHome } from "./smoke-target.mjs";

const TOKEN = "desktop-page-check";
const DESKTOP = "/desktop/1/vnc.html?autoconnect=1&resize=scale&path=desktop/1/websockify";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

for (const key of ["AGENTBOX_UI_TOKEN", "AGENTBOX_PUBLIC_URL", "AGENTBOX_EXPOSURE", "AGENTBOX_INSECURE", "AGENTBOX_BOXD_URL", "AGENTBOX_TOKEN", "AGENTBOX_CONTAINER"]) delete process.env[key];
process.env.AGENTBOX_SCHEDULER = "0";
process.env.AGENTBOX_IMAGE ??= defaultBoxImage();
const scratch = smokeHome(process.env);
process.once("exit", scratch.close);

let failed = 0;
const say = (ok, what, detail = "") => { if (!ok) failed += 1; console.log(`${ok ? "pass" : "FAIL"}  ${what}${detail ? `  (${detail})` : ""}`); };

/** Loads `url` in a fresh page of `context` and reports what a person's browser would have met. */
async function visit(context, base, url, label, { frame = false } = {}) {
  const page = await context.newPage();
  const violations = [], refused = [], assets = [], sockets = [];
  page.on("console", message => {
    const text = message.text();
    if (/Content Security Policy|CSP-VIOLATION/i.test(text)) violations.push(text.slice(0, 240));
    else if (/Refused to|MIME type|nosniff/i.test(text)) refused.push(text.slice(0, 240));
  });
  page.on("response", response => {
    const path = new URL(response.url()).pathname;
    if (path.startsWith("/desktop/")) assets.push({ path, status: response.status(), type: response.headers()["content-type"] ?? "(none)", csp: response.headers()["content-security-policy"] !== undefined, nosniff: response.headers()["x-content-type-options"] });
  });
  page.on("websocket", socket => {
    const entry = { url: socket.url(), frames: 0, bytes: 0, closed: false, error: undefined };
    sockets.push(entry);
    socket.on("framereceived", data => { entry.frames += 1; entry.bytes += data.payload.length; });
    socket.on("close", () => { entry.closed = true; });
    socket.on("socketerror", error => { entry.error = String(error); });
  });
  await context.addInitScript(() => document.addEventListener("securitypolicyviolation", event => console.error(`CSP-VIOLATION ${event.violatedDirective} ${event.blockedURI}`)));
  if (frame) {
    await page.goto(`${base}/`, { waitUntil: "load" });
    await page.evaluate(src => { const frame = document.createElement("iframe"); frame.id = "desktop-check"; frame.src = src; frame.style.cssText = "position:fixed;inset:0;width:100%;height:100%;z-index:99999"; document.body.appendChild(frame); }, url);
  } else {
    await page.goto(base + url, { waitUntil: "load" });
  }
  // The waiting page reloads itself until the desktop answers; give the stream time to start.
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline && !sockets.some(socket => socket.frames >= 3)) await page.waitForTimeout(500);
  const target = frame ? page.frames().find(candidate => candidate.url().includes("/vnc.html")) : page.mainFrame();
  const canvas = target === undefined ? undefined : await target.evaluate(() => { const canvas = document.querySelector("canvas"); return canvas ? { width: canvas.width, height: canvas.height } : null; }).catch(() => undefined);
  const live = sockets.find(socket => socket.frames >= 3);
  const types = new Map();
  for (const asset of assets) types.set(asset.path.replace(/^.*(\.[a-z0-9]+)$/i, "$1"), asset.type);
  say(violations.length === 0, `${label}: no content-security-policy violation`, violations.join(" | "));
  say(refused.length === 0, `${label}: no asset refused for its type`, refused.join(" | "));
  const bad = assets.filter(asset => asset.status >= 400);
  say(assets.length > 0 && bad.length === 0, `${label}: the page's assets load`, `${assets.length} response(s) under /desktop/: ${[...types].map(([ext, type]) => `${ext} ${type}`).join(", ")}${bad.length ? `; failed: ${bad.map(asset => `${asset.status} ${asset.path}`).join(", ")}` : ""}`);
  say(assets.every(asset => asset.csp && asset.nosniff === "nosniff"), `${label}: every one of them carries the policy and nosniff`);
  say(live !== undefined, `${label}: the socket opens and frames arrive`, live ? `${live.url.replace(base.replace("http", "ws"), "")}: ${live.frames} frame(s), ${live.bytes} bytes` : `sockets: ${JSON.stringify(sockets)}`);
  say(canvas !== null && canvas !== undefined && canvas.width > 0, `${label}: the screen is drawn`, canvas ? `canvas ${canvas.width}x${canvas.height}` : "no canvas");
  await page.close();
  return { assets, sockets };
}

/**
 * A card an agent drew (ShowUI), in the app's page: the A2UI bundle is the other script this
 * repository does not write. Built by `npm run build:vendor`; without it there is nothing to load.
 */
async function cards(context, base) {
  const page = await context.newPage();
  const problems = [];
  page.on("console", message => { if (/Content Security Policy|CSP-VIOLATION|Refused to|EvalError|unsafe-eval/i.test(message.text())) problems.push(message.text().slice(0, 240)); });
  page.on("pageerror", error => problems.push(`pageerror: ${error.message.slice(0, 240)}`));
  await page.goto(`${base}/`, { waitUntil: "load" });
  const bundle = await page.evaluate(async () => (await fetch("/vendor/a2ui.js")).status);
  if (bundle !== 200) { say(false, "cards: the A2UI bundle is served", `HTTP ${bundle}: run \`npm run build:vendor\` first`); await page.close(); return; }
  const drawn = await page.evaluate(async () => {
    await new Promise((resolve, reject) => { const script = document.createElement("script"); script.src = "/vendor/a2ui.js"; script.onload = resolve; script.onerror = () => reject(new Error("the bundle did not load")); document.head.appendChild(script); });
    const A2UI = window.A2UI;
    const processor = new A2UI.MessageProcessor([A2UI.catalog], () => {}, { validationConfig: A2UI.validation });
    const surfaceId = "check";
    processor.processMessages([{ version: "v0.9", createSurface: { surfaceId, catalogId: "https://lumenbox.dev/a2ui/catalog.json" } }]);
    processor.processMessages([{ version: "v0.9", updateComponents: { surfaceId, components: [
      { id: "root", component: "Column", children: ["title", "prose", "chart", "go"] },
      { id: "title", component: "Text", text: "Which plan?", variant: "h3" },
      { id: "prose", component: "Markdown", text: "A **bold** claim and `code`." },
      { id: "chart", component: "Chart", kind: "bar", points: [{ label: "a", value: 3 }, { label: "b", value: 5 }] },
      { id: "go", component: "Button", child: "go-label", action: { event: { name: "pick" } } },
      { id: "go-label", component: "Text", text: "Plan A" },
    ] } }]);
    const element = document.createElement("a2ui-surface");
    element.surface = processor.getSurface(surfaceId);
    document.body.appendChild(element);
    await new Promise(resolve => setTimeout(resolve, 1500));
    // Everything it drew, through every shadow root: the text, and whether its styles applied.
    const text = [], seen = { svg: 0, styled: false };
    const walk = node => {
      if (node.nodeType === 3 && node.textContent.trim()) text.push(node.textContent.trim());
      if (node.nodeType === 1) {
        if (node.tagName.toLowerCase() === "svg") seen.svg += 1;
        if (node.tagName.toLowerCase() === "button" && getComputedStyle(node).cursor === "pointer") seen.styled = true;
        if (node.shadowRoot) walk(node.shadowRoot);
      }
      for (const child of node.childNodes ?? []) walk(child);
    };
    walk(element);
    return { text: text.join(" | "), ...seen };
  }).catch(error => ({ error: String(error) }));
  say(problems.length === 0, "cards: no content-security-policy violation and no script error", problems.join(" | "));
  say(drawn.error === undefined && /Which plan\?/.test(drawn.text ?? "") && /Plan A/.test(drawn.text ?? "") && /bold/.test(drawn.text ?? ""), "cards: a card is drawn, text, Markdown and button", drawn.error ?? drawn.text);
  say(drawn.svg > 0, "cards: its chart is drawn", `${drawn.svg} svg element(s)`);
  say(drawn.styled === true, "cards: its styles apply", "the button's cursor is the stylesheet's");
  await page.close();
}

let box, stop, browser;
try {
  box = await openEvalBox({ argv: [], runId: `desktop-page-${Date.now().toString(36)}`, isolated: true });
  const { startWebServer } = await import("../src/web/server.ts");
  let base = "";
  stop = await startWebServer({ port: 0, host: "127.0.0.1", token: TOKEN, useBox: true, onLog: () => {}, onReady: url => { base = url; } });
  const executablePath = process.env.UI_LAYOUT_BROWSER ?? (existsSync(CHROME) ? CHROME : undefined);
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });

  // The operator, as the app loads it: the token once in the address, a cookie from then on.
  const operator = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const first = await operator.newPage();
  await first.goto(`${base}/?token=${TOKEN}`, { waitUntil: "load" });
  await first.close();
  await cards(operator, base);
  const driving = await visit(operator, base, DESKTOP, "the desktop page");
  say(driving.sockets.some(socket => /\/desktop\/1\/websockify/.test(socket.url)), "the desktop page: its socket is this installation's own address");
  await visit(operator, base, DESKTOP, "embedded in the app's page", { frame: true });

  // A viewer: the same address, and the server picks the view-only stream (/vnc-ro/) from the role.
  const invite = await (await fetch(`${base}/api/channels/invite`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ role: "viewer" }) })).json();
  const login = await fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: invite.code, name: "Viewer" }) });
  const session = login.headers.getSetCookie()[0]?.split(";")[0] ?? "";
  say(login.status === 200 && session.startsWith("agentbox_who="), "a viewer signs in", `HTTP ${login.status}`);
  const viewer = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const [name, value] = [session.slice(0, session.indexOf("=")), session.slice(session.indexOf("=") + 1)];
  await viewer.addCookies([{ name, value, url: base }]);
  await visit(viewer, base, DESKTOP, "the view-only desktop (a viewer)");

  // And the check that makes the rest mean something: another site's page cannot open the socket.
  const foreign = await new Promise(resolve => {
    import("node:net").then(({ connect }) => {
      const { port, hostname } = new URL(base);
      const socket = connect(Number(port), hostname, () => socket.write(`GET /desktop/1/websockify HTTP/1.1\r\nhost: ${hostname}:${port}\r\nconnection: Upgrade\r\nupgrade: websocket\r\nsec-websocket-version: 13\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\ncookie: agentbox_ui=${TOKEN}\r\norigin: https://evil.example\r\n\r\n`));
      let answer = "";
      socket.on("data", chunk => { answer += String(chunk); socket.destroy(); });
      socket.on("close", () => resolve(answer.split("\r\n")[0] || "closed"));
      socket.on("error", () => resolve("closed"));
    });
  });
  say(foreign === "HTTP/1.1 403 Forbidden", "another site's page cannot open the desktop's socket", foreign);
} catch (error) {
  failed += 1;
  console.log(`FAIL  could not run: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
} finally {
  await browser?.close().catch(() => {});
  stop?.();
  await box?.close();
}
console.log(failed === 0 ? "\nthe desktop page works under the browser rules" : `\n${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
