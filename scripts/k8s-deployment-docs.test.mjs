import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("../", import.meta.url);
const deploy = new URL("deploy/kubernetes/", root);
const read = (file, base = deploy) => readFileSync(new URL(file, base), "utf8");

test("the Kubernetes manifest deploys the release image for both the control plane and new boxes", () => {
  const { version } = JSON.parse(read("package.json", root));
  const image = `fakechris/lumenbox:${version}`;
  const manifest = read("control-plane.yaml");
  assert.equal(/^\s+image: (\S+)$/m.exec(manifest)?.[1], image, "update the Deployment image when bumping package.json");
  assert.equal(/^\s+AGENTBOX_IMAGE: "([^"]+)"$/m.exec(manifest)?.[1], image, "update the box image when bumping package.json");
});

test("the documented gateway account command sends the saved password to kubectl without printing it", () => {
  const command = /^```bash\n([^`]*kubectl -n agentbox create secret generic agentbox-control-users[^`]*)^```$/m.exec(read("README.md"))?.[1];
  assert.ok(command, "README must show how to create the gateway users Secret");
  const password = "test123Password";
  const script = `kubectl() { printf "%s\\n" "$@" >&3; echo "secret/agentbox-control-users created"; }\n${command}`;
  const result = spawnSync("bash", ["-ec", script], {
    input: `${password}\n`, encoding: "utf8", stdio: ["pipe", "pipe", "pipe", "pipe"],
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.output[3].trimEnd().split("\n"), [
    "-n", "agentbox", "create", "secret", "generic", "agentbox-control-users",
    `--from-literal=AGENTBOX_CONTROL_USERS=admin:${password}:default`,
  ]);
  assert.equal(result.stdout.trim(), "secret/agentbox-control-users created");
  assert.equal(result.stderr, "");
});

test("the documented organisation Secret command gives the server a DingTalk app without printing its secret (INV-2227)", () => {
  const command = /^```bash\n([^`]*kubectl -n agentbox create secret generic agentbox-organisation-env[^`]*)^```$/m.exec(read("README.md"))?.[1];
  assert.ok(command, "README must show how to create the Secret organisation.yaml reads with envFrom");
  const script = `kubectl() { printf "%s\\n" "$@" >&3; echo "secret/agentbox-organisation-env created"; }\n${command}`;
  const result = spawnSync("bash", ["-ec", script], {
    input: "ding-app\nding-s3cret\n", encoding: "utf8", stdio: ["pipe", "pipe", "pipe", "pipe"],
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.output[3].trimEnd().split("\n"), [
    "-n", "agentbox", "create", "secret", "generic", "agentbox-organisation-env",
    "--from-literal=DINGTALK_CLIENT_ID=ding-app", "--from-literal=DINGTALK_CLIENT_SECRET=ding-s3cret",
  ]);
  assert.equal(result.stdout.trim(), "secret/agentbox-organisation-env created");
  assert.equal(result.stderr, "");
  // The manifest names the same Secret and the same variables, and the callback the vendor needs.
  const manifest = read("organisation.yaml");
  assert.match(manifest, /secretRef:\n\s+name: agentbox-organisation-env/);
  for (const name of ["DINGTALK_CLIENT_ID", "DINGTALK_CLIENT_SECRET", "FEISHU_APP_ID", "FEISHU_APP_SECRET", "/auth/dingtalk/callback", "/auth/feishu/callback"]) {
    assert.ok(manifest.includes(name) && read("README.md").includes(name), `organisation.yaml and README.md name ${name}`);
  }
});
