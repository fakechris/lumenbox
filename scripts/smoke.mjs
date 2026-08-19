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
import { resolveBoxProvisioner } from "../src/box/provisioner.ts";
import { startEgressRelay } from "../src/egress/relay.ts";
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
// Through the provisioner, so this also covers the path a deployment uses: set
// AGENTBOX_BOXD_URL and the whole suite runs against a box nothing here started.
process.env.AGENTBOX_TOKEN ??= token;
const provisioner = resolveBoxProvisioner();

let box;
try {
  box = await provisioner.connect();
} catch (error) {
  console.error(`${RED}Cannot reach the box:${OFF} ${error.message}`);
  console.error("Start it with:  node dist/cli.js box up");
  process.exit(1);
}

console.log(`${DIM}smoke test against ${provisioner.label}${OFF}\n`);

// Desktops are bound to the agent that owns them, and the box refuses input without the
// matching token. This script runs on the host, where the tokens live, so it presents the
// same claim the UI would — otherwise every check that drives display 1 fails the moment
// an agent has been given it, which is exactly what happened the first time.
const smokeRegistry = new AgentRegistry();
const owner = (display = 1) => {
  try {
    return smokeRegistry.boxOwnerTokenForDisplay(display);
  } catch {
    return undefined;
  }
};

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

await check("the box's traffic can leave through a relay", async () => {
  // The point is which network the agent appears on: a box's own address is a datacentre one,
  // which sites block, geofence or serve differently, and nothing on the user's network is
  // reachable from it at all. Only meaningful when the box was started with a relay
  // configured, so this reports rather than fails when it was not.
  const configured = await box.exec("printenv AGENTBOX_EGRESS_RELAY || true");
  const relayAddress = configured.stdout.trim();
  if (!relayAddress) {
    return "not configured; start the box with AGENTBOX_EGRESS_RELAY to cover this";
  }

  const port = Number(relayAddress.split(":").pop());
  const marker = `egress-${Date.now()}`;
  // A server on this machine's loopback, which the box cannot reach by any other route: if it
  // arrives, the connection was opened from here.
  const { createServer } = await import("node:http");
  const origin = createServer((_req, res) => res.end(marker));
  await new Promise(resolve => origin.listen(0, "127.0.0.1", resolve));
  const originPort = origin.address().port;

  const relay = startEgressRelay({
    token: process.env.AGENTBOX_TOKEN ?? token,
    port,
    host: "0.0.0.0",
    allow: [`127.0.0.1:${originPort}`],
  });
  await new Promise(resolve => setTimeout(resolve, 500));

  try {
    const direct = await box.exec(
      `curl -s --max-time 4 http://127.0.0.1:${originPort}/ || true`
    );
    assert(
      !direct.stdout.includes(marker),
      "the box reached this machine's loopback directly, so the test proves nothing"
    );

    const through = await box.exec(
      `curl -s --max-time 10 -x http://127.0.0.1:8791 http://127.0.0.1:${originPort}/ || true`
    );
    assert(through.stdout.includes(marker), `through the proxy: ${JSON.stringify(through.stdout)}`);

    // And the allow list is not decoration.
    const refused = await box.exec(
      "curl -s -o /dev/null -w '%{http_code}' --max-time 10 -x http://127.0.0.1:8791 http://example.com/ || true"
    );
    assert(refused.stdout.trim() !== "200", `a target outside the allow list returned ${refused.stdout}`);
    return "reached this machine's network, and only what was allowed";
  } finally {
    relay.close();
    origin.close();
  }
});

await check("the agent's work runs behind the desktop", async () => {
  // One box, two workloads with different needs: the desktop, whose latency a person feels
  // directly as "computer use is slow", and whatever the agent runs, which is throughput.
  // Measured on twelve cores with the agent saturating them, screenshot latency went 185ms
  // idle, 489ms loaded, 189ms loaded with this in place.
  const agent = await box.exec("ps -o ni= -p $$ | tr -d ' '");
  assert(Number(agent.stdout.trim()) > 0, `the agent's shell runs at nice ${agent.stdout}`);

  // And the things the user looks through are not behind it.
  const interactive = await box.exec(
    "for p in Xvfb x11vnc websockify; do ps -o ni= -p $(pgrep -x $p | head -1) | tr -d ' '; done"
  );
  const values = interactive.stdout.trim().split("\n").map(Number);
  assert(values.length === 3, interactive.stdout);
  for (const value of values) {
    assert(value <= 0, `an interactive process runs at nice ${value}`);
  }
  return `agent nice ${agent.stdout.trim()}, desktop nice ${values.join("/")}`;
});

await check("the health check covers what the topology promises", async () => {
  // The defect this closes: the check asked boxd only, so with the orchestrator inside the box —
  // where it is the product, since the only thing outside is a browser — it could be crash-looping
  // while the container reported healthy and the restart policy stayed quiet. Both directions are
  // asserted, because a check that cannot fail is the thing being fixed.
  const healthy = await box.exec("/usr/local/bin/box-healthcheck");
  assert(healthy.exit_code === 0, `a healthy box failed its check: ${healthy.stdout}${healthy.stderr}`);

  const deadUi = await box.exec(
    "AGENTBOX_HOST_ENABLED=1 AGENTBOX_UI_PORT=7999 /usr/local/bin/box-healthcheck"
  );
  assert(deadUi.exit_code !== 0, "a missing orchestrator UI reported healthy");
  assert(/UI answered/.test(deadUi.stdout), deadUi.stdout);
  return "boxd and, when enabled, the orchestrator";
});

await check("work that must survive has somewhere to go", async () => {
  // Only /home/box/work and .config are volumes, and a report written to the home directory
  // disappears on the next rebuild with nothing to say so. The prompt tells the agent; this
  // checks the box can notice afterwards.
  await box.exec("rm -f /home/box/smoke-stray.md");
  const clean = await box.exec("box-doctor 2>&1 | grep work-location || true");
  assert(/PASS work-location/.test(clean.stdout), clean.stdout);

  await box.exec("echo stray > /home/box/smoke-stray.md");
  const warned = await box.exec("box-doctor 2>&1 | grep work-location || true");
  assert(/WARN work-location/.test(warned.stdout), warned.stdout);
  assert(/smoke-stray/.test(warned.stdout), warned.stdout);

  await box.exec("rm -f /home/box/smoke-stray.md");
  return "loose files in the home directory are reported";
});

await check("the box can diagnose itself", async () => {
  // The point is that an agent can run this over its own shell when its computer misbehaves,
  // instead of working around a symptom. Both directions are asserted: a healthy box passes,
  // and a broken one fails with a non-zero exit — otherwise this could silently become a
  // script that always says everything is fine.
  const healthy = await box.exec("box-doctor");
  assert(healthy.exit_code === 0, `a healthy box failed its own check:\n${healthy.stdout}`);
  assert(/SUMMARY \d+ passed, 0 failed/.test(healthy.stdout), healthy.stdout);

  // Broken and checked in one command, because the supervisor repairs things within a tick.
  const broken = await box.exec(
    "dbus-run-session -- dconf reset /org/gtk/settings/file-chooser/window-size; box-doctor"
  );
  assert(broken.exit_code !== 0, "a broken box reported success");
  assert(/FAIL file-chooser/.test(broken.stdout), broken.stdout);

  const checks = (healthy.stdout.match(/^\[box-doctor\] (PASS|WARN|FAIL)/gm) ?? []).length;
  return `${checks} checks, passes clean and fails dirty`;
});

await check("an unsupervised process that dies is seen", async () => {
  // Only PID 1 sees an orphan die, and tini reaped every one and discarded the status — so a
  // browser the agent abandoned, or a binary it installed and ran crash-looping, left no
  // trace. The orphan has to outlive its parent to be one: killed inside the same command,
  // the shell reaps it and PID 1 never hears about it, which is how the first version of
  // this test measured nothing.
  await box.exec(
    "setsid sh -c 'sleep 3; kill -ABRT $$' >/dev/null 2>&1 </dev/null &",
    { timeoutMs: 15_000 }
  );
  await new Promise(resolve => setTimeout(resolve, 8000));

  const health = await box.health();
  const abort = (health.crashes ?? []).find(entry => /SIGABRT/.test(entry.detail));
  assert(abort, `no crash recorded: ${JSON.stringify(health.crashes)}`);
  assert(abort.process === "sh", `recorded as ${abort.process}`);
  assert(abort.uid !== "?", "the crash has no uid, so the process cache missed it");
  return `${abort.process} ${abort.detail} (uid ${abort.uid})`;
});

await check("health reports each component, not just ok", async () => {
  // "ok" was not a useful answer on its own: a desktop whose compositor has been given up
  // on still serves a screen and one whose x11vnc is crash-looping does not, and both used
  // to look identical here. Anything deciding whether to recycle a box reads this.
  const health = await box.health();
  const desktop = (health.desktop_health ?? []).find(entry => entry.index === 1);
  assert(desktop, `no component health for desktop 1: ${JSON.stringify(health.desktop_health)}`);
  assert(
    typeof desktop.degraded === "boolean",
    "desktop health does not say whether it is degraded"
  );
  const states = new Set(desktop.components.map(component => component.state));
  for (const state of states) {
    assert(
      ["ok", "backoff", "crashloop", "disabled"].includes(state),
      `unknown component state ${state}`
    );
  }
  return `degraded=${desktop.degraded}, ${desktop.components.length} component(s) tracked`;
});

await check("a compositor owns the display, so the dock is not a slab", async () => {
  // plank reads this once at startup and paints an opaque rectangle forever if the
  // answer is no. Debian's picom is 9.1 and rejects picom 10's --no-frame-pacing by
  // printing its usage — which is exactly how this ended up silently not running.
  const compositor = await box.exec("wait-compositor :1 && echo owned || echo none");
  assert(compositor.stdout.includes("owned"), "no compositor owns _NET_WM_CM_S0");
  const dock = await box.exec("pgrep -cx plank");
  assert(Number(dock.stdout.trim()) > 0, "the dock is not running");
  return "picom owns the selection, plank is up";
});

await check("VNC still delivers fresh frames under the compositor", async () => {
  // The failure this covers is one-sided and silent: XDamage misses a composited
  // repaint, x11vnc has nothing to send, and the viewer sits on a stale frame while X,
  // the agent and the screenshots all look healthy. -noxdamage is the fix; this proves
  // it works rather than that it was configured, by speaking RFB and requiring a
  // non-empty incremental update after something changes on screen.
  const flags = await box.exec("pgrep -a x11vnc | head -1");
  assert(flags.stdout.includes("-noxdamage"), `x11vnc is missing -noxdamage: ${flags.stdout}`);

  const probe = await box.exec("DISPLAY=:1 vnc-probe 5901 :1");
  assert(probe.stdout.startsWith("fresh:"), probe.stdout || probe.stderr);
  return probe.stdout.trim();
});

await check("Chromium's flag warning is policy-suppressed", async () => {
  // The infobar is a trap rather than an eyesore: it covers page content, reappears on
  // every launch, and is one more thing a model has to notice and dismiss.
  const policy = await box.exec("cat /etc/chromium/policies/managed/agentbox.json");
  assert(
    /"CommandLineFlagSecurityWarningsEnabled":\s*false/.test(policy.stdout),
    policy.stdout || "no policy file"
  );
  return "managed policy in place";
});

await check("the clipboard can be written and read from outside the box", async () => {
  // The point of the feature: a VNC canvas is not a text field, so without this a URL or
  // a token has to be retyped by hand and anything an agent copies is stuck in the box.
  const text = "clipboard-round-trip 剪贴板 ✓";
  await box.writeClipboard(text, 1);

  const read = await box.readClipboard(1);
  assert(read.text === text, `read back ${JSON.stringify(read.text)}`);

  // And it really is the X selection, not just something the daemon remembered.
  const inX = await box.exec("DISPLAY=:1 xclip -o -selection clipboard");
  assert(inX.stdout === text, `X has ${JSON.stringify(inX.stdout)}`);
  return "round-trips through the X selection";
});

await check("box-clip survives the shell tool's process-group cleanup", async () => {
  // A bare `xclip` copy from the shell tool is empty a second later: the selection
  // belongs to xclip, and the tool kills its process group when the command returns.
  // Both halves are asserted, because the difference is the whole reason box-clip exists.
  await box.exec("DISPLAY=:1 sh -c 'printf raw-xclip | xclip -selection clipboard'");
  const afterRaw = await box.exec("DISPLAY=:1 xclip -selection clipboard -o 2>/dev/null || true");
  assert(
    afterRaw.stdout.trim() !== "raw-xclip",
    "a bare xclip copy survived, so this test no longer measures anything"
  );

  await box.exec("DISPLAY=:1 sh -c 'printf wrapped-ok | box-clip copy'");
  const afterWrapper = await box.exec("DISPLAY=:1 box-clip paste");
  assert(afterWrapper.stdout.trim() === "wrapped-ok", `got ${afterWrapper.stdout}`);
  return "bare xclip is lost, box-clip persists";
});

await check("the clipboard is one clipboard", async () => {
  // X has two selections and applications disagree about which is "the" clipboard;
  // without syncing them, a copy in one app does not paste in another, and the VNC
  // clipboard carries whichever one happened to be set.
  // One command: xclip owns the selection only while it lives, and a separate exec ends
  // its process group — which is why splitting this in two reported an empty PRIMARY.
  const both = await box.exec(
    "DISPLAY=:1 sh -c 'printf clip-sync-ok | xclip -selection clipboard; sleep 2; " +
      "xclip -o -selection clipboard; echo; xclip -o -selection primary'"
  );
  const [clipboard = "", primary = ""] = both.stdout.trim().split("\n");
  assert(clipboard.trim() === "clip-sync-ok", `CLIPBOARD holds ${clipboard}`);
  assert(primary.trim() === "clip-sync-ok", `PRIMARY holds ${primary}`);
  return "PRIMARY and CLIPBOARD agree";
});

await check("windows can be listed, raised, and read while covered", async () => {
  // What this buys: the model no longer has to find windows by eye. A dialog behind the
  // browser is invisible in a screenshot, and a window it cannot see it cannot decide to
  // raise. Reading a covered window works only because a compositor is running.
  await box.exec("DISPLAY=:1 setsid xfce4-terminal --geometry=50x12+80+80 >/dev/null 2>&1 &");
  await new Promise(resolve => setTimeout(resolve, 5000));

  const listed = await box.computer([{ action: "list_windows" }], { display: 1, owner: owner() });
  assert(Array.isArray(listed.windows), "no window list returned");
  const terminal = listed.windows.find(w => /Terminal/i.test(w.title));
  assert(terminal, `no terminal in ${JSON.stringify(listed.windows?.map(w => w.title))}`);
  assert(/^0x[0-9a-f]+$/i.test(terminal.id), `odd window id ${terminal.id}`);
  assert(terminal.width > 100 && terminal.height > 50, "geometry looks wrong");

  // Cover it completely, then read it anyway.
  await box.exec("DISPLAY=:1 setsid box-chrome --app=about:blank --window-size=1280,800 >/dev/null 2>&1 &");
  await new Promise(resolve => setTimeout(resolve, 14000));

  const covered = await box.computer(
    [{ action: "screenshot_window", window_id: terminal.id }],
    { display: 1, owner: owner() }
  );
  assert(covered.success, covered.error ?? "window capture failed");
  const bytes = Buffer.from(covered.screenshot, "base64").length;
  assert(bytes > 500, `window capture is only ${bytes} bytes`);

  // And raising it is what makes it usable, since synthetic input follows focus.
  const raised = await box.computer(
    [{ action: "activate_window", window_id: terminal.id }, { action: "list_windows" }],
    { display: 1, owner: owner() }
  );
  assert(raised.success, raised.error ?? "activate failed");

  await box.exec("DISPLAY=:1 wmctrl -c Chromium; DISPLAY=:1 wmctrl -c Terminal; true");
  return `${listed.windows.length} windows, covered capture ${bytes} bytes`;
});

await check("a point read off a window capture can be clicked", async () => {
  // The pair that makes "read it, then act on it" work: a window capture is in the
  // window's own coordinates, so clicking those numbers on the screen would land
  // somewhere else entirely. This drives a completely covered window by its own
  // coordinates and checks the keystrokes landed in it.
  await box.exec(
    "rm -f /tmp/smoke-window-click.txt; " +
      'DISPLAY=:1 setsid xterm -geometry 44x10+150+120 -e sh -c "cat > /tmp/smoke-window-click.txt" >/dev/null 2>&1 & ' +
      "sleep 3; true",
    { timeoutMs: 30_000 }
  );

  const listed = await box.computer([{ action: "list_windows" }], {
    display: 1,
    owner: owner(),
  });
  const sink = listed.windows?.find(w => w.desktop >= 0 && w.width < 600 && w.height < 300);
  assert(sink, `no sink window in ${JSON.stringify(listed.windows?.map(w => w.title))}`);

  // Bury it.
  await box.exec(
    "DISPLAY=:1 setsid box-chrome --app=about:blank --window-size=1280,800 >/dev/null 2>&1 &"
  );
  await new Promise(resolve => setTimeout(resolve, 14000));

  // Click the middle of the buried window using the window's own coordinates, then type.
  const clicked = await box.computer(
    [
      {
        action: "click_in_window",
        window_id: sink.id,
        coordinate: [Math.floor(sink.width / 2), Math.floor(sink.height / 2)],
      },
      { action: "type", text: "window-click-ok\n" },
    ],
    { display: 1, owner: owner() }
  );
  assert(clicked.success, clicked.error ?? "click_in_window failed");

  await box.exec("sleep 1; DISPLAY=:1 xdotool key ctrl+d; sleep 1");
  const written = await box.exec("cat /tmp/smoke-window-click.txt 2>/dev/null || true");
  assert(
    written.stdout.includes("window-click-ok"),
    `the buried window received ${JSON.stringify(written.stdout)}`
  );

  // Out of bounds is refused rather than clamped to an edge.
  let refused = false;
  try {
    await box.computer(
      [{ action: "click_in_window", window_id: sink.id, coordinate: [sink.width + 50, 5] }],
      { display: 1, owner: owner() }
    );
  } catch {
    refused = true;
  }
  const outOfBounds = await box.computer(
    [{ action: "click_in_window", window_id: sink.id, coordinate: [sink.width + 50, 5] }],
    { display: 1, owner: owner() }
  ).catch(() => ({ success: false, error: "rejected" }));
  assert(refused || outOfBounds.success === false, "a point outside the window was clicked");

  await box.exec("DISPLAY=:1 wmctrl -c Chromium; true");
  return "clicked a buried window by its own coordinates";
});

await check("a desktop refuses input from another agent", async () => {
  // Demonstrated before it was fixed: an agent can read BOXD_TOKEN's power through the
  // daemon and name any display, so one agent could type into another's screen.
  const claimed = 7;
  await box.ensureDisplay(claimed, "owner-alpha");

  const mine = await box.computer([{ action: "cursor_position" }], {
    display: claimed,
    owner: "owner-alpha",
  });
  assert(mine.success, "the owner was refused its own desktop");

  for (const [label, owner] of [["no token", undefined], ["another agent's", "owner-beta"]]) {
    let refused = false;
    try {
      await box.computer([{ action: "type", text: "CROSS-DESKTOP" }], {
        display: claimed,
        owner,
      });
    } catch (error) {
      refused = /belongs to another agent/.test(String(error));
    }
    assert(refused, `a request with ${label} was allowed onto a claimed desktop`);
  }
  return "owner served, others refused";
});

await check("the desktop can be recorded", async () => {
  // A transcript is the agent's account of what it did; this is the screen's.
  // A previous run that failed mid-check can leave a recording running, and the daemon
  // rightly refuses a second one on the same desktop.
  await box.stopRecording(1).catch(() => {});
  const started = await box.startRecording({ display: 1, name: "smoke" });
  assert(started.file.endsWith(".mp4"), `unexpected file ${started.file}`);

  // Something on screen, so the file is not a still frame.
  await box.computer([
    { action: "mouse_move", coordinate: [200, 200] },
    { action: "wait", duration_ms: 1200 },
    { action: "mouse_move", coordinate: [800, 500] },
    { action: "wait", duration_ms: 1200 },
  ], { display: 1, owner: owner() });

  const finished = await box.stopRecording(1);
  assert((finished.size_bytes ?? 0) > 2000, `file is only ${finished.size_bytes} bytes`);

  // Decoded rather than trusted: a plausible size and a broken container look the same.
  const probe = await box.exec(
    "ffprobe -v error -select_streams v:0 -count_frames " +
      "-show_entries stream=codec_name,width,height,nb_read_frames " +
      `-of default=noprint_wrappers=1 '${finished.path}'`
  );
  assert(probe.stdout.includes("codec_name=h264"), probe.stdout || probe.stderr);
  assert(probe.stdout.includes("width=1280"), probe.stdout);
  const frames = Number(/nb_read_frames=(\d+)/.exec(probe.stdout)?.[1] ?? 0);
  assert(frames > 10, `only ${frames} frames decoded`);

  await box.exec(`rm -f '${finished.path}'`);
  return `h264 1280x800, ${frames} frames, ${Math.round((finished.size_bytes ?? 0) / 1024)}KB`;
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
  const result = await box.computer([{ action: "screenshot" }], { display: 1, owner: owner() });
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
  const result = await box.computer(
    [{ action: "mouse_move", coordinate: target }, { action: "cursor_position" }],
    { display: 1, owner: owner() }
  );

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
  const result = await box.computer([{ action: "drag", path: [[10, 10]] }], { display: 1, owner: owner() });
  assert(result.success === false, "a one-point drag should fail");
  assert(result.error, "no error message");
  assert(result.screenshot, "no screenshot — the model would be blind on failure");
  return `${Buffer.from(result.screenshot, "base64").length} bytes with the error`;
});

await check("an unsafe key name is refused", async () => {
  const result = await box.computer([{ action: "key", key: "a mousemove 5 5" }], { display: 1, owner: owner() });
  assert(result.success === false, "an injected xdotool subcommand was accepted");
  assert(/not a keysym/.test(result.error), `unexpected error: ${result.error}`);
  return "keysym validation holds";
});

await check("a valid chord is accepted", async () => {
  const result = await box.computer([{ action: "key", key: "ctrl+shift+F5" }], { display: 1, owner: owner() });
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
      { agent: first, registry, bus, box, display, boxOwner: owner() }
    );
    assert(!holder.isError, `holder was refused: ${holder.text}`);
    assert(holder.images?.length === 1, "holder got no screenshot");

    const refused = await dispatchTool(
      "computer",
      { actions: [{ action: "screenshot" }] },
      { agent: second, registry, bus, box, display, boxOwner: owner() }
    );
    assert(refused.isError === true, "a second agent was allowed onto the display");
    assert(!refused.images, "the refused agent still received an image");
    assert(/SmokeHolder/.test(refused.text), "refusal does not name the holder");

    display.release(first.id);
    const afterRelease = await dispatchTool(
      "computer",
      { actions: [{ action: "screenshot" }] },
      { agent: second, registry, bus, box, display, boxOwner: owner() }
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
    const typed = await box.computer([{ action: "type", text: "Aprenderás café" }], { display: 1, owner: owner() });
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
      // A distinct title, and activation by that title: vnc-probe also opens an xterm, and
      // searching by class activated whichever one X happened to return — so the text was
      // typed into the probe's window and this check read an empty file.
      'DISPLAY=:1 setsid xterm -T smoke-sink -e sh -c "cat > /tmp/smoke-typed.txt" >/dev/null 2>&1 & ' +
      "sleep 3; DISPLAY=:1 xdotool search --name smoke-sink windowactivate --sync windowfocus",
    { timeoutMs: 30_000 }
  );
  await box.computer([{ action: "type", text: `${text}\n` }], { display: 1, owner: owner() });
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
