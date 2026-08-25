/**
 * Tests for the check that runs before a box is destroyed.
 *
 * The value of this check is entirely in whether people read it, which makes both
 * failure directions matter. Missing a running job or a stray file means silent loss —
 * the report an agent wrote to the wrong directory simply stops existing. But reporting
 * things an upgrade does *not* destroy is not the harmless side: the first version listed
 * the image's own files and the desktop launchers, and the two files that actually
 * mattered were sitting in the middle of nine lines of noise.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { describePreflight, isQuiet, preflight } from "./preflight.ts";

/** A box that answers with whatever the test wants it to have found. */
const boxWith = (jobs: unknown[], found: string) =>
  ({
    jobs: async () => ({ jobs }),
    exec: async () => ({ stdout: found, stderr: "", exit_code: 0 }),
  }) as never;

test("a box with nothing to lose is quiet, and says nothing", async () => {
  const findings = await preflight(boxWith([], ""));
  assert.equal(isQuiet(findings), true);
  // A confirmation that always appears is one that is always dismissed, so the ordinary
  // upgrade has to produce no text at all.
  assert.equal(describePreflight(findings), "");
});

test("work still running is reported with enough to identify it", async () => {
  const findings = await preflight(
    boxWith([{ job_id: "j7", command: "npm run build", running: true }], "")
  );
  assert.equal(isQuiet(findings), false);
  const described = describePreflight(findings);
  // The command, not just a count: "1 job running" leaves the person no way to judge
  // whether it matters, which is the whole decision being asked of them.
  assert.match(described, /j7/);
  assert.match(described, /npm run build/);
});

test("a job that already finished is not a reason to stop", async () => {
  const findings = await preflight(
    boxWith([{ job_id: "j1", command: "done", running: false, exit_code: 0 }], "")
  );
  assert.equal(isQuiet(findings), true);
});

test("files outside the volumes are named, and say why they matter", async () => {
  const findings = await preflight(boxWith([], "/home/box/report.md\n/home/box/notes.txt\n"));
  assert.equal(isQuiet(findings), false);
  const described = describePreflight(findings);
  assert.match(described, /report\.md/);
  // Naming the two directories that do survive turns the warning into an instruction.
  assert.match(described, /\/home\/box\/work/);
});

test("a long list is cut, and says it was cut", async () => {
  const many = Array.from({ length: 40 }, (_, index) => `/home/box/f${index}`).join("\n");
  const findings = await preflight(boxWith([], many));
  assert.equal(findings.moreStrayFiles, true);
  assert.ok(findings.strayFiles.length <= 20);
  assert.match(describePreflight(findings), /and more/);
});

test("a box that cannot be asked reports that, rather than reporting nothing found", async () => {
  const broken = {
    jobs: async () => {
      throw new Error("connection refused");
    },
  } as never;
  const findings = await preflight(broken);

  // The distinction this exists for. "Nothing to lose" and "could not look" would
  // otherwise be the same empty result, and the second would silently authorise an
  // unattended upgrade of a box nobody could inspect.
  assert.equal(isQuiet(findings), false);
  assert.match(describePreflight(findings), /could not be checked/);
  assert.match(describePreflight(findings), /connection refused/);
});

test("verification does one real thing, because health alone proves too little", async () => {
  const { verifyBox } = await import("./preflight.ts");

  // The case that motivated it. A box with a broken browser still brings up its desktop
  // and still reports healthy — observed, not hypothesised: an image with box-chrome
  // pointed at a nonexistent binary printed "box ready: display :1" and passed health.
  const healthyButBroken = {
    health: async () => ({ ok: true }),
    browser: async () => {
      throw new Error("The browser did not start on desktop 1 within 30s.");
    },
  } as never;
  assert.match((await verifyBox(healthyButBroken)) ?? "", /browser could not be driven/);

  const dead = {
    health: async () => {
      throw new Error("connection refused");
    },
  } as never;
  assert.match((await verifyBox(dead)) ?? "", /did not answer/);

  const unhealthy = { health: async () => ({ ok: false }) } as never;
  assert.match((await verifyBox(unhealthy)) ?? "", /not healthy/);

  // A browser that answers but renders nothing is a failure too — otherwise the check
  // passes on a box where the debugging port works and the display does not.
  const blank = {
    health: async () => ({ ok: true }),
    browser: async () => ({ snapshot: "", url: "", title: "" }),
  } as never;
  assert.match((await verifyBox(blank)) ?? "", /did not render a known page/);

  const working = {
    health: async () => ({ ok: true }),
    browser: async () => ({ snapshot: '- heading "lumenbox upgrade check"', url: "", title: "ok" }),
  } as never;
  assert.equal(await verifyBox(working), undefined);
});
