import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BootstrapAdmins } from "./bootstrap.ts";
import { ensureOwner, openRoster, OWNER_ID, PersonalInstallationOnly } from "./installation.ts";
import { Principals, soleAdmin } from "./principals.ts";

function fixture(): { home: string; path: string; codePath: string } {
  const home = mkdtempSync(join(tmpdir(), "installation-"));
  return { home, path: join(home, "principals.json"), codePath: join(home, "bootstrap-code") };
}

test("the desktop app's first start creates exactly one Owner and closes bootstrap; a server start never does", () => {
  const { home, path, codePath } = fixture();
  try {
    assert.equal(ensureOwner(path, codePath, { desktop: false }), "server");
    assert.equal(existsSync(path), false, "a server start leaves the roster to the bootstrap code");
    assert.equal(new BootstrapAdmins(path, codePath).ensure(), true, "and the server still arms the code for its first Admin");

    // The same installation started by the desktop app before anyone redeemed the code: an upgrade.
    assert.equal(ensureOwner(path, codePath, { desktop: true, name: "chris" }), "created-on-upgrade");
    assert.equal(existsSync(codePath), false, "the armed code is gone");
    const bootstrap = new BootstrapAdmins(path, codePath);
    assert.equal(bootstrap.pending(), false);
    assert.equal(bootstrap.ensure(), false, "a later start arms nothing");
    const principals = new Principals(path);
    assert.deepEqual(principals.list().map(p => [p.id, p.name, p.role]), [[OWNER_ID, "chris", "admin"]]);
    assert.equal(soleAdmin(principals.list()), OWNER_ID, "the unsigned operator resolves to the Owner");
    assert.equal(principals.installation().mode, "single-machine");
    assert.equal(ensureOwner(path, codePath, { desktop: true }), "not-empty", "a second start keeps the one Owner");

    const fresh = fixture();
    try {
      assert.equal(ensureOwner(fresh.path, fresh.codePath, { desktop: true, name: "" }), "created");
      assert.equal(new Principals(fresh.path).list()[0]!.name, "Owner");
    } finally { rmSync(fresh.home, { recursive: true, force: true }); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("no Owner on a roster with people, after a redemption, or after the roster was closed", () => {
  const { home, path, codePath } = fixture();
  try {
    new Principals(path).save([{ id: "feishu:ann", name: "Ann", role: "driver", identities: ["feishu:ann"] }]);
    assert.equal(ensureOwner(path, codePath, { desktop: true }), "not-empty");
    assert.deepEqual(new Principals(path).list().map(p => p.id), ["feishu:ann"]);

    rmSync(path);
    const bootstrap = new BootstrapAdmins(path, codePath);
    bootstrap.ensure();
    assert.equal(bootstrap.redeem(readFileSync(codePath, "utf8").trim(), "feishu:it", "IT", 1), true);
    new Principals(path).save([]);
    assert.equal(ensureOwner(path, codePath, { desktop: true }), "closed", "a redeemed bootstrap never becomes an Owner, even with the roster emptied");

    writeFileSync(path, JSON.stringify({ principals: [], bootstrap: { disabled: true } }));
    assert.equal(ensureOwner(path, codePath, { desktop: true }), "closed");
    writeFileSync(path, "broken");
    assert.throws(() => ensureOwner(path, codePath, { desktop: true }));
    assert.equal(readFileSync(path, "utf8"), "broken", "a broken roster is repaired by a person, not overwritten");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("independent desktop starts race for the Owner with exactly one created", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const { home, path, codePath } = fixture();
  try {
    const source = `import { ensureOwner } from ${JSON.stringify(new URL("./installation.ts", import.meta.url).href)}; const [path,codePath]=process.argv.slice(1); console.log(ensureOwner(path,codePath,{desktop:true}));`;
    const results = await Promise.all([0, 1, 2, 3].map(() => run(process.execPath, ["--experimental-transform-types", "--input-type=module", "-e", source, path, codePath])));
    assert.deepEqual(results.map(result => result.stdout.trim()).sort(), ["created", "not-empty", "not-empty", "not-empty"]);
    assert.equal(new Principals(path).list().length, 1);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("a personal installation never takes a second person; one converted before INV-1689 stays an organisation", () => {
  const { home, path, codePath } = fixture();
  try {
    ensureOwner(path, codePath, { desktop: true, name: "chris" });
    const principals = new Principals(path);
    const ann = { id: "feishu:ann", name: "Ann", role: "driver" as const, identities: ["feishu:ann"] };
    assert.throws(() => principals.save([...principals.list(), ann]), (error: unknown) => error instanceof PersonalInstallationOnly && /join or create an organisation/.test(error.message));
    assert.throws(() => principals.requireOrganisation(), PersonalInstallationOnly);
    assert.throws(() => principals.save([]), /cannot be removed/);
    assert.throws(() => principals.save([{ ...principals.list()[0]!, role: "driver" }]), /cannot be removed/);
    principals.save([{ ...principals.list()[0]!, name: "Chris" }]);
    assert.equal(new Principals(path).list()[0]!.name, "Chris", "the Owner is renamed in place");
    assert.equal(new Principals(path).installation().mode, "single-machine", "a save keeps the installation field");
    assert.deepEqual(new Principals(path).list().map(p => p.id), [OWNER_ID], "nothing let Ann in");

    // An installation INV-1685 converted: its file carries the conversion record, and it is an organisation as it was.
    const conversion = { at: 1234, by: "the operator", ownerId: OWNER_ID };
    writeFileSync(path, JSON.stringify({ installation: { mode: "organisation", ownerId: OWNER_ID, createdAt: 1, conversion }, bootstrap: { disabled: true }, principals: [{ id: OWNER_ID, name: "Chris", role: "admin", identities: [] }] }));
    principals.reload();
    principals.requireOrganisation();
    principals.save([...principals.list(), ann]);
    assert.deepEqual(new Principals(path).list().map(p => [p.id, p.role]), [[OWNER_ID, "admin"], ["feishu:ann", "driver"]]);
    assert.deepEqual(new Principals(path).installation().conversion, conversion, "later saves keep the record");
    const logs: string[] = [];
    openRoster({ desktop: true, path, codePath, bootstrap: { ensure: () => false }, reload: () => {}, log: line => logs.push(line) });
    assert.equal(logs.filter(line => line.startsWith("upgrade:") && line.includes("stays an organisation")).length, 1, "one upgrade line says so");
    principals.save([ann]);
    assert.equal(ensureOwner(path, codePath, { desktop: true }), "not-empty");
    principals.save([]);
    assert.equal(ensureOwner(path, codePath, { desktop: true }), "closed", "an organisation emptied by hand does not grow an Owner back");
  } finally { rmSync(home, { recursive: true, force: true }); }
});
