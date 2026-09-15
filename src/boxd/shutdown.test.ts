/**
 * The daemon must actually exit on SIGTERM (S7-A).
 *
 * Regression test for the shutdown hang: teach.shutdown() waiting forever on a recorder,
 * or server.close() waiting on a keep-alive socket the host's agent holds open. The fix
 * bounds every stage and hard-exits past the deadline; here the real daemon is spawned,
 * given an idle keep-alive connection (the exact condition that used to pin it), and
 * must be gone within the hard deadline.
 *
 * Hermetic on every platform: the child gets fully temporary service directories and a
 * no-op start-display, and binds loopback only. On a real Linux box this matters —
 * with the default recordings dir the child's orphan-reclamation would scan /proc and
 * SIGTERM whatever ffmpeg is writing into that directory, and a real start-display
 * would be executed. The child must never gain the power to touch a live environment
 * just because the platform has /proc.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { get as httpGet, Agent as HttpAgent } from "node:http";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Matches SHUTDOWN_HARD_DEADLINE_MS in main.ts, with margin for the boot below. */
const MUST_EXIT_WITHIN_MS = 20_000;

/** A launcher that does nothing, so no desktop component is ever started for real. */
const NOOP_LAUNCHER = ["/usr/bin/true", "/bin/true"].find(candidate => existsSync(candidate)) ?? "/usr/bin/true";

function startBoxd(envExtra: Record<string, string>): ChildProcess {
  return spawn(process.execPath, ["--experimental-transform-types", "src/boxd/main.ts"], {
    cwd: REPO_ROOT,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      BOXD_TOKEN: "shutdown-test-token-0123456789abcdef",
      BOXD_PORT: "0", // ephemeral: the log line carries the bound port
      BOXD_BIND: "127.0.0.1", // loopback only, even where the default would be 0.0.0.0
      BOXD_START_DISPLAY: NOOP_LAUNCHER,
      ...envExtra, // HOME and all service dirs come from the caller, all under the test's temp base
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function waitForListening(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`boxd did not listen within 10s. Output:\n${out}`)), 10_000);
    child.stdout!.on("data", chunk => {
      out += chunk.toString();
      // "[^ ]*" so the port comes from the host:pair, not from "display :1" later in the line.
      const match = /listening on [^ ]*:(\d+)/.exec(out);
      if (match !== null) {
        clearTimeout(timer);
        resolve(match[1]!);
      }
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`boxd exited before listening (code ${code}, signal ${signal}). Output:\n${out}`));
    });
  });
}

test("SIGTERM exits the daemon within the hard deadline even with a live keep-alive socket", async t => {
  const base = mkdtempSync(join(tmpdir(), "agentbox-boxd-test-"));
  const dirs = {
    data: join(base, "data"),
    recordings: join(base, "recordings"),
    teach: join(base, "teach"),
    home: join(base, "home"),
    spool: join(base, "spool"),
    jobs: join(base, "jobs"),
    logs: join(base, "logs"),
  };
  const child = startBoxd({
    HOME: dirs.home,
    BOXD_DATA_DIR: dirs.data,
    BOXD_RECORDINGS_DIR: dirs.recordings,
    BOXD_TEACH_DIR: dirs.teach,
    // The startup spool sweep, the jobs store, and the desktop-component log rotation
    // all point into the temp base: with the defaults the child would reap a live box's
    // spool, read its jobs, and copy/truncate its /tmp component logs if the supervisor
    // ever runs (the isolated daemon test path).
    BOXD_SPOOL_SWEEP_DIR: dirs.spool,
    BOXD_JOBS_DIR: dirs.jobs,
    BOXD_COMPONENT_LOG_DIR: dirs.logs,
  });
  const agent = new HttpAgent({ keepAlive: true });
  // Whatever happens below, the daemon must not outlive the test — a live child with
  // open pipes pins the test runner the way a hung daemon pins the supervisor.
  t.after(() => {
    agent.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    rmSync(base, { recursive: true, force: true });
  });
  const port = await waitForListening(child);

  // The condition that used to pin the process: a pooled keep-alive connection that
  // stays open after its response, so server.close() has a socket to wait on.
  await new Promise<void>((resolve, reject) => {
    const request = httpGet({ host: "127.0.0.1", port: Number(port), path: "/health", agent }, response => {
      response.resume();
      resolve();
    });
    request.on("error", reject);
  });

  const sigtermAt = Date.now();
  child.kill("SIGTERM");
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`boxd did not exit within ${MUST_EXIT_WITHIN_MS}ms of SIGTERM`));
    }, MUST_EXIT_WITHIN_MS);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  const elapsed = Date.now() - sigtermAt;

  assert.equal(exit.signal, null, "the process exits on its own, not by the test's SIGKILL");
  assert.equal(exit.code, 0, "a bounded shutdown exits 0");
  assert.ok(elapsed < MUST_EXIT_WITHIN_MS, `exited in ${elapsed}ms`);
});
