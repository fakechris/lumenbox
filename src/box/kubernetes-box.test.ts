/**
 * An organisation installation's boxes as pods (INV-1692), with the API server substituted: the
 * per-box key over the control plane's one `KubeBoxes`, driven through the same `PersonalBoxes`
 * the server uses. The real-cluster run is scripts/k8s-org-boxes.ts.
 */

import { quantityBytes } from "../control/policy.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BoxEntry } from "./boxes.ts";
import { KubernetesBoxDriver, provisionedBoxDriver } from "./kubernetes-box.ts";
import { PersonalDocker } from "./personal.ts";
import { KubeBoxes } from "../control/kube-box.ts";
import { KubernetesError, parseMinimalYaml } from "../control/kube-client.ts";
import { staticDecision } from "../control/policy.ts";
import { fakeKubeApi } from "../control/testing/fake-kube.ts";
import { PersonalBoxes } from "../host/personal-boxes.ts";
import { BoxdTokens } from "../boxd/token-store.ts";
import { boxTokenRoute } from "../web/box-token-routes.ts";
import type { RotatableBox } from "./token-rotation.ts";

function fixture(fake = fakeKubeApi(), image = "fakechris/lumenbox:0.3.28", log?: (line: string) => void) {
  const home = mkdtempSync(join(tmpdir(), "kube-org-boxes-"));
  const entries: BoxEntry[] = [];
  const kube = new KubeBoxes({ api: fake.api, namespace: "org", defaultImage: () => image, pollIntervalMs: 1, startTimeoutMs: 50 });
  const driver = new KubernetesBoxDriver({ boxes: kube, image, decision: staticDecision({ memory: "2Gi", storage: "1Gi" }), log });
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
      const container = (fake.pods.get(record.name)!.spec.containers as Record<string, unknown>[])[0]!;
      assert.deepEqual((container.readinessProbe as { httpGet: unknown }).httpGet, { path: "/health", port: 1337 });
      assert.ok(!(container.env as { name: string }[]).some(({ name }) => name === "AGENTBOX_INSECURE"));
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
    // INV-2040: the documented organisation server matches the box policy's pod selector.
    const deployment = readFileSync(new URL("../../deploy/kubernetes/organisation.yaml", import.meta.url), "utf8")
      .split(/^---$/m).find(doc => /^kind: Deployment$/m.test(doc));
    assert.ok(deployment);
    const manifest = parseMinimalYaml(deployment) as { metadata: { namespace: string }; spec: { template: { metadata: { labels: Record<string, string> } } } };
    assert.equal(manifest.metadata.namespace, "agentbox");
    assert.equal(manifest.spec.template.metadata.labels["agentbox/role"], "control");
    const rendered = parseMinimalYaml(deployment.replaceAll("fakechris/lumenbox:REPLACE_WITH_RELEASE_TAG", "registry.example/lumenbox:review")) as {
      spec: { template: { spec: { containers: { image: string; env: { name: string; value?: string }[] }[] } } };
    };
    const web = rendered.spec.template.spec.containers[0]!;
    assert.equal(web.image, "registry.example/lumenbox:review");
    assert.equal(web.env.find(variable => variable.name === "AGENTBOX_IMAGE")?.value, web.image);
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

test("INV-2052: namespace quota, admission, RBAC, and Pending give the member and operator distinct diagnostics", async () => {
  const cases = [
    ["ResourceQuota", "exceeded quota: pods=3", "namespace capacity"],
    // INV-2081: Kubernetes's own 403 wording for a quota and a LimitRange, which are not RBAC.
    ["ResourceQuota", 'pods "x" is forbidden: failed quota: compute: must specify limits.cpu', "LimitRange default"],
    ["LimitRange", 'pods "x" is forbidden: maximum memory usage per Container is 8Gi, but limit is 65Gi', "LimitRange and the box's resources"],
    ["LimitRange", 'pods "x" is forbidden: minimum cpu usage per Container is 100m, but request is 50m', "LimitRange and the box's resources"],
    ["AdmissionDenied", "admission webhook denied the request", "admission policy"],
    ["RBAC", "serviceaccount cannot create resource pods", "ServiceAccount"],
    ["ContainerCreating", undefined, "scheduling and container status"],
  ] as const;
  for (const [reason, message, nextStep] of cases) {
    const fake = fakeKubeApi({ waitingReason: message === undefined ? "ContainerCreating" : undefined });
    if (message) fake.api.applyPod = async () => { throw new KubernetesError(message, 403); };
    const lines: string[] = [];
    const { open, cleanup } = fixture(fake, undefined, line => lines.push(line));
    try {
      const record = await open().create("alice", "r1");
      assert.equal(record.status, "failed");
      assert.equal(record.stateReason, reason);
      assert.ok(record.error?.includes(message ?? "phase: Pending"));
      assert.ok(record.error?.includes(nextStep));
      assert.equal(lines.length, 1);
      assert.ok(lines[0]?.includes(record.name));
      assert.ok(lines[0]?.includes(message ?? "phase: Pending"));
    } finally {
      cleanup();
    }
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

test("a rotated token reaches the box's Secret once the box accepts it: a restarted pod and a re-created one both open with the token the host holds, wherever a crash stops it", async () => {
  const { fake, open, entries, home, cleanup } = fixture();
  try {
    const boxes = open();
    const record = await boxes.create("alice", "r1");
    const decode = (value: string | undefined) => Buffer.from(value ?? "", "base64").toString();
    const secretToken = () => decode(fake.secrets.get(`${record.name}-tokens`)!.data.BOXD_TOKEN);
    const hostToken = () => readFileSync(record.tokenFile, "utf8").trim();
    // The pod's config volume, which outlives the pod; a start reads BOXD_TOKEN from the Secret.
    const stateFile = join(home, "config-volume", "boxd-token.json");
    const start = () => new BoxdTokens(secretToken(), stateFile);
    let daemon = start(), held = hostToken();
    const first = held;
    const box: RotatableBox = {
      async rotateToken(next) { assert.equal(daemon.answer("POST /token/rotate", held, { token: next }).status, 200); },
      useToken(next) { held = next; },
      async confirmToken(overlapSeconds) { return daemon.answer("POST /token/confirm", held, { overlap_seconds: overlapSeconds }).body as { overlapUntil?: string }; },
    };
    // Every write of the Secret happens when the box already takes the token it carries and the host holds it.
    let failSecret = false;
    const applySecret = fake.api.applySecret.bind(fake.api);
    fake.api.applySecret = async secret => {
      const carried = decode(secret.data.BOXD_TOKEN);
      assert.ok(daemon.accepts(carried) && hostToken() === carried, "the Secret is never ahead of the box or of the host");
      if (failSecret) throw new Error("the apiserver said no");
      await applySecret(secret);
    };
    const rotate = async () => (await boxTokenRoute("POST /api/boxes/rotate-token", {
      boxes: () => entries, ownBoxId: "own", clientFor: () => box, provisioner: { kind: "attached" }, home, readJson: async () => ({ box: record.name }),
      refusedAdmin: () => false, by: () => "ann", record: () => {}, log: () => {}, keeperOf: id => boxes.tokenKeeper(id),
    }))!;

    assert.equal((await rotate()).status, 200);
    assert.notEqual(hostToken(), first);
    assert.equal(secretToken(), hostToken(), "the Secret carries the token the host holds");
    daemon = start();
    assert.ok(daemon.accepts(hostToken()) && !daemon.accepts(first), "a restarted pod opens with the new token only");
    fake.pods.delete(record.name);
    await open().recover(() => {});
    daemon = start();
    assert.equal(secretToken(), hostToken());
    assert.ok(daemon.accepts(hostToken()), "a re-created pod too");

    // The Secret cannot be written: the rotation still lands, says so, and the box still opens with the host's token.
    failSecret = true;
    const before = hostToken(), answer = await rotate();
    assert.equal(answer.status, 200);
    assert.match((answer.body as { note: string }).note, /was not updated \(the apiserver said no\)/);
    assert.equal(secretToken(), before, "the Secret still holds the old token");
    daemon = start();
    assert.ok(daemon.accepts(hostToken()), "a pod restarted now takes the new token from its config volume");
    failSecret = false;
    fake.pods.delete(record.name);
    await open().recover(() => {});
    daemon = start();
    assert.ok(secretToken() === hostToken() && daemon.accepts(hostToken()), "and a re-created pod is given it again from the token file");
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
  // What an activation's estimate multiplies (INV-2220): the memory the pod is placed with, as the operator set it.
  assert.deepEqual([provisionedBoxDriver(false, { api, env: { AGENTBOX_BOX_BACKEND: "kubernetes" } }).memoryRequest,
    provisionedBoxDriver(false, { api, env: { AGENTBOX_BOX_BACKEND: "kubernetes", AGENTBOX_K8S_MEMORY: "6Gi" } }).memoryRequest, provisionedBoxDriver(false, { api, env: {} }).memoryRequest], ["4Gi", "6Gi", undefined]);
  assert.deepEqual(["4Gi", "500Mi", "4096000000000m", "4g"].map(quantityBytes), [4 * 2 ** 30, 500 * 2 ** 20, 4096000000, undefined], "and in bytes, millibytes too; what is not a size is none");
  assert.throws(() => provisionedBoxDriver(true, { api, env: { AGENTBOX_BOX_BACKEND: "kubernetes" } }), /server installation/);
  assert.throws(() => provisionedBoxDriver(false, { api, env: { AGENTBOX_BOX_BACKEND: "nomad" } }), /docker or kubernetes/);
});
