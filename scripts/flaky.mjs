/**
 * The flaky-test gate (INV-1331): a fix for a test that failed only sometimes is believed when the
 * test passes 16 runs, 4 at a time, not when its author ran it twice.
 *
 * Two tests surfaced races this week only under the loaded full run (a files directory read
 * before a mismatched `.part` was removed; a write stream read before it flushed); each was green
 * alone and red on CI. Concurrency is what reproduces that, and sixteen runs is what makes a pass
 * mean something. The rule is borrowed from a harness whose bot runs it before every PR.
 *
 *   npm run flaky -- src/channels/tailmsg-door.test.ts [more files] [--runs 16] [--parallel 4]
 *
 * Every run is the same process `npm test` uses: the network guard imported first, the OS sandbox
 * where it works, the allowlisted environment. The first failing run's output is printed in full
 * and the exit code is 1; otherwise one line says 16/16.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { hermeticEnv } from "./test-env.mjs";
import { underOsNetworkDeny } from "./test-sandbox.mjs";

const args = process.argv.slice(2);
let runs = 16;
let parallel = 4;
const files = [];
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--runs") runs = Number(args[++i]);
  else if (arg === "--parallel") parallel = Number(args[++i]);
  else if (arg.startsWith("--runs=")) runs = Number(arg.slice(7));
  else if (arg.startsWith("--parallel=")) parallel = Number(arg.slice(11));
  else files.push(arg);
}
if (files.length === 0 || !Number.isInteger(runs) || runs < 1 || !Number.isInteger(parallel) || parallel < 1) {
  console.error("usage: npm run flaky -- <test-file>... [--runs 16] [--parallel 4]");
  process.exit(2);
}
const missing = files.filter(file => !existsSync(file));
if (missing.length > 0) {
  console.error(`[flaky] no such file: ${missing.join(", ")}`);
  process.exit(2);
}

const runner = underOsNetworkDeny(process.execPath, [
  "--experimental-transform-types",
  "--import",
  fileURLToPath(new URL("./test-network-guard.mjs", import.meta.url)),
  "--test",
  "--test-reporter=tap",
  "--test-timeout=30000",
  ...files,
]);
console.error(`[flaky] ${files.join(" ")}: ${runs} runs, ${parallel} at a time; network ${runner.osNet === "denied" ? "denied by the OS" : "NOT denied by the OS"} (${runner.why})`);

/** One run: its exit code and everything it printed, kept so the first failure can be shown whole. */
function once(index) {
  return new Promise(resolve => {
    const child = spawn(runner.command, runner.args, { stdio: ["ignore", "pipe", "pipe"], env: { ...hermeticEnv(), AGENTBOX_TEST_OS_NET: runner.osNet } });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    child.on("close", code => {
      const fail = Number(/^# fail (\d+)$/m.exec(output)?.[1] ?? 0);
      const pass = Number(/^# pass (\d+)$/m.exec(output)?.[1] ?? 0);
      resolve({ index, ok: code === 0 && fail === 0 && pass > 0, code, pass, fail, output });
    });
  });
}

const results = [];
let next = 0;
let firstFailure;
await Promise.all(
  Array.from({ length: Math.min(parallel, runs) }, async () => {
    while (next < runs && firstFailure === undefined) {
      const index = next++;
      const result = await once(index);
      results.push(result);
      if (!result.ok && firstFailure === undefined) firstFailure = result;
      process.stderr.write(result.ok ? "." : "F");
    }
  })
);
process.stderr.write("\n");

if (firstFailure !== undefined) {
  console.error(`[flaky] run ${firstFailure.index + 1} failed (exit ${firstFailure.code}, pass ${firstFailure.pass}, fail ${firstFailure.fail}); ${results.filter(r => r.ok).length}/${results.length} passed before stopping. Its output:\n`);
  process.stdout.write(firstFailure.output);
  process.exit(1);
}
const passes = results.filter(r => r.ok).length;
console.log(`[flaky] ${passes}/${runs} passed, ${parallel} at a time: ${files.join(" ")}`);
