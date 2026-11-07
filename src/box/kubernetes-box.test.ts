/**
 * An organisation installation's boxes as pods (INV-1692), with the API server substituted: the
 * per-box key over the control plane's one `KubeBoxes`, driven through the same `PersonalBoxes`
 * the server uses. The real-cluster run is scripts/k8s-org-boxes.ts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BoxEntry } from "./boxes.ts";
import { KubernetesBoxDriver, provisionedBoxDriver } from "./kubernetes-box.ts";
import { PersonalDocker } from "./personal.ts";
import { KubeBoxes } from "../control/kube-box.ts";
import { staticDecision } from "../control/policy.ts";
import { fakeKubeApi } from "../control/testing/fake-kube.ts";
import { PersonalBoxes } from "../host/personal-boxes.ts";

function fixture(fake = fakeKubeApi(), image = "fakechris/lumenbox:0.3.28") {
  const home = mkdtempSync(join(tmpdir(), "kube-org-boxes-"));
  const entries: BoxEntry[] = [];
  const kube = new KubeBoxes({ api: fake.api, namespace: "org", defaultImage: () => image, pollIntervalMs: 1, startTimeoutMs: 50 });
  const driver = new KubernetesBoxDriver({ boxes: kube, image, decision: staticDecision({ memory: "2Gi", storage: "1Gi" }) });
  const open = (with_ = driver) =>
    new PersonalBoxes({
      home, entries: () => entries, quota: () => undefined, authorize: () => true,
      attach: entry => { const at = entries.findIndex(e => e.id === entry.id); if (at >= 0) entries[at] = entry; else entries.push(entry); },
      detach: id => { entries.splice(entries.findIndex(e => e.id === id), 1); },
      residents: () => 0, driver: with_,
    });
  return { home, fake, entries, kube, driver, open, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

test("each box is its own pod, volumes, secret and policy, reached at its own Service DNS", async () => {
  const { fake, entries, open, cleanup } = fixture();
  try {
    const boxes = open();
    const a = await boxes.create("alice", "r1");
    const b = await boxes.create("bob", "r1");
    assert.equal(a.status, "ready");
    assert.equal(b.status, "ready");
    // One box, one pod: the pod is named by the box record, so two records never share objects.
    for (const record of [a, b]) {
      assert.ok(fake.pods.has(record.name));
      assert.ok(fake.policies.has(record.name));
      assert.ok(fake.secrets.has(`${record.name}-tokens`));
      for (const volume of ["work", "config", "hostd"]) assert.ok(fake.pvcs.has(`${record.name}-${volume}`));
      const entry = entries.find(e => e.id === record.id)!;
      assert.equal(entry.endpoint?.baseUrl, `http://${record.name}.org.svc:1337`);
      assert.deepEqual(entry.members, [record.owner], "membership is the box entry's, decided by the installation");
    }
    assert.equal(fake.pods.size, 2);
    // Each pod reads its own token from its own Secret; neither token is in any pod spec.
    const tokenOf = (name: string) => Buffer.from(fake.secrets.get(`${name}-tokens`)!.data.BOXD_TOKEN!, "base64").toString();
    assert.notEqual(tokenOf(a.name), tokenOf(b.name));
    const specs = JSON.stringify([...fake.pods.values()]);
    assert.ok(!specs.includes(tokenOf(a.name)) && !specs.includes(tokenOf(b.name)));
    // Owner labels are hashes for an operator's kubectl; no other box's pod is admitted to this one.
    const labels = fake.pods.get(a.name)!.metadata.labels!;
    assert.match(labels["agentbox/box"] ?? "", /^[0-9a-f]{12}$/);
    assert.notEqual(labels["agentbox/owner"], fake.pods.get(b.name)!.metadata.labels!["agentbox/owner"]);
    assert.deepEqual((fake.policies.get(a.name)!.spec.ingress as unknown[])[0], { from: [{ podSelector: { matchLabels: { "agentbox/role": "control" } } }] });
    // The order a reader can hold the code to, per box: nothing references what does not exist yet.
    const order = fake.calls.filter(c => c.verb === "apply" && c.name.startsWith(a.name)).map(c => c.kind);
    assert.deepEqual(order, ["secret", "pvc", "pvc", "pvc", "service", "networkpolicy", "pod"]);
  } finally {
    cleanup();
  }
});

test("a box that cannot start says why, removes its secret and keeps its volumes", async () => {
  const { fake, open, cleanup } = fixture(fakeKubeApi({ waitingReason: "InvalidImageName" }));
  try {
    const record = await open().create("alice", "r1");
    assert.equal(record.status, "failed");
    assert.equal(record.stateReason, "InvalidImageName");
    assert.match(record.error ?? "", /InvalidImageName/);
    assert.match(record.stateMessage ?? "", /cannot start/);
    assert.equal(fake.pods.has(record.name), false);
    assert.equal(fake.secrets.has(`${record.name}-tokens`), false, "an orphaned secret is a credential nobody owns");
    assert.ok(fake.pvcs.has(`${record.name}-work`), "volumes are data and stay");
  } finally {
    cleanup();
  }
});

test("after a server restart a lost pod is recreated on its volumes with its token; a gone box is marked, not hidden", async () => {
  const { fake, open, cleanup } = fixture();
  try {
    const first = open();
    const a = await first.create("alice", "r1");
    const b = await first.create("bob", "r1");
    const token = fake.secrets.get(`${a.name}-tokens`)!.data.BOXD_TOKEN;
    fake.pods.delete(a.name); // the node lost it while the server was down
    for (const suffix of ["work", "config", "hostd"]) fake.pvcs.delete(`${b.name}-${suffix}`);
    fake.pods.delete(b.name);
    fake.services.delete(b.name); // and someone deleted b outright

    const lines: string[] = [];
    const restarted = open();
    await restarted.recover(line => lines.push(line));
    assert.ok(fake.pods.has(a.name), "the pod is back");
    assert.equal(fake.secrets.get(`${a.name}-tokens`)!.data.BOXD_TOKEN, token, "with the token the server holds");
    assert.ok(lines.some(line => line.includes(a.name) && line.includes("restarted")));
    const after = (owner: string) => restarted.list(owner)[0]!;
    assert.equal(after("alice").status, "ready");
    assert.equal(after("bob").status, "failed");
    assert.equal(after("bob").stateReason, "Gone");
  } finally {
    cleanup();
  }
});

test("a pod launched from another configuration is reported as drifted, never rebuilt on its own", async () => {
  const fake = fakeKubeApi();
  const { home, open, cleanup } = fixture(fake, "fakechris/lumenbox:0.3.28");
  try {
    const record = await open().create("alice", "r1");
    const applies = fake.calls.filter(c => c.verb === "apply" && c.kind === "pod").length;
    const upgraded = fixture(fake, "fakechris/lumenbox:0.3.29");
    const lines: string[] = [];
    await new PersonalBoxes({ home, entries: () => [], quota: () => undefined, authorize: () => true, attach: () => {}, detach: () => {}, residents: () => 0, driver: upgraded.driver })
      .recover(line => lines.push(line));
    upgraded.cleanup();
    assert.ok(lines.some(line => line.includes(record.name) && line.includes("drifted")));
    assert.equal(fake.calls.filter(c => c.verb === "apply" && c.kind === "pod").length, applies, "rebuilding is a person's call");
  } finally {
    cleanup();
  }
});

test("the launch digest names the secret, not its value: a rotated token is not drift, a new image is", () => {
  const { kube, driver, home, cleanup } = fixture();
  try {
    const record = { id: "box_1", owner: "alice", request: "r", name: "personal-1", tokenFile: join(home, "t"), status: "ready" as const, createdAt: "" };
    const one = kube.digestOf(driver.placement(record, "token-one"));
    assert.equal(kube.digestOf(driver.placement(record, "token-two")), one);
    assert.notEqual(kube.digestOf({ ...driver.placement(record, "token-one"), spec: { image: "other:1" } }), one);
  } finally {
    cleanup();
  }
});

test("removing keeps or takes the data as asked", async () => {
  const { fake, open, cleanup } = fixture();
  try {
    const boxes = open();
    const record = await boxes.create("alice", "r1");
    await boxes.remove("alice", record.id, false);
    assert.equal(fake.pods.has(record.name), false);
    assert.ok(fake.pvcs.has(`${record.name}-work`) && fake.secrets.has(`${record.name}-tokens`), "kept: volumes and secret");
    await boxes.retry("alice", record.id);
    await boxes.remove("alice", record.id, true);
    assert.equal(fake.pvcs.size + fake.secrets.size + fake.policies.size + fake.services.size + fake.pods.size, 0, "deleted: nothing left");
  } finally {
    cleanup();
  }
});

test("kubernetes is a server's backend: the desktop app refuses it, and docker stays the default", (t) => {
  const api = fakeKubeApi().api;
  // The pinned image, named, so choosing the driver reads no installation config under test.
  const previous = process.env.AGENTBOX_IMAGE;
  process.env.AGENTBOX_IMAGE = "fakechris/lumenbox:0.3.28";
  t.after(() => { if (previous === undefined) delete process.env.AGENTBOX_IMAGE; else process.env.AGENTBOX_IMAGE = previous; });
  assert.ok(provisionedBoxDriver(false, { api, env: {} }) instanceof PersonalDocker);
  assert.ok(provisionedBoxDriver(false, { api, env: { AGENTBOX_BOX_BACKEND: "kubernetes" } }) instanceof KubernetesBoxDriver);
  assert.throws(() => provisionedBoxDriver(true, { api, env: { AGENTBOX_BOX_BACKEND: "kubernetes" } }), /server installation/);
  assert.throws(() => provisionedBoxDriver(false, { api, env: { AGENTBOX_BOX_BACKEND: "nomad" } }), /docker or kubernetes/);
});
