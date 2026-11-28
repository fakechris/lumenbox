/** The signing-identity gate (INV-2309): the verdict on what codesign prints, the dmg it mounts, and that nothing skips it. */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { developerIdProblems, signatureVerdict, signingRefusal } from "./signature.mjs";
import { signingFailure } from "./dist.mjs";

const verified = { code: 0, output: "" };
// What codesign printed for the 0.4.12 arm64 app as published.
const noResources = { code: 1, output: "/x/LumenBox.app: code has no resources but signature indicates they must be present\n" };
const adhoc = {
  code: 0,
  output:
    "Executable=/x/LumenBox.app/Contents/MacOS/LumenBox\nIdentifier=Electron\nFormat=app bundle with Mach-O thin (arm64)\n" +
    "CodeDirectory v=20400 size=392 flags=0x20002(adhoc,linker-signed) hashes=9+0 location=embedded\nSignature=adhoc\n" +
    "Info.plist=not bound\nTeamIdentifier=not set\nSealed Resources=none\nInternal requirements=none\n",
};
// What it printed for a correctly signed app (0.4.11, installed).
const developerId = {
  code: 0,
  output:
    "Executable=/x/LumenBox.app/Contents/MacOS/LumenBox\nIdentifier=io.lumenbox.app\nSignature size=9066\n" +
    "Authority=Developer ID Application: Example Co., Ltd. (A69VRB2X6U)\nAuthority=Developer ID Certification Authority\n" +
    "Authority=Apple Root CA\nTeamIdentifier=A69VRB2X6U\nSealed Resources version=2 rules=13 files=7768\n",
};
const otherTeam = { code: 0, output: developerId.output.replaceAll("A69VRB2X6U", "Q7ZX4KJ2PL") };

test("a Developer ID app of the project's team that verifies deep and strict is accepted", () => {
  assert.deepEqual(signatureVerdict(verified, developerId), { ok: true, problems: [], causes: [] });
});

test("ad-hoc, missing resources and the wrong team are each refused, saying what was found and why", () => {
  const asShipped = signatureVerdict(noResources, adhoc);
  assert.equal(asShipped.ok, false);
  assert.deepEqual(asShipped.problems, [
    "ad-hoc signed (Signature=adhoc, TeamIdentifier=not set), not Developer ID",
    'invalid (codesign --verify --deep --strict: "code has no resources but signature indicates they must be present")',
  ]);
  assert.deepEqual(signatureVerdict(verified, adhoc).causes, ["keychain"], "ad-hoc alone is refused, not only with broken resources");
  // Missing resources under an otherwise right signature: the verify alone refuses it.
  assert.deepEqual(signatureVerdict(noResources, developerId).causes, ["invalid"]);
  const wrongTeam = signatureVerdict(verified, otherTeam);
  assert.equal(wrongTeam.ok, false);
  assert.match(wrongTeam.problems[0], /team Q7ZX4KJ2PL .*not A69VRB2X6U/);
  assert.deepEqual(wrongTeam.causes, ["identity"]);
  const apple = { code: 0, output: developerId.output.replace("Developer ID Application:", "Apple Development:") };
  assert.match(signatureVerdict(verified, apple).problems[0], /not a Developer ID Application certificate/);
  assert.match(signatureVerdict(noResources, { code: 1, output: "/x: code object is not signed at all\n" }).problems[0], /^not signed/);
  assert.match(signingRefusal({ problems: asShipped.problems, causes: asShipped.causes }), /could not reach the Developer ID Application certificate in the keychain/);
});

/** A fake codesign/hdiutil: each app path answers as `answers[path]`; hdiutil attach puts a LumenBox.app in the mount point. */
function fakeTools(answers, calls = []) {
  return (command, args) => {
    calls.push([command, ...args]);
    if (command === "hdiutil" && args[0] === "attach") {
      const mount = args[args.indexOf("-mountpoint") + 1];
      mkdirSync(join(mount, "LumenBox.app"));
      answers[join(mount, "LumenBox.app")] = answers[args.at(-1)];
      return { code: 0, output: "" };
    }
    if (command === "hdiutil") return { code: 0, output: "" };
    const [verify, describe] = answers[args.at(-1)];
    return args[0] === "--verify" ? verify : describe;
  };
}

test("the app inside a dmg is read from a read-only mount that is detached after, and each artifact is named", () => {
  const dist = mkdtempSync(join(tmpdir(), "signature-"));
  const mountRoot = mkdtempSync(join(tmpdir(), "signature-mounts-"));
  const app = join(dist, "mac-arm64", "LumenBox.app");
  const dmg = join(dist, "LumenBox-0.4.12-arm64.dmg");
  const calls = [];
  const found = developerIdProblems([{ kind: "app", path: app }, { kind: "dmg", path: dmg }], dist, {
    run: fakeTools({ [app]: [verified, developerId], [dmg]: [noResources, adhoc] }, calls),
    mountRoot,
  });
  assert.deepEqual(found.problems.map(problem => problem.split(":")[0]), ["LumenBox-0.4.12-arm64.dmg (its LumenBox.app)", "LumenBox-0.4.12-arm64.dmg (its LumenBox.app)"]);
  const attach = calls.find(call => call[1] === "attach");
  assert.ok(attach.includes("-readonly") && attach.includes("-nobrowse"));
  assert.ok(calls.some(call => call[0] === "hdiutil" && call[1] === "detach" && call[2] === attach[attach.indexOf("-mountpoint") + 1]));
  assert.deepEqual(developerIdProblems([{ kind: "app", path: app }], dist, { run: fakeTools({ [app]: [verified, developerId] }) }).problems, []);
});

test("dist fails a --mac build that is not Developer-ID signed, unless DIST_SKIP_SIGNING_CHECK=1 says it is never published", () => {
  const dist = mkdtempSync(join(tmpdir(), "dist-signing-"));
  writeFileSync(join(dist, "LumenBox-0.4.12-arm64.dmg"), "");
  const refuse = () => ({ problems: ["LumenBox-0.4.12-arm64.dmg (its LumenBox.app): ad-hoc signed"], causes: ["keychain"] });
  assert.match(signingFailure({}, dist, "0.4.12", refuse), /NOT SIGNED WITH THE DEVELOPER ID .*ad-hoc signed.*keychain/);
  assert.equal(signingFailure({}, dist, "0.4.12", () => ({ problems: [], causes: [] })), undefined);
  assert.equal(signingFailure({ DIST_SKIP_SIGNING_CHECK: "1" }, dist, "0.4.12", refuse), undefined);
  assert.match(signingFailure({}, join(dist, "absent"), "0.4.12", refuse), /no LumenBox 0\.4\.12 app or dmg/);
});

test("release:check refuses an ad-hoc app with RELEASE_CHECK_SKIP_NOTARIZE=1 set", { timeout: 120_000 }, () => {
  // The script itself, with a codesign on PATH that answers as 0.4.12's app did: the skip that every
  // release on the publishing machine sets must not reach this gate.
  const root = fileURLToPath(new URL("..", import.meta.url));
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  const dist = mkdtempSync(join(tmpdir(), "release-check-signing-"));
  const resources = join(dist, "mac-arm64", "LumenBox.app", "Contents", "Resources", "app");
  mkdirSync(resources, { recursive: true });
  writeFileSync(join(resources, "package.json"), JSON.stringify({ version }));
  const bin = mkdtempSync(join(tmpdir(), "release-check-bin-"));
  const answers = join(bin, "answers");
  writeFileSync(`${answers}.verify`, noResources.output);
  writeFileSync(`${answers}.describe`, adhoc.output);
  writeFileSync(
    join(bin, "codesign"),
    `#!/bin/sh\nif [ "$1" = "--verify" ]; then cat '${answers}.verify' >&2; exit 1; fi\ncat '${answers}.describe' >&2\n`,
  );
  chmodSync(join(bin, "codesign"), 0o755);
  const run = spawnSync(process.execPath, [join(root, "scripts", "release-check.mjs")], {
    encoding: "utf8",
    timeout: 110_000,
    env: {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      HOME: process.env.HOME ?? "",
      AGENTBOX_TEST: "1",
      AGENTBOX_DIST_DIR: dist,
      RELEASE_CHECK_SKIP_NOTARIZE: "1",
      RELEASE_CHECK_SKIP_IMAGE: "1",
    },
  });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /FAIL every macOS app and dmg of this version is signed with the Developer ID of team A69VRB2X6U/);
  assert.match(run.stdout, /mac-arm64\/LumenBox\.app: ad-hoc signed \(Signature=adhoc, TeamIdentifier=not set\)/);
  assert.match(run.stdout, /notarization gate skipped \(spctl and stapler only/);
});
