import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type LoginApp = {
  getLoginItemSettings(): { openAtLogin: boolean };
  setLoginItemSettings(settings: Record<string, unknown>): void;
};
const { syncLoginItem } = createRequire(import.meta.url)("../../electron/login-item.cjs") as {
  syncLoginItem(app: LoginApp, configFile: string): string;
};

function fakeApp(openAtLogin: boolean) {
  const calls: Record<string, unknown>[] = [];
  const app: LoginApp = {
    getLoginItemSettings: () => ({ openAtLogin }),
    setLoginItemSettings: settings => {
      calls.push(settings);
      openAtLogin = settings.openAtLogin === true;
    },
  };
  return { app, calls };
}

function configWith(t: { after(fn: () => void): void }, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "login-item-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "config.json");
  writeFileSync(file, body);
  return file;
}

// Every macOS registration of an already-registered app can leave one more Login Items row
// behind once the bundle has been replaced by an update. The shell runs this on every launch
// and every settings restart, so it must not register when the OS already agrees.
test("an already-registered login item is not registered again", t => {
  const { app, calls } = fakeApp(true);
  const file = configWith(t, JSON.stringify({ startupItem: true }));
  assert.equal(syncLoginItem(app, file), "unchanged");
  assert.equal(syncLoginItem(app, file), "unchanged");
  assert.deepEqual(calls, []);
});

test("a changed setting is applied once, without a path that would pin one build", t => {
  const { app, calls } = fakeApp(false);
  const file = configWith(t, JSON.stringify({ startupItem: true }));
  assert.equal(syncLoginItem(app, file), "on");
  assert.equal(syncLoginItem(app, file), "unchanged");
  assert.deepEqual(calls, [{ openAtLogin: true }]);
});

test("turning the setting off removes the login item", t => {
  const { app, calls } = fakeApp(true);
  const file = configWith(t, JSON.stringify({ startupItem: false }));
  assert.equal(syncLoginItem(app, file), "off");
  assert.deepEqual(calls, [{ openAtLogin: false }]);
});

test("a login item the user never configured here is left alone", t => {
  const { app, calls } = fakeApp(true);
  assert.equal(syncLoginItem(app, configWith(t, "{}")), "unmanaged");
  assert.equal(syncLoginItem(app, join(tmpdir(), "no-such-dir-login-item", "config.json")), "unmanaged");
  assert.deepEqual(calls, []);
});
