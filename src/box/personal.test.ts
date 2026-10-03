import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { personalBoxConfig } from "./personal.ts";
import { BoxManager } from "./docker.ts";

test("personal Docker configuration never inherits installation credentials, host runtime or publication overrides", () => {
  const home = mkdtempSync(join(tmpdir(), "personal-config-"));
  const previous = { ...process.env };
  try {
    process.env.AGENTBOX_HOME = home;
    process.env.AGENTBOX_TOKEN = "installation-fixture";
    process.env.AGENTBOX_EGRESS_RELAY = "http://installation.invalid";
    process.env.AGENTBOX_EGRESS_TOKEN = "installation-egress-fixture";
    process.env.AGENTBOX_BOXD_PUBLISH_ADDRESS = "0.0.0.0";
    const tokenFile = join(home, "personal.token");
    writeFileSync(tokenFile, "unique-personal-fixture");
    const config = personalBoxConfig({
      id: "box_fixture",
      name: "personal-fixture",
      owner: "alice",
      request: "one",
      tokenFile,
      status: "provisioning",
      createdAt: new Date().toISOString(),
    });
    const args = new BoxManager(config).runArguments();
    assert.equal(config.withHost, false);
    assert.deepEqual(config.runArgs, []);
    assert.ok(args.includes("BOXD_TOKEN=unique-personal-fixture"));
    assert.ok(args.includes("127.0.0.1::1337"));
    assert.ok(!args.join(" ").includes("installation"));
    assert.ok(!args.includes("--privileged"));
    assert.ok(!args.some((a) => a.includes("docker.sock")));
  } finally {
    process.env = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
