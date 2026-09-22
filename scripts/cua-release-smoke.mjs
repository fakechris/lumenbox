/** Run the standard smoke suite against one explicit image in an isolated box. */
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const image = process.env.CUA_RELEASE_IMAGE;
if (!image || image.endsWith(":latest")) throw new Error("Set CUA_RELEASE_IMAGE to an explicit version tag or image ID, not :latest.");
const reportPath = process.env.CUA_RELEASE_REPORT ?? ".runtime/cua-release-smoke.json";
const credential = randomBytes(32).toString("hex");
const name = `lumenbox-cua-release-${process.pid}`;
const scratch = mkdtempSync(join(tmpdir(), "lumenbox-cua-release-"));
const env = { ...process.env, BOXD_TOKEN: credential, AGENTBOX_TOKEN: credential, AGENTBOX_HOME: scratch };
const docker = args => execFileSync("docker", args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const report = { version: 1, started_at: new Date().toISOString(), image, source_commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), source_dirty: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim() !== "", status: "environment_error" };
let child;
const stop = () => child?.kill("SIGKILL");
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
try {
  report.image_id = docker(["image", "inspect", "--format", "{{.Id}}", image]);
  docker(["run", "-d", "--name", name, "--shm-size=1g", "-p", "127.0.0.1::1337", "-e", "BOXD_TOKEN", report.image_id]);
  const port = docker(["port", name, "1337/tcp"]).split(":").at(-1);
  env.AGENTBOX_BOXD_URL = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 90; i++) {
    try {
      const response = await fetch(`${env.AGENTBOX_BOXD_URL}/health`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) {
        const health = await response.json();
        if (health.resolution) {
          report.health = { protocol: health.protocol, desktop_contract: health.desktop_contract, desktop_driver: health.desktop_driver };
          ready = true;
          break;
        }
      }
    } catch { /* The new box may still be starting. */ }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (!ready) throw new Error("Isolated smoke box did not become ready");
  console.log(`Running standard smoke in temporary box (${report.image_id})`);
  child = spawn(process.execPath, ["--experimental-transform-types", "scripts/smoke.mjs"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", exceeded = false;
  const collect = data => {
    if (output.length + data.length > 4 * 1024 * 1024) { exceeded = true; stop(); }
    else output += data.toString();
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  let expired = false;
  const deadline = setTimeout(() => { expired = true; stop(); }, 600_000);
  let code;
  try { code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); }); }
  finally { clearTimeout(deadline); }
  const safeOutput = output.replaceAll(credential, "[redacted]");
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(`${reportPath}.log`, safeOutput);
  process.stdout.write(safeOutput);
  const summary = safeOutput.match(/(\d+) passed, (\d+) failed/);
  report.counts = summary ? { passed: Number(summary[1]), failed: Number(summary[2]) } : null;
  report.exit_code = code;
  report.timed_out = expired;
  report.output_limit_exceeded = exceeded;
  report.status = code === 0 && summary && Number(summary[2]) === 0 && !expired && !exceeded ? "pass" : "fail";
  report.coverage_note = "Standard smoke has conditional checks; inspect the log. Unconfigured egress relay is not relay coverage.";
  process.exitCode = report.status === "pass" ? 0 : 1;
} catch (error) {
  report.error = String(error.message).replaceAll(credential, "[redacted]");
  process.exitCode = 1;
} finally {
  try { docker(["rm", "-f", name]); report.container_removed = true; }
  catch { report.container_removed = false; report.status = "environment_error"; process.exitCode = 1; }
  rmSync(scratch, { recursive: true, force: true });
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
  report.finished_at = new Date().toISOString();
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Release smoke: ${report.status}; report ${reportPath}`);
}
