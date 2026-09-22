/** INV-636. Real X11/AT-SPI verification in a disposable, freshly built image.
 * Never attaches to an existing box. Credential is ephemeral and kept in memory.
 * Run: node --experimental-transform-types scripts/cua-contract-smoke.mjs
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import { BoxClient } from "../src/box/client.ts";

const image = process.env.CUA_TEST_IMAGE ?? "agentbox/cua-fixes-test:latest";
const name = `lumenbox-cua-test-${process.pid}`;
const credential = randomBytes(32).toString("hex");
const docker = args => execFileSync("docker", args, { encoding: "utf8", env: { ...process.env, BOXD_TOKEN: credential }, stdio: ["ignore", "pipe", "pipe"] }).trim();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const rows = [];
let box;
let request;
const check = async (id, fn) => {
  try { await fn(); rows.push({ id, status: "pass" }); console.log(`PASS ${id}`); }
  catch (error) { rows.push({ id, status: "fail", error: error.message }); console.log(`FAIL ${id}: ${error.message}`); }
};
const fixture = `import gi, json
gi.require_version('Gtk', '3.0')
from gi.repository import Gtk
state = {'clicks': 0}
def save():
    with open('/tmp/cua-fixture-state.json', 'w') as f: json.dump(state, f)
win = Gtk.Window(title='CUA Contract Fixture')
win.set_default_size(420, 240)
layout = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=16)
win.add(layout)
label = Gtk.Label(label='No clicks yet')
button = Gtk.Button(label='Increment fixture')
def click(_):
    state['clicks'] += 1
    label.set_text('Delivered clicks: ' + str(state['clicks']))
    save()
button.connect('clicked', click)
layout.pack_start(button, True, True, 0)
layout.pack_start(label, True, True, 0)
entry = Gtk.Entry()
entry.set_placeholder_text('Fixture text')
layout.pack_start(entry, True, True, 0)
duplicate = Gtk.Button(label='Duplicate title')
def duplicate_window(_):
    extra = Gtk.Window(title='CUA Contract Fixture')
    extra.add(Gtk.Button(label='Other window'))
    extra.show_all()
duplicate.connect('clicked', duplicate_window)
layout.pack_start(duplicate, True, True, 0)
win.connect('destroy', Gtk.main_quit)
save()
win.show_all()
Gtk.main()
`;

try {
  const digest = docker(["image", "inspect", "--format", "{{.Id}}", image]);
  docker(["run", "-d", "--name", name, "--shm-size=1g", "-p", "127.0.0.1::1337", "-e", "BOXD_TOKEN", image]);
  const port = docker(["port", name, "1337/tcp"]).split(":").at(-1);
  box = new BoxClient({ baseUrl: `http://127.0.0.1:${port}`, token: credential, timeoutMs: 60000 });
  request = async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST", headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const result = await response.json();
    assert.ok(response.ok, result.error ?? `HTTP ${response.status}`);
    return result;
  };
  let ready = false;
  for (let i = 0; i < 90; i++) {
    try { const health = await box.health(); if (health.resolution) { ready = true; break; } } catch {}
    await sleep(1000);
  }
  assert.ok(ready, "disposable box did not become ready");
  await box.exec(`cat > /tmp/cua-fixture.py <<'PY'\n${fixture}\nPY\nDISPLAY=:1 python3 /tmp/cua-fixture.py >/tmp/cua-fixture.log 2>&1 &`);
  await sleep(1500);
  await box.exec("DISPLAY=:1 wmctrl -a 'CUA Contract Fixture'");
  const fixtureDiagnostic = await box.exec("cat /tmp/cua-fixture.log; DISPLAY=:1 wmctrl -lp; DISPLAY=:1 xdotool getactivewindow getwindowpid");
  console.log(`Fixture startup: ${fixtureDiagnostic.stdout} ${fixtureDiagnostic.stderr}`);
  assert.ok(fixtureDiagnostic.stdout.includes("CUA Contract Fixture"), "fixture failed to start; environment error, not a skipped pass");
  const state = async () => JSON.parse((await box.exec("cat /tmp/cua-fixture-state.json")).stdout);
  const list = () => box.computer([{ action: "list_elements" }]);
  const target = result => {
    const button = result.elements?.find(e => e.name === "Increment fixture");
    assert.ok(button, result.elements_note ?? "fixture control missing");
    return button;
  };
  await check("native_tree_and_bound_target", async () => {
    const read = await list();
    const button = target(read);
    assert.ok(read.elements_observation_id);
    assert.equal(read.observation.id, read.elements_observation_id);
    const before = await state();
    const clicked = await box.computer([{ action: "click_element", ref: button.ref, observation_id: read.elements_observation_id }]);
    assert.equal(clicked.success, true, clicked.error);
    assert.equal(clicked.outcome, "unknown", "delivered input without a postcondition is not verified success");
    assert.notEqual(clicked.effect, "confirmed");
    assert.equal((await state()).clicks, before.clicks + 1);
    const replay = await box.computer([{ action: "click_element", ref: button.ref }]);
    assert.equal(replay.outcome, "refused");
    assert.equal(replay.progress.dispatch, "not_started");
    assert.equal((await state()).clicks, before.clicks + 1);
  });
  await check("new_snapshot_refuses_old_token", async () => {
    const before = await state();
    const old = target(await list());
    await list();
    const result = await box.computer([{ action: "click_element", ref: old.ref }]);
    assert.equal(result.refusal_code, "STALE_OBSERVATION");
    assert.equal((await state()).clicks, before.clicks);
  });
  await check("unreadable_tree_invalidates_previous_reference", async () => {
    const old = target(await list());
    const before = await state();
    await box.exec("DISPLAY=:1 xterm -title CUA-No-Tree >/tmp/cua-xterm.log 2>&1 &");
    await sleep(500);
    await box.exec("DISPLAY=:1 wmctrl -a CUA-No-Tree");
    const missing = await list();
    assert.ok(missing.elements_note, "xterm should have no usable tree");
    const result = await box.computer([{ action: "click_element", ref: old.ref }]);
    assert.equal(result.outcome, "refused");
    assert.equal((await state()).clicks, before.clicks);
    await box.exec("DISPLAY=:1 wmctrl -a 'CUA Contract Fixture'");
  });
  await check("window_move_refuses_stored_geometry", async () => {
    const read = await list();
    const button = target(read);
    const before = await state();
    await box.exec(`DISPLAY=:1 wmctrl -i -r ${read.observation.window_id} -e 0,300,250,-1,-1`);
    const result = await box.computer([{ action: "click_element", ref: button.ref }]);
    assert.equal(result.outcome, "refused");
    assert.equal((await state()).clicks, before.clicks);
  });
  await check("screenshot_before_click_returns_post_action_image", async () => {
    const read = await list();
    const button = target(read);
    const before = await state();
    const result = await box.computer([{ action: "screenshot" }, { action: "click_element", ref: button.ref }]);
    assert.equal(result.success, true, result.error);
    assert.equal((await state()).clicks, before.clicks + 1);
    assert.equal(result.observation.after_action, 2);
    assert.notEqual(result.screenshot, read.screenshot);
  });
  await check("partial_batch_reports_prefix_without_replay", async () => {
    const button = target(await list());
    const before = await state();
    const result = await box.computer([
      { action: "click_element", ref: button.ref }, { action: "key", key: "invalid key" },
      { action: "click_element", ref: button.ref },
    ]);
    assert.equal(result.outcome, "unknown");
    assert.equal(result.progress.executed_count, 1);
    assert.equal(result.progress.failed_at, 1);
    assert.equal((await state()).clicks, before.clicks + 1);
  });
  await check("takeover_during_wait_stops_input_and_invalidates_tokens", async () => {
    const button = target(await list());
    const before = await state();
    const pending = box.computer([{ action: "wait", duration_ms: 2000 }, { action: "click_element", ref: button.ref }]);
    await sleep(250);
    await request("/displays/control", { index: 1, controller: "user" });
    const result = await pending;
    assert.equal(result.outcome, "refused");
    assert.equal(result.progress.dispatch, "not_started");
    assert.equal((await state()).clicks, before.clicks);
    await request("/displays/control", { index: 1, controller: "agent" });
    const replay = await box.computer([{ action: "click_element", ref: button.ref }]);
    assert.equal(replay.outcome, "refused");
  });
  await check("element_tokens_do_not_cross_desktops", async () => {
    const button = target(await list());
    const before = await state();
    await box.ensureDisplay(2);
    const result = await box.computer([{ action: "click_element", ref: button.ref }], { display: 2 });
    assert.equal(result.outcome, "refused");
    assert.equal((await state()).clicks, before.clicks);
  });
  await check("native_postconditions_match_and_mismatch_without_replay", async () => {
    const button = target(await list());
    const before = await state();
    const matched = await box.computer([{ action: "click_element", ref: button.ref }], {
      expect: { window_title: "CUA Contract Fixture", element: { role: button.role, name: button.name } },
    });
    assert.equal(matched.outcome, "ok");
    assert.equal(matched.verification.status, "satisfied");
    const next = target(await list());
    const missed = await box.computer([{ action: "click_element", ref: next.ref }], {
      expect: { window_title: "A title that does not exist" },
    });
    assert.equal(missed.outcome, "failed");
    assert.equal(missed.progress.dispatch, "sent");
    assert.equal(missed.verification.status, "unsatisfied");
    assert.equal((await state()).clicks, before.clicks + 2, "neither mismatch nor unknown triggers replay");
  });
  await check("same_pid_same_title_windows_refuse_ambiguous_tree", async () => {
    const read = await list();
    const duplicate = read.elements.find(e => e.name === "Duplicate title");
    assert.ok(duplicate);
    await box.computer([{ action: "click_element", ref: duplicate.ref }]);
    const ambiguous = await list();
    assert.match(ambiguous.elements_note ?? "", /ambiguous accessibility window/);
  });
  console.log(JSON.stringify({ image, digest, platform: "linux/x11/gtk3", rows }, null, 2));
  if (rows.some(row => row.status !== "pass")) process.exitCode = 1;
} finally {
  try { docker(["rm", "-f", name]); } catch {}
}
