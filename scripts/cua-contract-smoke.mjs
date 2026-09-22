/** INV-636. Real X11/AT-SPI verification in a disposable, freshly built image.
 * Never attaches to an existing box. Credential is ephemeral and kept in memory.
 * Run: node --experimental-transform-types scripts/cua-contract-smoke.mjs
 */
import { execFileSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { matrixReport } from "./cua-matrix.mjs";
import assert from "node:assert/strict";
import { BoxClient } from "../src/box/client.ts";

const image = process.env.CUA_TEST_IMAGE ?? "agentbox/cua-platform-test:latest";
const name = `lumenbox-cua-test-${process.pid}`;
const credential = randomBytes(32).toString("hex");
const docker = args => execFileSync("docker", args, { encoding: "utf8", env: { ...process.env, BOXD_TOKEN: credential }, stdio: ["ignore", "pipe", "pipe"] }).trim();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const rows = [];
const matrix = JSON.parse(readFileSync(new URL('../docker/cua-test/matrix.json', import.meta.url), 'utf8'));
const reportPath = process.env.CUA_TEST_REPORT ?? '.runtime/cua-matrix.json';
let digest;
let environmentError;
let runtime;
let latency;
const fixtureFiles = ['scripts/cua-contract-smoke.mjs', 'scripts/cua-matrix.mjs', 'docker/cua-test/matrix.json', 'docker/cua-test/qt-fixture.py', 'docker/cua-test/web-fixture.mjs', 'docker/cua-test/electron-fixture.cjs', 'docker/cua-test/platform.Dockerfile'];
const fixtureHash = createHash('sha256');
for (const file of fixtureFiles) fixtureHash.update(file).update(readFileSync(file));
const source = { commit: execFileSync('git', ['rev-parse', 'HEAD'], {encoding:'utf8'}).trim(), fixtures_sha256: fixtureHash.digest('hex') };
let box;
let request;
const selected = process.env.CUA_CASES ? new Set(process.env.CUA_CASES.split(",")) : undefined;
const check = async (id, fn) => {
  if (selected && !selected.has(id)) return;
  const started = Date.now();
  try { await fn(); rows.push({ id, status: "pass", duration_ms: Date.now() - started }); console.log(`PASS ${id}`); }
  catch (error) { rows.push({ id, status: error.code === 'ERR_ASSERTION' ? 'fail' : 'environment_error', duration_ms: Date.now() - started, error: error.message }); console.log(`FAIL ${id}: ${error.message}`); }
};
const fixture = `import gi, json
gi.require_version('Gtk', '3.0')
from gi.repository import Gtk
state = {'clicks': 0, 'text': ''}
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
def text_changed(widget):
    state['text'] = widget.get_text()
    save()
entry.connect('changed', text_changed)
layout.pack_start(entry, True, True, 0)
disabled = Gtk.Button(label='Disabled fixture')
disabled.set_sensitive(False)
layout.pack_start(disabled, True, True, 0)
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
  digest = docker(["image", "inspect", "--format", "{{.Id}}", image]);
  docker(["run", "-d", "--name", name, "--shm-size=1g", "-p", "127.0.0.1::1337", "-e", "BOXD_TOKEN", image]);
  runtime = {
    platform: docker(['image', 'inspect', '--format', '{{.Os}}/{{.Architecture}}', image]),
    packages: docker(['exec', name, 'dpkg-query', '-W', 'chromium', 'python3-pyqt5', 'libgtk-3-0t64']),
    electron: docker(['exec', name, 'node', '-p', "require('/opt/cua-electron/node_modules/electron/package.json').version"]),
  };
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
  const samples = Math.min(20, Math.max(0, Number(process.env.CUA_BENCHMARK_SAMPLES ?? 0)));
  if (samples > 0) {
    const quantiles = values => {
      const sorted = [...values].sort((a, b) => a - b);
      return { samples_ms: values, p50_ms: sorted[Math.ceil(values.length * .5) - 1], p95_ms: sorted[Math.ceil(values.length * .95) - 1] };
    };
    const measured = async operation => { const start = Date.now(); await operation(); return Date.now() - start; };
    const cold = await measured(async () => { target(await list()); });
    const reads = [], invokes = [], values = [];
    for (let i = 0; i < samples; i++) {
      reads.push(await measured(async () => { target(await list()); }));
      const button = target(await list());
      const before = await state();
      invokes.push(await measured(async () => {
        const result = await box.computer([{ action: 'invoke_element', ref: button.ref }]);
        assert.equal(result.progress?.dispatch, 'sent');
      }));
      assert.equal((await state()).clicks, before.clicks + 1);
      const entry = (await list()).elements?.find(e => e.operations?.includes('set_value'));
      assert.ok(entry);
      const value = `Benchmark value ${i}`;
      values.push(await measured(async () => {
        const result = await box.computer([{ action: 'set_value', ref: entry.ref, value }]);
        assert.equal(result.verification?.status, 'satisfied');
      }));
      assert.equal((await state()).text, value);
    }
    latency = { scope: 'end-to-end RPC includes capture and configured settle; first tree is cold session, later samples warm application; helper process is always fresh', cold_observation_ms: cold, warm_observation: quantiles(reads), native_invoke: quantiles(invokes), native_set_value: quantiles(values) };
  }
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
  await check("semantic_invoke_changes_application_without_moving_pointer", async () => {
    const read = await list();
    const button = target(read);
    assert.ok(button.operations.includes("invoke"));
    const before = await state();
    const pointer = (await box.computer([{ action: "cursor_position" }])).cursor_position;
    const result = await box.computer([{ action: "invoke_element", ref: button.ref }]);
    assert.equal(result.progress.dispatch, "sent", result.error);
    assert.equal((await state()).clicks, before.clicks + 1);
    assert.deepEqual((await box.computer([{ action: "cursor_position" }])).cursor_position, pointer);
  });
  await check("semantic_set_value_uses_native_readback_and_application_state", async () => {
    const read = await list();
    const entry = read.elements.find(e => e.operations?.includes("set_value"));
    assert.ok(entry, "editable control must advertise set_value");
    const value = "Linux 原生文本 42";
    const result = await box.computer([{ action: "set_value", ref: entry.ref, value }]);
    assert.equal(result.outcome, "ok", result.error);
    assert.equal(result.verification.status, "satisfied");
    assert.equal((await state()).text, value, "GTK changed callback owns this oracle");
    const replay = await box.computer([{ action: "set_value", ref: entry.ref, value: "must not land" }]);
    assert.equal(replay.outcome, "refused");
    assert.equal((await state()).text, value);
  });
  await check("disabled_native_control_never_falls_back_to_coordinates", async () => {
    const read = await list();
    const target = read.elements.find(e => e.name === "Disabled fixture");
    assert.ok(target);
    assert.deepEqual(target.operations, []);
    const before = await state();
    const result = await box.computer([{ action: "invoke_element", ref: target.ref }]);
    assert.equal(result.outcome, "refused");
    assert.equal(result.progress.dispatch, "not_started");
    assert.deepEqual(await state(), before);
  });
  await check("same_pid_same_title_windows_refuse_ambiguous_tree", async () => {
    const read = await list();
    const duplicate = read.elements.find(e => e.name === "Duplicate title");
    assert.ok(duplicate);
    await box.computer([{ action: "click_element", ref: duplicate.ref }]);
    const ambiguous = await list();
    assert.match(ambiguous.elements_note ?? "", /ambiguous accessibility window/);
  });
  await check("qt_native_invoke_and_value", async () => {
    await box.exec("DISPLAY=:1 QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1 python3 /opt/cua-fixtures/qt-fixture.py >/tmp/cua-qt.log 2>&1 &");
    await sleep(1000);
    await box.exec("DISPLAY=:1 wmctrl -a 'CUA Qt Fixture'");
    const read = await list();
    const button = read.elements?.find(e => e.name === 'Increment Qt fixture');
    assert.ok(button, read.elements_note ?? 'Qt fixture control missing');
    assert.ok(button.operations?.includes('invoke'));
    await box.computer([{ action: 'invoke_element', ref: button.ref }]);
    assert.equal(JSON.parse((await box.exec('cat /tmp/cua-qt-state.json')).stdout).clicks, 1);
    const entry = (await list()).elements?.find(e => e.name === 'Qt fixture value');
    assert.ok(entry?.operations?.includes('set_value'), 'Qt text control must advertise set_value');
    const result = await box.computer([{ action: 'set_value', ref: entry.ref, value: 'Qt 原生 42' }]);
    assert.equal(result.verification?.status, 'satisfied', result.error);
    assert.equal(JSON.parse((await box.exec('cat /tmp/cua-qt-state.json')).stdout).text, 'Qt 原生 42');
  });
  await box.exec('node /opt/cua-fixtures/web-fixture.mjs >/tmp/cua-web.log 2>&1 &');
  await sleep(300);
  const webState = async client => JSON.parse((await box.exec('cat /tmp/cua-web-state.json')).stdout)[client];
  const browserCase = async (display, client) => {
    const opened = await box.browser(client === 'electron' ? { op: 'snapshot', display } : { op: 'open', display, url: `http://127.0.0.1:17880/?client=${client}` });
    assert.ok(opened.snapshot, opened.note ?? 'no browser snapshot');
    const clicked = await box.browser({ op: 'act', display, action: 'click', find: { role: 'button', name: 'Increment fixture' }, expect: { appears: 'Delivered clicks: 1' } });
    assert.equal(clicked.verification?.status, 'satisfied', clicked.note);
    assert.equal(clicked.outcome, 'ok');
    assert.equal((await webState(client)).clicks, 1);
    const typed = await box.browser({ op: 'act', display, action: 'type', find: { role: 'textbox', name: 'Fixture value' }, text: 'Verified 42', expect: { value: 'Verified 42' } });
    assert.equal(typed.verification?.status, 'satisfied', typed.note);
    assert.equal((await webState(client)).text, 'Verified 42');
    const hovered = await box.browser({ op: 'act', display, action: 'hover', find: { role: 'button', name: 'Increment fixture' } });
    assert.equal(hovered.outcome, 'unknown', 'background animation is not proof of a click');
    assert.equal((await webState(client)).clicks, 1);
  };
  await check('chromium_dom_verification_and_noop', () => browserCase(1, 'chromium'));
  await check('chromium_old_snapshot_refused', async () => {
    const old = await box.browser({ op: 'snapshot', display: 1 });
    const ref = /\[ref=([^\]]+)\]/.exec(old.snapshot)?.[1];
    assert.ok(ref, 'snapshot needs a ref');
    await box.browser({ op: 'snapshot', display: 1 });
    await assert.rejects(box.browser({ op: 'act', display: 1, action: 'click', ref, snapshot: old.snapshot_id }), /STALE_SNAPSHOT/);
    assert.equal((await webState('chromium')).clicks, 1);
  });
  await check('electron_dom_verification', async () => {
    await box.ensureDisplay(2);
    await box.exec('DISPLAY=:2 /opt/cua-electron/node_modules/.bin/electron --no-sandbox --remote-debugging-port=9224 /opt/cua-fixtures/electron-fixture.cjs >/tmp/cua-electron.log 2>&1 &');
    let ready = false;
    for (let i = 0; i < 20; i++) {
      const probe = await box.exec('curl -fsS http://127.0.0.1:9224/json/list');
      if (probe.exit_code === 0 && JSON.parse(probe.stdout).some(target => target.type === 'page' && target.url.includes('client=electron'))) { ready = true; break; }
      await sleep(500);
    }
    if (!ready) throw new Error('Electron fixture did not expose its CDP endpoint: ' + (await box.exec('head -n 24 /tmp/cua-electron.log')).stdout);
    await browserCase(2, 'electron');
  });
} catch (error) {
  environmentError = error.message;
  process.exitCode = 1;
} finally {
  try { docker(["rm", "-f", name]); } catch {}
  const report = matrixReport(matrix, rows, { image, digest, runtime, latency, source, environment_error: environmentError, completed_at: new Date().toISOString() });
  if (environmentError || !report.passed) process.exitCode = 1;
  mkdirSync(dirname(reportPath), {recursive:true});
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
