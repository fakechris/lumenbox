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
const FLOOR = Number(process.env.AGENTBOX_TEST_FLOOR ?? 1030);
/** How far above the floor the suite may sit before the floor is called stale. */
const STALE_MARGIN = 40;

const child = spawn(
  process.execPath,
  [
    "--experimental-transform-types",
    // In place before the first test module: a test may not reach the network.
    "--import",
    fileURLToPath(new URL("./test-network-guard.mjs", import.meta.url)),
    "--test",
    "--test-reporter=tap",
    "--test-timeout=30000",
    "src/**/*.test.ts",
  ],
  // An allowlisted environment, not this shell's: see scripts/test-env.mjs. The run
  // must not be able to read a credential that happens to be exported here, and must
  // not be able to reach the live installation in ~/.agentbox.
  { stdio: ["ignore", "pipe", "inherit"], env: hermeticEnv() }
);

let output = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", chunk => {
  output += chunk;
  process.stdout.write(chunk);
});

const code = await new Promise(resolve => child.on("close", resolve));

// From the TAP summary rather than by counting `ok` lines: subtests each emit one, so counting lines
// would inflate the number and make the floor meaningless.
const pass = Number(/^# pass (\d+)$/m.exec(output)?.[1] ?? 0);
const fail = Number(/^# fail (\d+)$/m.exec(output)?.[1] ?? 0);
const total = Number(/^# tests (\d+)$/m.exec(output)?.[1] ?? 0);

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
