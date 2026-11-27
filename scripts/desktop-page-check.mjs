/**
 * The desktop page under the browser rules, in a real browser, against a real box (INV-2204).
 *
 * Every response carries a content security policy, `nosniff` and a referrer policy, and every
 * socket upgrade is checked for where it came from (src/web/browser-guard.ts). The page those
 * rules are most likely to break is the one this repository does not write: noVNC's, served by
 * the box and proxied under `/desktop/`. A unit test cannot see that; a browser can. So: a
 * disposable box and a temporary home (the same ones `npm run smoke` uses — nothing of the
 * installation is read or touched), the web server in front of it, and headless Chrome loading
 * the desktop the three ways a person meets it — the page itself, the page in a viewer's session,
 * and embedded in the app's page as an iframe — and a card drawn by the A2UI
 * bundle, the other script here that is somebody else's.
 *
 * What fails it: a policy violation in the console, an asset refused for its content type, a
 * socket that does not open, or a socket no frame arrives on.
 *
 * Twice: at local, where the session opens the desktop and nothing is asked of the page; and at
 * private, behind a TLS terminator of this run's own, where the socket needs a ticket — refused
 * without one, opened with the one the page was given, refused when it is used again — and where a
 * stream that ends under the page leaves a notice and a way back, not a frozen picture. The
 * record (desktop-sessions.jsonl in the temporary home) says which stream each person was joined to.
 *
 *   npm run check:desktop-page            creates and removes lumenbox-eval-desktop-page-<id>
 *   UI_LAYOUT_BROWSER=/path/to/chrome     the browser to use (default: Playwright's, else Chrome)
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer as createTlsServer, request as httpsRequest } from "node:https";
import { connect } from "node:net";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { defaultBoxImage } from "../src/box/docker.ts";
import { openEvalBox } from "./lib/eval-box.mjs";
import { smokeHome } from "./smoke-target.mjs";

const TOKEN = "desktop-page-check";
const DESKTOP = "/desktop/1/vnc.html?autoconnect=1&resize=scale&path=desktop/1/websockify";
const PRIVATE_HOST = "box.example.test";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

for (const key of ["AGENTBOX_UI_TOKEN", "AGENTBOX_PUBLIC_URL", "AGENTBOX_EXPOSURE", "AGENTBOX_INSECURE", "AGENTBOX_BOXD_URL", "AGENTBOX_TOKEN", "AGENTBOX_CONTAINER"]) delete process.env[key];
process.env.AGENTBOX_SCHEDULER = "0";
process.env.AGENTBOX_IMAGE ??= defaultBoxImage();
const scratch = smokeHome(process.env);
process.once("exit", scratch.close);

let failed = 0;
const say = (ok, what, detail = "") => { if (!ok) failed += 1; console.log(`${ok ? "pass" : "FAIL"}  ${what}${detail ? `  (${detail})` : ""}`); };

/** Loads `url` in a fresh page of `context` and reports what a person's browser would have met. */
async function visit(context, base, url, label, { frame = false, keep = false } = {}) {
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
  say(live !== undefined, `${label}: the socket opens and frames arrive`, live ? `${new URL(live.url).pathname}: ${live.frames} frame(s), ${live.bytes} bytes` : `sockets: ${JSON.stringify(sockets.map(socket => ({ ...socket, url: socket.url.replace(/ticket=.*/, "ticket=…") })))}`);
  say(canvas !== null && canvas !== undefined && canvas.width > 0, `${label}: the screen is drawn`, canvas ? `canvas ${canvas.width}x${canvas.height}` : "no canvas");
  const final = page.url();
  if (!keep) await page.close();
  return { assets, sockets, final, page };
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

/** A socket upgrade asked for by hand, with a session's cookie: the status line and the refusal's word. */
function upgradeBy(base, path, cookie, origin) {
  return new Promise(resolve => {
    const { port, hostname } = new URL(base);
    const socket = connect(Number(port), hostname, () => socket.write(
      `GET ${path} HTTP/1.1\r\nhost: ${hostname}:${port}\r\nconnection: Upgrade\r\nupgrade: websocket\r\nsec-websocket-version: 13\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n` +
      `cookie: ${cookie}\r\n${origin ? `origin: ${origin}\r\n` : ""}\r\n`));
    let answer = "";
    socket.on("data", chunk => { answer += String(chunk); socket.destroy(); });
    socket.on("close", () => resolve(answer === "" ? "closed" : `${answer.split("\r\n")[0]} ${answer.split("\r\n\r\n")[1]?.trim() ?? ""}`.trim()));
    socket.on("error", () => resolve("closed"));
  });
}

/** What the record says of the streams, read from the temporary home. */
const sessions = () => {
  const path = join(scratch.home, "desktop-sessions.jsonl");
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
};
/** A person invited with the installation's credential, signed in through `through` — the address people use — and their cookie put in `context`. */
async function signedIn(context, direct, through, role, name) {
  const invite = await (await fetch(`${direct}/api/channels/invite`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ role }) })).json();
  const target = new URL(through), body = JSON.stringify({ code: invite.code, name });
  // By hand rather than by fetch: the private run's name resolves only inside the browser, and its certificate is this run's own.
  const login = await new Promise((resolve, reject) => {
    const ask = target.protocol === "https:" ? httpsRequest : httpRequest;
    const request = ask({ host: "127.0.0.1", port: target.port, method: "POST", path: "/api/login", rejectUnauthorized: false, headers: { host: target.host, "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, answer => {
      answer.resume();
      answer.on("end", () => resolve({ status: answer.statusCode, cookies: answer.headers["set-cookie"] ?? [] }));
    });
    request.on("error", reject);
    request.end(body);
  });
  const session = login.cookies.map(line => line.split(";")[0]).find(pair => pair.startsWith("agentbox_who=")) ?? "";
  say(login.status === 200 && session !== "", `${name} signs in as a ${role}`, `HTTP ${login.status}`);
  await context.addCookies([{ name: "agentbox_who", value: session.slice("agentbox_who=".length), url: through, httpOnly: true, secure: target.protocol === "https:" }]);
  return session;
}

/**
 * A TLS terminator in front of the server, as a private installation has: https on a name of its
 * own, the client's address appended to X-Forwarded-For. Self-signed, for this run only.
 */
async function terminator(target) {
  const key = join(scratch.home, "tls.key"), cert = join(scratch.home, "tls.crt");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", `/CN=${PRIVATE_HOST}`, "-addext", `subjectAltName=DNS:${PRIVATE_HOST}`], { stdio: "ignore" });
  const forwarded = req => ({ ...req.headers, "x-forwarded-for": [req.headers["x-forwarded-for"], req.socket.remoteAddress?.replace(/^::ffff:/, "")].filter(Boolean).join(", "), "x-forwarded-proto": "https" });
  const server = createTlsServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
    const upstream = httpRequest({ host: "127.0.0.1", port: target().port, method: req.method, path: req.url, headers: forwarded(req) }, answer => { res.writeHead(answer.statusCode ?? 502, answer.headers); answer.pipe(res); });
    upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(upstream);
  });
  server.on("upgrade", (req, socket, head) => {
    const upstream = connect(Number(target().port), "127.0.0.1", () => {
      upstream.write(`GET ${req.url} HTTP/1.1\r\n${Object.entries(forwarded(req)).map(([name, value]) => `${name}: ${value}\r\n`).join("")}\r\n`);
      if (head.length > 0) upstream.write(head);
      upstream.pipe(socket); socket.pipe(upstream);
    });
    const drop = () => { upstream.destroy(); socket.destroy(); };
    upstream.on("error", drop).on("close", drop); socket.on("error", drop).on("close", drop);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, close: () => { server.closeAllConnections(); server.close(); } };
}

let box, stop, browser, tls;
try {
  box = await openEvalBox({ argv: [], runId: `desktop-page-${Date.now().toString(36)}`, isolated: true });
  const { startWebServer } = await import("../src/web/server.ts");
  let base = "";
  stop = await startWebServer({ port: 0, host: "127.0.0.1", token: TOKEN, useBox: true, onLog: () => {}, onReady: url => { base = url; } });
  const executablePath = process.env.UI_LAYOUT_BROWSER ?? (existsSync(CHROME) ? CHROME : undefined);
  // The private run's name resolves to this machine, and its certificate is this run's own.
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}), args: [`--host-resolver-rules=MAP ${PRIVATE_HOST} 127.0.0.1`, "--ignore-certificate-errors", "--no-proxy-server"] });

  // ── local: as the app and a browser on this machine have it ─────────────────────────────────
  console.log("\nlocal\n");
  // The operator, as the app loads it: the token once in the address, a cookie from then on.
  const operator = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const first = await operator.newPage();
  await first.goto(`${base}/?token=${TOKEN}`, { waitUntil: "load" });
  await first.close();
  await cards(operator, base);
  const driving = await visit(operator, base, DESKTOP, "the desktop page");
  const ours = new URL(base);
  const own = socket => { const url = new URL(socket.url); return url.protocol === "ws:" && url.host === ours.host && url.pathname.endsWith("/desktop/1/websockify"); };
  say(driving.sockets.length > 0 && driving.sockets.every(own), "the desktop page: its socket is this installation's own address", driving.sockets.map(socket => socket.url.split("?")[0]).join(", "));
  say(driving.final === base + DESKTOP && driving.sockets.every(socket => !socket.url.includes("ticket")), "the desktop page: opened where it was asked for, with no ticket — the session suffices at local", driving.final.replace(base, ""));
  await visit(operator, base, DESKTOP, "embedded in the app's page", { frame: true });

  // A viewer: the same address, and the view-only stream — which the record says, since a browser cannot (INV-2228).
  const viewer = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await signedIn(viewer, base, base, "viewer", "Viewer");
  await visit(viewer, base, DESKTOP, "the desktop page in a viewer's session");
  const localRecord = sessions();
  say(localRecord.some(line => line.event === "opened" && line.person === "operator" && line.mode === "control" && line.by === "session"), "the record: the operator's stream, driving, by session");
  say(localRecord.filter(line => line.event === "opened" && line.person !== "operator").every(line => line.mode === "view") && localRecord.some(line => line.person !== "operator"), "the record: the viewer was joined to the view-only stream");

  // And the check that makes the rest mean something: another site's page cannot open the socket.
  const foreign = await upgradeBy(base, "/desktop/1/websockify", `agentbox_ui=${TOKEN}`, "https://evil.example");
  say(foreign === "HTTP/1.1 403 Forbidden", "another site's page cannot open the desktop's socket", foreign);

  // ── private: the same installation behind a TLS terminator, on a name of its own ─────────────
  console.log("\nprivate\n");
  stop(); stop = undefined;
  let direct = "";
  tls = await terminator(() => new URL(direct));
  const through = `https://${PRIVATE_HOST}:${tls.port}`;
  Object.assign(process.env, { AGENTBOX_EXPOSURE: "private", AGENTBOX_PUBLIC_URL: through });
  stop = await startWebServer({ port: 0, host: "127.0.0.1", token: TOKEN, useBox: true, onLog: () => {}, onReady: url => { direct = url; } });
  const before = sessions().length;

  const driver = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const driverCookie = await signedIn(driver, direct, through, "driver", "Driver");
  say((await upgradeBy(direct, "/desktop/1/websockify", driverCookie)) === "HTTP/1.1 403 Forbidden ticket-missing", "private: the socket without a ticket is refused");
  const ticketed = await visit(driver, through, DESKTOP, "private: the desktop page", { keep: true });
  const socketUrl = ticketed.sockets.find(socket => socket.frames >= 3)?.url ?? "";
  say(/\/desktop\/1\/websockify\?ticket=[A-Za-z0-9_-]{32}$/.test(socketUrl) && socketUrl.startsWith(`wss://${PRIVATE_HOST}:${tls.port}/`), "private: the page was given a ticket, and its socket carries it", socketUrl.replace(/ticket=.*/, "ticket=…"));
  const again = await upgradeBy(direct, new URL(socketUrl.replace(/^wss/, "https")).pathname + new URL(socketUrl.replace(/^wss/, "https")).search, driverCookie);
  say(again === "HTTP/1.1 403 Forbidden ticket-used", "private: the same ticket a second time is refused", again);

  // The desktop's stream ends under the page — its VNC server in the box is killed, and the box brings it back — and the page says so, with a way back.
  const { resolveBoxProvisioner } = await import("../src/box/provisioner.ts");
  const inBox = await resolveBoxProvisioner().connect();
  await inBox.exec("pkill -x x11vnc || true");
  const page = ticketed.page;
  const notice = await page.waitForSelector("#lumenbox-desktop-closed", { timeout: 30_000 }).then(() => true, () => false);
  say(notice, "private: when the stream ends the page says so, over the last picture", notice ? ((await page.locator("#lumenbox-desktop-closed p").textContent()) ?? "").slice(0, 80) : "no notice appeared: the canvas is frozen with nothing said");
  if (notice) {
    const reopened = [];
    page.on("websocket", socket => { const entry = { url: socket.url(), frames: 0 }; reopened.push(entry); socket.on("framereceived", () => { entry.frames += 1; }); });
    await page.locator("#lumenbox-desktop-closed button").click();
    // While the box is still bringing the desktop back, a person meets either the "could not open" page
    // or the notice again, and tries again: so does this, every few seconds, the way they would.
    const deadline = Date.now() + 120_000;
    for (let waited = 500; Date.now() < deadline && !reopened.some(socket => socket.frames >= 3); waited += 500) {
      await page.waitForTimeout(500);
      if (waited % 5_000 !== 0) continue;
      const again = page.locator("#lumenbox-desktop-closed button");
      if (await again.count() > 0) await again.click().catch(() => {});
      else if (!(await page.title()).includes("noVNC")) await page.reload({ waitUntil: "load" }).catch(() => {});
    }
    const back = reopened.find(socket => socket.frames >= 3);
    say(back !== undefined && back.url !== socketUrl, "private: Reopen gets a new ticket and the picture is live again", back ? `${back.frames} frame(s) on a new ticket` : `sockets after reopening: ${JSON.stringify(reopened.map(socket => [socket.url.replace(/ticket=.*/, "ticket=…"), socket.frames]))}; the page is at ${page.url().replace(/ticket.*/, "ticket…")} titled "${await page.title()}" saying "${(await page.evaluate(() => document.body.textContent)).slice(0, 120)}"`);
  }
  await page.close();

  const watcher = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await signedIn(watcher, direct, through, "viewer", "Watcher");
  await visit(watcher, through, DESKTOP, "private: the desktop page in a viewer's session");
  await new Promise(resolve => setTimeout(resolve, 500));
  const record = sessions().slice(before);
  const opened = record.filter(line => line.event === "opened");
  say(opened.length >= 3 && opened.every(line => line.by === "ticket"), "the record: every private stream was opened by ticket", `${opened.length} opened`);
  say(opened.some(line => line.mode === "control") && opened.some(line => line.mode === "view"), "the record: the driver's stream is control, the viewer's is view");
  say(record.some(line => line.event === "closed" && line.reason === "box-gone"), "the record: the stream that ended under the page says the box let go");
  say(!readFileSync(join(scratch.home, "desktop-sessions.jsonl"), "utf8").includes(socketUrl.split("ticket=")[1] || "no-ticket-seen"), "the record holds no ticket");
} catch (error) {
  failed += 1;
  console.log(`FAIL  could not run: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
} finally {
  await browser?.close().catch(() => {});
  stop?.();
  tls?.close();
  await box?.close();
}
console.log(failed === 0 ? "\nthe desktop page works under the browser rules, with a ticket where one is required" : `\n${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
