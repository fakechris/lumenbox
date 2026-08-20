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

/**
 * Raise this when adding tests. Lowering it needs a reason in the commit message.
 *
 * Set below the current count so a legitimate refactor that merges two tests into one does not fail
 * the build, but close enough that deleting a file is caught.
 */
const FLOOR = Number(process.env.AGENTBOX_TEST_FLOOR ?? 200);

const child = spawn(
  process.execPath,
  ["--experimental-transform-types", "--test", "--test-reporter=tap", "--test-timeout=30000", "src/**/*.test.ts"],
  { stdio: ["ignore", "pipe", "inherit"] }
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

console.log(`\n[test-floor] ${pass} tests ran, floor ${FLOOR}. OK.`);
