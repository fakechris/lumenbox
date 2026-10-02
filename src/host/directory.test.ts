import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Directories, directorySource, departmentQuotaKey, DIRECTORY_MAX_AGE_MS } from "./directory.ts";

test("directory snapshots replace atomically, depart/move people, and isolate tenant incarnations", async () => {
  const home = mkdtempSync(join(tmpdir(), "directories-"));
  try {
    const directories = new Directories(join(home, "directory.json"));
    const a = directorySource("feishu", 1, "tenant-a", "feishu");
    const b = directorySource("another", 1, "tenant-b", "feishu");
    const snapshot = { departments: [{ vendorId: "eng", name: "Engineering", parentVendorId: null }], people: [{ vendorSubject: "ada", name: "Same name", departmentVendorIds: ["eng"] }] };
    await directories.sync(a, async () => snapshot);
    await directories.sync(b, async () => ({ departments: snapshot.departments, people: [] }));
    assert.deepEqual(directories.membership(["feishu:ada"], [a, b]), { eligible: true, departmentKeys: [departmentQuotaKey(a, "eng")] });
    assert.equal(directories.membership(["another:ada"], [a, b]).eligible, false, "same name/subject in another tenant does not link");
    await assert.rejects(directories.sync(a, async () => { throw new Error("partial response secret"); }), /sync failed/);
    assert.deepEqual(directories.of("feishu")!.snapshot, snapshot, "failed fetch preserves complete snapshot");
    assert.equal(directories.membership(["feishu:ada"], [a]).eligible, false, "failed sync cannot grant new allocations");
    await directories.sync(a, async () => ({ ...snapshot, people: [{ ...snapshot.people[0]!, departmentVendorIds: ["support"] }] }));
    assert.deepEqual(directories.membership(["feishu:ada"], [a]).departmentKeys, [departmentQuotaKey(a, "support")]);
    assert.equal(directories.membership(["feishu:ada"], [a], Date.now() + DIRECTORY_MAX_AGE_MS + 1).eligible, false);
    const replacement = directorySource("feishu", 2, "tenant-new", "feishu");
    assert.equal(directories.membership(["feishu:ada"], [replacement]).eligible, false);
    await directories.sync(a, async () => ({ ...snapshot, people: [] }));
    assert.equal(directories.membership(["feishu:ada"], [a]).eligible, false, "departed person gets no new allocation");
  } finally { rmSync(home, { recursive: true, force: true }); }
});
