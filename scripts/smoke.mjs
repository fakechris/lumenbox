/**
 * End-to-end smoke test against a running box. No API credentials required.
 *
 * This covers the paths that unit tests cannot: everything that only breaks when
 * a real X server, a real ffmpeg, and a real container are involved. Those are
 * also the paths that fail silently, which is why they are worth re-checking
 * after any change to the box image or the daemon.
 *
 * Usage:  npm run smoke        (with the box already up)
 */

import { readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { BoxManager, defaultBoxConfig } from "../src/box/docker.ts";
import { DisplayLease } from "../src/box/display-lease.ts";
import { AgentRegistry } from "../src/agents/registry.ts";
import { AgentBus } from "../src/agents/bus.ts";
import { dispatchTool } from "../src/host/tools.ts";
import { patchWebpHeader } from "../src/cua/x11-executor.ts";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const OFF = "\x1b[0m";

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    const detail = await fn();
    passed++;
    console.log(`${GREEN}pass${OFF}  ${name}${detail ? `  ${DIM}${detail}${OFF}` : ""}`);
  } catch (error) {
    failed++;
    console.log(`${RED}FAIL${OFF}  ${name}`);
    console.log(`      ${RED}${error instanceof Error ? error.message : error}${OFF}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// --- connect ---------------------------------------------------------------

const token = process.env.AGENTBOX_TOKEN
  ?? readFileSync(`${homedir()}/.agentbox/token`, "utf8").trim();
const manager = new BoxManager(defaultBoxConfig({ token }));

let box;
try {
  box = await manager.connect();
} catch (error) {
  console.error(`${RED}Cannot reach the box:${OFF} ${error.message}`);
  console.error("Start it with:  node dist/cli.js box up");
  process.exit(1);
}

console.log(`${DIM}smoke test against ${(await manager.status()).boxdUrl}${OFF}\n`);

// --- box and display -------------------------------------------------------

let resolution;

await check("daemon reports a detected display", async () => {
  const health = await box.health();
  assert(health.ok, "health is not ok");
  assert(health.resolution, "no display detected — X may not be up");
  resolution = health.resolution;
  return `${resolution.display.width}x${resolution.display.height} -> api ${resolution.api.width}x${resolution.api.height}`;
});

await check("daemon runs unprivileged", async () => {
  const who = await box.exec("id -un");
  assert(who.stdout.trim() === "box", `running as ${who.stdout.trim()}, expected box`);
  return "uid box";
});

await check("the CUA toolchain is present", async () => {
  const result = await box.exec(
    "for t in xdotool ffmpeg xrandr xmodmap xdpyinfo box-chrome; do command -v $t >/dev/null || echo MISSING:$t; done"
  );
  assert(result.stdout.trim() === "", result.stdout.trim());
  return "xdotool ffmpeg xrandr xmodmap xdpyinfo box-chrome";
});

await check("CJK text has a font to render with", async () => {
  // Without one, Chinese, Japanese and Korean render as tofu boxes — and it fails
  // silently for an agent: the page loads, the screenshot succeeds, and the model
  // reads a grid of empty rectangles, then acts on a page it cannot see.
  const result = await box.exec(
    'fc-match "sans-serif:lang=zh-cn"; fc-list :lang=ja | wc -l'
  );
  const [matched = "", japanese = "0"] = result.stdout.trim().split("\n");
  assert(/CJK|Noto|WenQuanYi/i.test(matched), `no CJK font, fc-match said: ${matched}`);
  assert(Number(japanese.trim()) > 0, "no font covers Japanese");
  return matched.split(":")[0] ?? "a CJK font";
});

await check("each desktop gets its own browser profile", async () => {
  // One shared profile is how an agent's browser window ends up on another agent's
  // screen: Chromium permits a single instance per profile directory, so the second
  // agent's launch is answered by the first agent's process. The wrapper keys the
  // profile to DISPLAY; this checks two desktops really do get two directories.
  const probe =
    "rm -rf /home/box/.config/box-chrome-8 /home/box/.config/box-chrome-9; " +
    "DISPLAY=:8 box-chrome --version >/dev/null 2>&1; " +
    "DISPLAY=:9 box-chrome --version >/dev/null 2>&1; " +
    "ls -d /home/box/.config/box-chrome-8 /home/box/.config/box-chrome-9 2>&1; " +
    "rm -rf /home/box/.config/box-chrome-8 /home/box/.config/box-chrome-9";
  const result = await box.exec(probe);
  assert(result.stdout.includes("box-chrome-8"), `no profile for :8 — ${result.stdout}`);
  assert(result.stdout.includes("box-chrome-9"), `no profile for :9 — ${result.stdout}`);
  return "one profile per display";
});

await check("the GTK file chooser fits the screen", async () => {
  // Left unset, GTK3 opens the chooser at about 1124x822 on an 800px-high screen, so
  // Open and Cancel sit below the bottom edge: computer-use cannot click them and the
  // agent reports that nothing happened. GTK3 ignores max-height on a toplevel, so
  // this dconf value is the only lever there is.
  const result = await box.exec("dconf read /org/gtk/settings/file-chooser/window-size");
  assert(
    result.stdout.trim() === "(1100, 680)",
    `chooser size is ${result.stdout.trim() || "unset"}`
  );
  return "1100x680, inside 1280x800";
});

await check("X advertises the extensions apps look for", async () => {
  const result = await box.exec("xdpyinfo -display :1 | grep -cE '^    (GLX|RENDER|RANDR)$'");
  assert(result.stdout.trim() === "3", `found ${result.stdout.trim()} of GLX/RENDER/RANDR`);
  return "GLX, RENDER, RANDR";
});

await check("a human-usable terminal and file manager are installed", async () => {
  const result = await box.exec(
    "for t in xfce4-terminal thunar; do command -v $t >/dev/null || echo MISSING:$t; done; " +
      "test -s /usr/share/backgrounds/agentbox.png || echo MISSING:wallpaper"
  );
  assert(result.stdout.trim() === "", result.stdout.trim());
  return "xfce4-terminal, thunar, wallpaper";
});

await check("boxd repairs a desktop component that died", async () => {
  // Invisible from the agent's side: x11vnc dying leaves X and the agent working while
  // the user's screen goes dead for good. Killed by port owner rather than by pattern —
  // a pkill -f whose pattern appears in the killing command's own cmdline kills its own
  // shell first, which is how this test silently measured nothing on the first attempt.
  const before = await box.exec("pgrep -cx x11vnc");
  assert(Number(before.stdout.trim()) > 0, "x11vnc was not running to begin with");

  await box.exec("fuser -k -n tcp 5901 2>/dev/null; sleep 1; true");
  const dead = await box.exec("(fuser -n tcp 5901 2>/dev/null && echo up) || echo down");
  assert(dead.stdout.includes("down"), "x11vnc survived the kill; nothing is being measured");

  // Wait for boxd's own supervision tick, rather than calling the repair path here:
  // the timer firing is the thing that was added.
  let restored = false;
  for (let attempt = 0; attempt < 15; attempt++) {
    const check = await box.exec("(fuser -n tcp 5901 2>/dev/null && echo up) || echo down");
    if (check.stdout.includes("up")) {
      restored = true;
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  assert(restored, "boxd did not restart x11vnc within 45s");
  return "x11vnc restarted by the supervisor";
});

await check("desktop launchers launch instead of prompting", async () => {
  // Without libfm's quick_exec, activating a launcher opens an "Execute File"
  // dialog rather than starting anything. It fails quietly: the icons still draw,
  // so the desktop looks right until someone — or an agent — clicks one.
  const result = await box.exec(
    "grep -q '^quick_exec=1' /home/box/.config/libfm/libfm.conf || echo MISSING:quick_exec; " +
      "for f in /home/box/Desktop/*.desktop; do [ -x \"$f\" ] || echo NOT-EXECUTABLE:$f; done"
  );
  assert(result.stdout.trim() === "", result.stdout.trim());
  const names = await box.exec("ls /home/box/Desktop | tr '\\n' ' '");
  return `quick_exec, +x: ${names.stdout.trim()}`;
});

// --- screenshots -----------------------------------------------------------

await check("screenshot decodes as a valid WebP", async () => {
  const result = await box.computer([{ action: "screenshot" }]);
  assert(result.screenshot, "no screenshot returned");
  const buffer = Buffer.from(result.screenshot, "base64");

  assert(buffer.subarray(0, 4).toString() === "RIFF", "not a RIFF container");
  assert(buffer.subarray(8, 12).toString() === "WEBP", "not WebP");
  // The sizes ffmpeg leaves at zero must have been patched, or every decoder
  // rejects the file even though the pixels are fine.
  assert(
    buffer.readUInt32LE(4) === buffer.length - 8,
    `RIFF size is ${buffer.readUInt32LE(4)}, expected ${buffer.length - 8} — header not patched`
  );
  assert(
    buffer.readUInt32LE(16) === buffer.length - 20,
    "VP8 chunk size not patched"
  );
  return `${buffer.length} bytes, sizes patched`;
});

await check("header patch leaves a non-VP8 layout alone", async () => {
  const other = Buffer.alloc(40);
  other.write("RIFF", 0);
  other.write("WEBP", 8);
  other.write("VP8L", 12);
  patchWebpHeader(other);
  assert(other.readUInt32LE(4) === 0, "an unrecognized layout was rewritten");
  return "VP8L untouched";
});

// --- coordinate scaling ----------------------------------------------------

await check("coordinates round-trip through the real X server", async () => {
  const target = [640, 400];
  const result = await box.computer([
    { action: "mouse_move", coordinate: target },
    { action: "cursor_position" },
  ]);

  assert(result.cursor_position, "no cursor position returned");
  assert(
    result.cursor_position.x === target[0] && result.cursor_position.y === target[1],
    `reported (${result.cursor_position.x},${result.cursor_position.y}), sent (${target})`
  );

  // Ground truth from X, in display space rather than model space.
  const shell = await box.exec("DISPLAY=:1 xdotool getmouselocation --shell");
  const x = Number(/X=(\d+)/.exec(shell.stdout)?.[1]);
  const y = Number(/Y=(\d+)/.exec(shell.stdout)?.[1]);

  const expectedX = Math.round(target[0] * (resolution.display.width / resolution.api.width));
  const expectedY = Math.round(target[1] * (resolution.display.height / resolution.api.height));
  assert(
    x === expectedX && y === expectedY,
    `X server has (${x},${y}), scaling predicted (${expectedX},${expectedY})`
  );

  return `api (${target}) -> display (${x},${y}) -> api (${result.cursor_position.x},${result.cursor_position.y})`;
});

// --- failure behaviour -----------------------------------------------------

await check("a failed action still returns a screenshot", async () => {
  const result = await box.computer([{ action: "drag", path: [[10, 10]] }]);
  assert(result.success === false, "a one-point drag should fail");
  assert(result.error, "no error message");
  assert(result.screenshot, "no screenshot — the model would be blind on failure");
  return `${Buffer.from(result.screenshot, "base64").length} bytes with the error`;
});

await check("an unsafe key name is refused", async () => {
  const result = await box.computer([{ action: "key", key: "a mousemove 5 5" }]);
  assert(result.success === false, "an injected xdotool subcommand was accepted");
  assert(/not a keysym/.test(result.error), `unexpected error: ${result.error}`);
  return "keysym validation holds";
});

await check("a valid chord is accepted", async () => {
  const result = await box.computer([{ action: "key", key: "ctrl+shift+F5" }]);
  assert(result.success !== false, `rejected a legitimate chord: ${result.error}`);
  return "ctrl+shift+F5";
});

// --- shell -----------------------------------------------------------------

await check("shell state persists within a session", async () => {
  const session = "smoke-a";
  await box.exec("cd /tmp && export SMOKE=yes", { session });
  const result = await box.exec('pwd; echo "[$SMOKE]"', { session });
  assert(/\/tmp/.test(result.stdout), `cd did not persist: ${result.stdout.trim()}`);
  assert(/\[yes\]/.test(result.stdout), `export did not persist: ${result.stdout.trim()}`);
  return "cd and export survive";
});

await check("shell sessions are isolated between agents", async () => {
  const result = await box.exec('pwd; echo "[$SMOKE]"', { session: "smoke-b" });
  assert(!/fromA|\[yes\]/.test(result.stdout), "one agent saw another's environment");
  assert(!/^\/tmp$/m.test(result.stdout.split("\n")[0]), "inherited another's cwd");
  return "no leakage";
});

await check("a non-zero exit is reported, not thrown", async () => {
  const result = await box.exec("echo out; echo err >&2; exit 7");
  assert(result.exit_code === 7, `exit code was ${result.exit_code}`);
  assert(/out/.test(result.stdout) && /err/.test(result.stderr), "streams not captured");
  return "exit 7 with both streams";
});

await check("a hanging command is killed", async () => {
  const result = await box.exec("sleep 30", { timeoutMs: 1500 });
  assert(result.timed_out === true, "did not report a timeout");
  return "killed and reported";
});

// --- filesystem ------------------------------------------------------------

await check("write, read, and list round-trip", async () => {
  const path = "/tmp/smoke-check.txt";
  const body = "line one\nline two\nline three\n";
  const written = await box.writeFile(path, body);
  assert(written.bytes_written === Buffer.byteLength(body), "wrong byte count");

  const read = await box.readFile(path);
  assert(read.content.startsWith("line one"), "content mismatch");

  const ranged = await box.readFile(path, { startLine: 2, endLine: 2 });
  assert(ranged.content.trim() === "line two", `range read gave: ${ranged.content}`);

  const listing = await box.listDir("/tmp");
  assert(
    listing.entries.some(entry => entry.name === "smoke-check.txt"),
    "written file not listed"
  );
  await box.exec(`rm -f ${path}`);
  return "write, read, ranged read, list";
});

// --- display lease ---------------------------------------------------------

await check("a second agent is refused the display", async () => {
  const registry = new AgentRegistry();
  const bus = new AgentBus(registry, async () => {});
  const display = new DisplayLease();

  const first = registry.create({ name: "SmokeHolder" });
  const second = registry.create({ name: "SmokeWaiter" });

  try {
    const holder = await dispatchTool(
      "computer",
      { actions: [{ action: "screenshot" }] },
      { agent: first, registry, bus, box, display }
    );
    assert(!holder.isError, `holder was refused: ${holder.text}`);
    assert(holder.images?.length === 1, "holder got no screenshot");

    const refused = await dispatchTool(
      "computer",
      { actions: [{ action: "screenshot" }] },
      { agent: second, registry, bus, box, display }
    );
    assert(refused.isError === true, "a second agent was allowed onto the display");
    assert(!refused.images, "the refused agent still received an image");
    assert(/SmokeHolder/.test(refused.text), "refusal does not name the holder");

    display.release(first.id);
    const afterRelease = await dispatchTool(
      "computer",
      { actions: [{ action: "screenshot" }] },
      { agent: second, registry, bus, box, display }
    );
    assert(!afterRelease.isError, "display not handed over after release");
    return "holder served, second refused, handover works";
  } finally {
    for (const agent of [first, second]) {
      rmSync(registry.dirFor(agent.id), { recursive: true, force: true });
    }
  }
});

// --- typing ----------------------------------------------------------------

await check("unicode typing reaches an application", async () => {
  const probe = await box.exec("command -v xterm || true");
  if (!probe.stdout.trim()) {
    // Without a text sink, verify the keymap machinery instead of skipping.
    const before = await box.exec(
      'DISPLAY=:1 xmodmap -pke | grep -cE "^keycode +[0-9]+ *= *$"'
    );
    const typed = await box.computer([{ action: "type", text: "Aprenderás café" }]);
    assert(typed.success !== false, `typing failed: ${typed.error}`);
    const after = await box.exec(
      'DISPLAY=:1 xmodmap -pke | grep -cE "^keycode +[0-9]+ *= *$"'
    );
    assert(
      before.stdout.trim() === after.stdout.trim(),
      `borrowed keycodes leaked: ${before.stdout.trim()} -> ${after.stdout.trim()}`
    );
    return `keymap restored (${after.stdout.trim()} spare); install xterm for a full check`;
  }

  const text = "Aprenderás café 日本語 ÁÉÍ";
  await box.exec(
    "rm -f /tmp/smoke-typed.txt; " +
      'DISPLAY=:1 setsid xterm -e sh -c "cat > /tmp/smoke-typed.txt" >/dev/null 2>&1 & ' +
      "sleep 3; DISPLAY=:1 xdotool search --class xterm windowactivate --sync windowfocus",
    { timeoutMs: 30_000 }
  );
  await box.computer([{ action: "type", text: `${text}\n` }]);
  await box.exec("sleep 1; DISPLAY=:1 xdotool key ctrl+d; sleep 1");

  const got = await box.readFile("/tmp/smoke-typed.txt");
  assert(
    got.content.includes(text),
    `application received ${JSON.stringify(got.content)}, expected ${JSON.stringify(text)}`
  );
  await box.exec("pkill xterm 2>/dev/null; rm -f /tmp/smoke-typed.txt");
  return "accented and CJK text arrived byte-perfect";
});

// --- summary ---------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
