/** Real-image check, kept outside the hermetic unit suite. Pass a locally built image tag. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const image = process.argv[2];
if (!image || image.startsWith("-")) throw new Error("usage: node scripts/smoke-documents.mjs IMAGE");
const fault = mkdtempSync(join(tmpdir(), "box-document-fault-"));
chmodSync(fault, 0o755); // The container's box uid must be able to read the injected module.
const run = (options, entrypoint, args) => {
  const result = spawnSync("docker", [
    "run", "--rm", "--network", "none", "--user", "box", ...options,
    "--entrypoint", entrypoint, image, ...args,
  ], { encoding: "utf8", timeout: 60_000 });
  if (result.error) throw result.error;
  return { status: result.status, output: result.stdout + result.stderr };
};
try {
  const imports = run([], "python3", ["-c", "import docx, openpyxl, pptx, reportlab, PIL, matplotlib, gi, Xlib"]);
  assert.equal(imports.status, 0, imports.output);
  const healthy = run([], "node", ["/opt/box-checks/documents.cjs"]);
  assert.equal(healthy.status, 0, healthy.output);
  console.log(healthy.output.trim());

  // Shadow a missing library in this disposable container only. Doctor must surface it,
  // not silently skip the check. No pip/uninstall, live box, volume or network access.
  writeFileSync(join(fault, "docx.py"), 'raise ImportError("INV713 missing document library")\n');
  const options = ["--mount", `type=bind,source=${fault},target=/tmp/document-fault,readonly`,
    "--env", "PYTHONPATH=/tmp/document-fault"];
  const broken = run(options, "box-doctor", []);
  assert.notEqual(broken.status, 0, broken.output);
  assert.match(broken.output, /FAIL documents:/);
  assert.match(broken.output, /INV713 missing document library/);
  console.log("missing library: box-doctor reports FAIL documents and exits nonzero");
} finally {
  rmSync(fault, { recursive: true, force: true });
}
