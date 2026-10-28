/**
 * Runs the test suite and refuses to pass if fewer tests ran than expected.
 *
 * The failure this exists for: a test file that stops being *found* does not fail. Measured on this
 * project — moving one file aside gives `# tests 199, # fail 0`, a green run with ten tests quietly
 * gone; a glob that matches nothing gives `# tests 0`, also green. A renamed directory, a moved
 * file, an edited glob: each shrinks coverage while the build stays green and nobody reads the
 * number.
 *
 * What it does *not* need to catch, checked rather than assumed: a file that throws while being
 * imported. Node 22's runner reports that as a failing test (`# fail 1`), so it is already loud.
 *
 * So the count is a floor, checked in CI. When the floor is passed legitimately — new tests — the
 * number here goes up in the same commit, which makes "I deleted tests" a visible diff rather than
 * an invisible one.
 *
 * Deliberately a floor and not an exact match: an exact number would fail every commit that adds a
 * test, which trains people to edit the number without thinking, which defeats the purpose.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { hermeticEnv } from "./test-env.mjs";
import { underOsNetworkDeny } from "./test-sandbox.mjs";

/**
 * Raise this when adding tests. Lowering it needs a reason in the commit message.
 *
 * Set below the current count so a legitimate refactor that merges two tests into one does not fail
 * the build, but close enough that deleting a file is caught.
 *
 * "Close enough" is the part that decayed: the floor sat at 200 while 984 tests ran, so four fifths
 * of the suite could have vanished under a green tick — the exact failure this file was written to
 * prevent, arrived at by neglect rather than by design (audit 2026-09-01). A number a person has to
 * remember to raise is a number that goes stale, so staleness is now itself reported: passing far
 * above the floor prints how to raise it, every run, until somebody does.
 */
const FLOOR = Number(process.env.AGENTBOX_TEST_FLOOR ?? 2634);
/** How far above the floor the suite may sit before the floor is called stale. */
const STALE_MARGIN = 40;

/** The runner for one set of test files: the guard first, the OS sandbox around, TAP out. */
function runnerFor(globs) {
  return underOsNetworkDeny(process.execPath, [
    "--experimental-transform-types",
    // In place before the first test module: a test may not reach the network.
    "--import",
    fileURLToPath(new URL("./test-network-guard.mjs", import.meta.url)),
    "--test",
    "--test-reporter=tap",
    "--test-timeout=30000",
    ...globs,
  ]);
}

/** Runs one set of files under the hermetic environment and returns its exit code and TAP. */
function runFiles(runner) {
  return new Promise(resolve => {
    const child = spawn(
      runner.command,
      runner.args,
      // An allowlisted environment, not this shell's: see scripts/test-env.mjs. The run
      // must not be able to read a credential that happens to be exported here, and must
      // not be able to reach the live installation in ~/.agentbox.
      { stdio: ["ignore", "pipe", "inherit"], env: { ...hermeticEnv(), AGENTBOX_TEST_OS_NET: runner.osNet } }
    );
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      output += chunk;
      process.stdout.write(chunk);
    });
    child.on("close", code => resolve({ code, output }));
  });
}

const summary = tap => ({
  pass: Number(/^# pass (\d+)$/m.exec(tap)?.[1] ?? 0),
  fail: Number(/^# fail (\d+)$/m.exec(tap)?.[1] ?? 0),
  total: Number(/^# tests (\d+)$/m.exec(tap)?.[1] ?? 0),
});

const main = runnerFor([
  "src/**/*.test.ts",
  // The documents are checked like the code is: two of them claiming one number, or one
  // domain, is the same class of defect as two functions claiming one name.
  "scripts/*.test.mjs",
]);
console.error(
  main.osNet === "denied"
    ? `[test-floor] network: denied by the OS (${main.why}); loopback open; the in-process guard is the second layer`
    : `[test-floor] network: NOT denied by the OS — ${main.why}; only the in-process guard (fetch/http/https/net/tls) is in force. ` +
        "A spawned curl or git could reach out from a test on this machine; CI denies it."
);
const first = await runFiles(main);

// The sweeps (`*.sweep.ts`, INV-1332) run after the parallel suite, alone: each starts a dozen
// hosts as child processes and kills them, which beside a hundred concurrent test files is
// enough load to push unrelated files over the per-test clock, and to be pushed over it itself.
// Alone they take seconds. Their tests count toward the floor like any other.
console.error("[test-floor] sweeps: the crash sweep runs after the suite, alone");
const second = await runFiles(runnerFor(["src/**/*.sweep.ts"]));

const code = first.code !== 0 ? first.code : second.code;
const counts = [summary(first.output), summary(second.output)];
const pass = counts[0].pass + counts[1].pass;
const fail = counts[0].fail + counts[1].fail;
const total = counts[0].total + counts[1].total;

// Counted from the TAP summaries rather than by counting `ok` lines: subtests each emit one, so
// counting lines would inflate the number and make the floor meaningless.
if (code !== 0 || fail > 0) {
  console.error(`\n[test-floor] ${fail} test(s) failed.`);
  process.exit(1);
}

if (total === 0) {
  // Distinguished from "below the floor" because it means something different: the runner found
  // nothing at all, which is usually a glob or a working-directory problem, not lost tests.
  console.error(
    "\n[test-floor] No tests ran at all. The glob matched nothing, or every file failed to import."
  );
  process.exit(1);
}

if (pass < FLOOR) {
  console.error(
    `\n[test-floor] Only ${pass} tests ran; the floor is ${FLOOR}.\n` +
      "A test file that throws while being imported contributes no tests and does not fail, so a\n" +
      "shrinking suite looks green. Either a file stopped loading, or tests were removed — if the\n" +
      "latter was intended, lower AGENTBOX_TEST_FLOOR in scripts/test-floor.mjs and say why."
  );
  process.exit(1);
}

if (pass > FLOOR + STALE_MARGIN) {
  // Not a failure: a green build that has grown its suite is a good build. But a floor
  // this far below the truth protects nothing, and the only reason it decayed to a
  // fifth of the count is that nothing ever said so.
  console.log(
    `\n[test-floor] ${pass} tests ran against a floor of ${FLOOR} — the floor is stale and ` +
      `guards little.\n[test-floor] Raise it in scripts/test-floor.mjs (FLOOR = ${pass - 5}) in ` +
      `the commit that added the tests.`
  );
} else {
  console.log(`\n[test-floor] ${pass} tests ran, floor ${FLOOR}. OK.`);
}
