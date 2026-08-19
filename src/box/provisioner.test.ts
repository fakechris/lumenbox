/**
 * Tests for where a box comes from.
 *
 * The point of these is the seam itself: the core must be able to reach a box it did not
 * start, on a machine with no Docker, because that is what every deployment other than a
 * developer's laptop looks like.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AttachedBoxProvisioner,
  DockerBoxProvisioner,
  resolveBoxProvisioner,
} from "./provisioner.ts";

/** A home with a token in it, so the token file path is exercised too. */
function withTokenFile(token: string): void {
  const home = mkdtempSync(join(tmpdir(), "agentbox-prov-"));
  process.env.AGENTBOX_HOME = home;
  writeFileSync(join(home, "token"), `${token}\n`, "utf8");
  delete process.env.AGENTBOX_TOKEN;
}

test("a URL selects the attached provisioner, with no Docker involved", async () => {
  withTokenFile("token-from-file");
  process.env.AGENTBOX_BOXD_URL = "http://box.agentbox.svc:1337";

  const provisioner = resolveBoxProvisioner();
  assert.equal(provisioner.kind, "attached");
  assert.match(provisioner.label, /box\.agentbox\.svc:1337/);
  assert.deepEqual(await provisioner.endpoint(), {
    baseUrl: "http://box.agentbox.svc:1337",
    token: "token-from-file",
  });
});

test("no URL falls back to Docker", () => {
  withTokenFile("token-from-file");
  delete process.env.AGENTBOX_BOXD_URL;

  const provisioner = resolveBoxProvisioner();
  assert.equal(provisioner.kind, "docker");
  assert.match(provisioner.label, /docker \(/);
});

test("a trailing slash does not become a double slash in every request path", async () => {
  const provisioner = new AttachedBoxProvisioner({
    baseUrl: "http://box:1337/",
    token: "t",
  });
  assert.equal((await provisioner.endpoint()).baseUrl, "http://box:1337");
});

test("attaching without a token fails immediately, not on the first tool call", () => {
  const home = mkdtempSync(join(tmpdir(), "agentbox-prov-empty-"));
  process.env.AGENTBOX_HOME = home;
  delete process.env.AGENTBOX_TOKEN;

  assert.throws(
    () => new AttachedBoxProvisioner({ baseUrl: "http://box:1337" }),
    /No box token/
  );
});

test("the Docker provisioner reports no endpoint rather than throwing", async () => {
  // What a machine with no engine, or no container yet, looks like. The caller says
  // "box unavailable" once; it does not need to tell those apart.
  const provisioner = new DockerBoxProvisioner({
    containerName: "agentbox-does-not-exist",
    image: "agentbox/box:latest",
    boxdPort: 0,
    token: "t".repeat(20),
    host: "127.0.0.1",
    displayWidth: 1280,
    displayHeight: 800,
    runArgs: [],
  });

  assert.equal(await provisioner.endpoint(), undefined);
});
