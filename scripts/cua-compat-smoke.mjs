/** Wire compatibility against actual old/new images; not a full historical host UI test. */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import assert from "node:assert/strict";
import { BoxClient, BoxError } from "../src/box/client.ts";
import { computerOutcome } from "../src/protocol/index.ts";

const legacyRef = "cc71f8223138a010b70c2e211cf739fa3a7ac57c";
const images = { legacy: process.env.CUA_LEGACY_IMAGE, current: process.env.CUA_RELEASE_IMAGE };
for (const image of Object.values(images)) if (!image || image.endsWith(":latest")) throw new Error("Set explicit CUA_LEGACY_IMAGE and CUA_RELEASE_IMAGE version tags or image IDs.");
const reportPath = process.env.CUA_COMPAT_REPORT ?? ".runtime/cua-compat.json";
const scratch = mkdtempSync(join(tmpdir(), "lumenbox-cua-compat-"));
const credential = randomBytes(32).toString("hex");
const docker = args => execFileSync("docker", args, { env: { ...process.env, BOXD_TOKEN: credential }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const report = { version: 1, source_commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), legacy_host_commit: legacyRef, scope: "BoxClient and outcome projection from exact old source against real daemons; full historical orchestrator/UI and general desktop delivery are not covered", started_at: new Date().toISOString(), cases: [] };
let container;
try {
  for (const path of ["src/box/client.ts", "src/protocol/index.ts"]) {
    const target = join(scratch, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, execFileSync("git", ["show", `${legacyRef}:${path}`]));
  }
  writeFileSync(join(scratch, "entry.ts"), 'export {BoxClient} from "./src/box/client.ts"; export {computerOutcome} from "./src/protocol/index.ts";');
  await build({ entryPoints: [join(scratch, "entry.ts")], bundle: true, platform: "node", format: "esm", outfile: join(scratch, "legacy.mjs"), logLevel: "silent" });
  const legacy = await import(pathToFileURL(join(scratch, "legacy.mjs")).href);
  for (const [generation, image] of Object.entries(images)) {
    const imageId = docker(["image", "inspect", "--format", "{{.Id}}", image]);
    container = `lumenbox-cua-compat-${process.pid}-${generation}`;
    docker(["run", "-d", "--name", container, "--shm-size=1g", "-p", "127.0.0.1::1337", "-e", "BOXD_TOKEN", imageId]);
    const port = docker(["port", container, "1337/tcp"]).split(":").at(-1);
    const options = { baseUrl: `http://127.0.0.1:${port}`, token: credential };
    const current = new BoxClient(options);
    let health;
    for (let i = 0; i < 90; i++) {
      try { health = await current.health(2000); if (health.resolution) break; } catch { /* Starting. */ }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    assert.ok(health?.resolution, "fixture daemon failed to start");
    assert.equal(health.desktop_contract?.version === 1, generation === "current", "the declared old/new images must actually differ in desktop contract");
    for (const host of ["legacy", "current"]) {
      const client = host === "legacy" ? new legacy.BoxClient(options) : current;
      const read = await client.computer([{ action: "screenshot" }]);
      assert.ok(read.screenshot.length > 0);
      const row = { host, box: generation, image, image_id: imageId, read: "pass" };
      if (host === "current" && generation === "legacy") {
        await assert.rejects(client.computer([{ action: "key", key: "Escape" }, { action: "invoke_element", ref: "unsupported:a1" }]), error => error instanceof BoxError && error.kind === "refused" && error.message.includes("before dispatch"));
        row.write = "refused_before_dispatch";
      } else {
        const result = await client.computer([{ action: "key", key: "Escape" }]);
        row.reported_outcome = (host === "legacy" ? legacy.computerOutcome : computerOutcome)(result, true);
        if (generation === "current") {
          assert.equal(row.reported_outcome, "unknown", "old host must preserve new daemon's uncertain write result");
          assert.equal(result.progress?.dispatch, "sent");
        }
        row.write = "wire_accepted_without_task_success_claim";
      }
      report.cases.push({ ...row, status: "pass" });
      console.log(`PASS ${host} host / ${generation} box`);
    }
    docker(["rm", "-f", container]);
    container = undefined;
  }
  report.status = "pass";
} catch (error) {
  report.status = "fail";
  report.error = String(error.message).replaceAll(credential, "[redacted]");
  process.exitCode = 1;
} finally {
  if (container) { try { docker(["rm", "-f", container]); } catch { report.cleanup_failed = true; process.exitCode = 1; } }
  rmSync(scratch, { recursive: true, force: true });
  report.finished_at = new Date().toISOString();
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Compatibility: ${report.status}; report ${reportPath}`);
}
