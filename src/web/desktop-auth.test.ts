import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { desktopAuth } = createRequire(import.meta.url)("../../electron/ui-auth.cjs") as {
  desktopAuth(env: Record<string, string>): { token?: string; headers: Record<string, string>; bootstrapUrl(base: string): string };
};

test("desktop host, event stream and UI bootstrap use the same private file credential", t => {
  const home = mkdtempSync(join(tmpdir(), "desktop-auth-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  writeFileSync(join(home, "ui-token"), "fixture/+token\n", { mode: 0o600 });
  const auth = desktopAuth({ AGENTBOX_HOME: home });
  assert.equal(auth.token, "fixture/+token");
  assert.equal(auth.headers.authorization, "Bearer fixture/+token");
  assert.equal(auth.bootstrapUrl("http://localhost/"), "http://localhost/?token=fixture%2F%2Btoken");
  assert.equal(desktopAuth({ AGENTBOX_HOME: home, AGENTBOX_UI_TOKEN: "explicit" }).token, "explicit");
});

test("an explicitly configured missing or empty credential cannot silently disable authentication", t => {
  const home = mkdtempSync(join(tmpdir(), "desktop-auth-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const file = join(home, "private-token");
  assert.throws(() => desktopAuth({ LUMENBOX_UI_TOKEN_FILE: file }), /cannot be read/);
  writeFileSync(file, "\n");
  assert.throws(() => desktopAuth({ LUMENBOX_UI_TOKEN_FILE: file }), /empty/);
  assert.throws(() => desktopAuth({ AGENTBOX_HOME: home, AGENTBOX_UI_TOKEN: "" }), /empty/);
});

test("a first start with no token file makes one, private, rather than serving without (INV-1543)", t => {
  const home = mkdtempSync(join(tmpdir(), "desktop-auth-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const first = desktopAuth({ AGENTBOX_HOME: home });
  assert.match(first.token ?? "", /^[0-9a-f]{64}$/, "a token, in the CLI's format");
  assert.equal(statSync(join(home, "ui-token")).mode & 0o777, 0o600, "readable by its owner only");
  assert.equal(desktopAuth({ AGENTBOX_HOME: home }).token, first.token, "and the next start reads the same one");
  assert.match(first.bootstrapUrl("http://localhost/"), /\?token=/);
});
