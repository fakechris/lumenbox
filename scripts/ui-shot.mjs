#!/usr/bin/env node
/**
 * Photograph the running web app, using the box's own browser.
 *
 * Written after the third UI change in a row shipped broken. Each had passed a test suite
 * that asserted the bytes of the page and each was wrong about what those bytes drew: a
 * chevron rendered as the literal text \25b8, a control labelled "hide 11 steps" that
 * hid nothing, a fold that only folded itself. None of them was a subtle failure — one
 * look would have caught any of them, and nobody looked, because looking meant a dozen
 * curl calls to the box daemon and a webp nothing on the host reads.
 *
 * So: one command. It also caught the thing that makes this worth having as a script
 * rather than a habit — the server was running a build from before the fix, so the source
 * was right, the tests passed, and the page on screen was still broken. A screenshot is
 * the only check that looks at what is actually being served.
 *
 *   node scripts/ui-shot.mjs                     the page as it loads
 *   node scripts/ui-shot.mjs --ref e5on9         hover that element first, then shoot
 *   node scripts/ui-shot.mjs --click e5on9       click it, then shoot
 *   node scripts/ui-shot.mjs --find "hide 11"    find the ref by its label, click, shoot
 *   node scripts/ui-shot.mjs --list              every ref on the page, to pick one
 *
 * Writes /tmp/ui-shot.png, and prints the path so it can be opened or read.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";

const args = process.argv.slice(2);
const flag = name => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : (args[at + 1] ?? "");
};

const token = process.env.AGENTBOX_TOKEN
  ?? readFileSync(`${homedir()}/.agentbox/token`, "utf8").trim();
const display = Number(flag("--display") ?? 1);
const out = flag("--out") ?? "/tmp/ui-shot.png";

/**
 * Where boxd is listening, asked of Docker rather than assumed.
 *
 * The published port changes every time the container is recreated, and a hardcoded one
 * fails as "connection refused", which reads like the box is down.
 */
function boxdPort() {
  if (process.env.AGENTBOX_BOXD_PORT) return process.env.AGENTBOX_BOXD_PORT;
  const mapping = execFileSync("docker", ["port", "agentbox-box"], { encoding: "utf8" });
  const port = mapping.match(/:(\d+)\s*$/m)?.[1];
  if (!port) throw new Error(`No published port on agentbox-box:\n${mapping}`);
  return port;
}

const base = `http://127.0.0.1:${boxdPort()}`;

async function box(path, body) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (result.error) throw new Error(`${path}: ${result.error}`);
  return result;
}

/**
 * The address the box uses for the host's web server.
 *
 * Not 127.0.0.1: inside the container that is the container. The page has to be fetched
 * from where the browser will fetch it, or the screenshot is of an error page.
 */
const url = flag("--url") ?? "http://host.docker.internal:7777/";

const opened = await box("/browser", { op: "open", display, url });
if (!/LumenBox/.test(opened.title ?? "")) {
  console.error(`Served page is titled ${JSON.stringify(opened.title)} — is the web server up?`);
}

/** Every clickable thing the page offers, as the accessibility tree names it. */
function refsIn(snapshot) {
  return (snapshot ?? "")
    .split("\n")
    .map(line => {
      const ref = line.match(/\[ref=(\w+)\]/)?.[1];
      const label = line.match(/"([^"]*)"/)?.[1];
      return ref ? { ref, label: label ?? "" } : undefined;
    })
    .filter(Boolean);
}

if (args.includes("--list")) {
  const snapshot = await box("/browser", { op: "snapshot", display });
  for (const { ref, label } of refsIn(snapshot.snapshot)) console.log(`${ref}\t${label}`);
  process.exit(0);
}

// Refs are recomputed on every snapshot, so one taken before a click is stale after it.
// Two clicks in a row against the same ref silently hit the wrong element, which cost an
// afternoon of believing a working toggle was broken.
const find = flag("--find");
let target = flag("--click") ?? flag("--ref");
let action = flag("--click") !== undefined ? "click" : "hover";
if (find !== undefined) {
  const snapshot = await box("/browser", { op: "snapshot", display });
  const hit = refsIn(snapshot.snapshot).find(entry => entry.label.includes(find));
  if (!hit) throw new Error(`Nothing on the page is labelled like ${JSON.stringify(find)}`);
  console.log(`${find} → ${hit.ref}  ${JSON.stringify(hit.label)}`);
  target = hit.ref;
  action = "click";
}
if (target) await box("/browser", { op: "act", display, action, ref: target });

const shot = await box("/computer", { display, actions: [{ action: "screenshot" }] });
const webp = out.replace(/\.png$/, ".webp");
writeFileSync(webp, Buffer.from(shot.screenshot, "base64"));
// The box screenshots as webp and nothing on a Mac reads one without help; sips ships with
// the OS, so the conversion costs nothing and the result opens anywhere.
try {
  execFileSync("sips", ["-s", "format", "png", webp, "--out", out], { stdio: "ignore" });
  console.log(out);
} catch {
  console.log(`${webp} (sips unavailable, left as webp)`);
}
