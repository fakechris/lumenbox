/**
 * Tests for the kubernetes allocator, with the API server substituted.
 *
 * The same standard as compose: the suite passes with no cluster and no network, so `KubeApi` is
 * injected and the fake below is the contract the real client is held to. What is checked here is
 * everything that is not the wire: the names (which decide whose volumes a box inherits), the
 * manifests (which decide who can read a tenant's tokens), the recreate and stop/destroy
 * semantics, and that a policy decision lands where it was decided.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { containerNameFor } from "./compose.ts";
import type { KubeApi, KubePod, KubePvc, KubeSecret, KubeService } from "./kube-client.ts";
import { KubernetesAllocator } from "./kubernetes.ts";
import type { AllocationPolicy } from "./policy.ts";
import { staticPolicy } from "./policy.ts";
import { SqliteControlStore } from "./store.ts";

interface Call {
  verb: "apply" | "get" | "delete";
  kind: "pod" | "service" | "pvc" | "secret";
  name: string;
}

/**
 * An in-memory API server: remembers which objects "exist" and records every call.
 *
 * Pods become Ready the moment they are applied — the fake is a *kind* cluster where everything
 * schedules instantly — unless `neverReady` asks it to be the other kind (the timeout path's
 * whole test) or `podFate` asks for one of the ways a pod never becomes Ready at all.
 */
function fakeApi(
  options: {
    existingPods?: KubePod[];
    neverReady?: boolean;
    failPvcDelete?: string;
    failApplyService?: boolean;
    /** `vanished`: apply never lands. `failed` / `terminating`: the pod exists but cannot Ready. */
    podFate?: "vanished" | "failed" | "terminating";
  } = {}
) {
  const pods = new Map<string, KubePod>();
  const services = new Map<string, KubeService>();
  const pvcs = new Map<string, KubePvc>();
  const secrets = new Map<string, KubeSecret>();
  const calls: Call[] = [];

  for (const pod of options.existingPods ?? []) pods.set(pod.metadata.name, pod);

  const api: KubeApi = {
    async applyPod(pod) {
      calls.push({ verb: "apply", kind: "pod", name: pod.metadata.name });
      // A pod that never lands at all: the scheduler lost it between POST and the first poll.
      if (options.podFate === "vanished") return;
      // A real kubelet flips the Ready condition once the probe passes; the fake does it at
      // apply, so `waitReady` returns on its first poll.
      pods.set(pod.metadata.name, {
        ...pod,
        metadata: {
          ...pod.metadata,
          // Terminating: someone deleted the pod underneath the readiness wait.
          ...(options.podFate === "terminating"
            ? { deletionTimestamp: new Date().toISOString() }
            : {}),
        },
        status:
          options.podFate === "failed"
            ? { phase: "Failed" }
            : options.neverReady === true || options.podFate !== undefined
              ? { phase: "Pending" }
              : { phase: "Running", conditions: [{ type: "Ready", status: "True" }] },
      });
    },
    async getPod(name) {
      calls.push({ verb: "get", kind: "pod", name });
      return pods.get(name);
    },
    async deletePod(name) {
      calls.push({ verb: "delete", kind: "pod", name });
      pods.delete(name);
    },
    async applyService(service) {
      calls.push({ verb: "apply", kind: "service", name: service.metadata.name });
      if (options.failApplyService === true) throw new Error("the apiserver said no");
      services.set(service.metadata.name, service);
    },
    async getService(name) {
      calls.push({ verb: "get", kind: "service", name });
      return services.get(name);
    },
    async deleteService(name) {
      calls.push({ verb: "delete", kind: "service", name });
      services.delete(name);
    },
    async applyPvc(pvc) {
      calls.push({ verb: "apply", kind: "pvc", name: pvc.metadata.name });
      pvcs.set(pvc.metadata.name, pvc);
    },
    async getPvc(name) {
      calls.push({ verb: "get", kind: "pvc", name });
      return pvcs.get(name);
    },
    async deletePvc(name) {
      calls.push({ verb: "delete", kind: "pvc", name });
      if (options.failPvcDelete !== undefined && name.endsWith(options.failPvcDelete)) {
        throw new Error("pvc is still bound");
      }
      pvcs.delete(name);
    },
    async applySecret(secret) {
      calls.push({ verb: "apply", kind: "secret", name: secret.metadata.name });
      secrets.set(secret.metadata.name, secret);
    },
    async deleteSecret(name) {
      calls.push({ verb: "delete", kind: "secret", name });
      secrets.delete(name);
    },
  };
  return { api, pods, services, pvcs, secrets, calls };
}

function fixture(
  options: Parameters<typeof fakeApi>[0] & {
    relayUrl?: string;
    controlUrl?: string;
    namespace?: string;
    policy?: AllocationPolicy;
  } = {}
) {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-kubernetes-"));
  const store = new SqliteControlStore({ path: join(dir, "control.db") });
  const fake = fakeApi(options);
  const allocator = new KubernetesAllocator(store, {
    api: fake.api,
    image: "agentbox/box:test",
    relayUrl: options.relayUrl,
    controlUrl: options.controlUrl,
    namespace: options.namespace,
    policy: options.policy,
  });
  return {
    store,
    allocator,
    fake,
    cleanup() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("a tenant gets a pod, a service, three PVCs and a secret, all named and labelled", async () => {
  const { store, allocator, fake, cleanup } = fixture();
  try {
    const acme = store.upsertTenant({ name: "acme" });
    const handle = await allocator.allocate(acme.id, { image: "agentbox/box:test" });
    const name = containerNameFor("agentbox", "acme", acme.id);

    // The name is compose's: stable across restarts, DNS-1123-safe, and carrying the tenant id's
    // hash so two readable names can never collide into each other's volumes.
    assert.equal(handle.externalId, name);
    assert.match(name, /^agentbox-acme-[0-9a-f]{8}$/);
    assert.equal(handle.boxdUrl, `http://${name}.agentbox.svc:1337`);
    assert.equal(handle.uiUrl, `http://${name}.agentbox.svc:7777`);
    assert.equal(handle.state, "ready");

    assert.ok(fake.pods.has(name), "the pod exists");
    assert.ok(fake.services.has(name), "the service exists");
    for (const suffix of ["work", "config", "hostd"]) {
      assert.ok(fake.pvcs.has(`${name}-${suffix}`), `the ${suffix} PVC exists`);
    }
    assert.ok(fake.secrets.has(`${name}-tokens`), "the token secret exists");

    // Everything this allocator makes is labelled, so an operator's kubectl can ask what it owns
    // without knowing any names.
    const labels = fake.pods.get(name)?.metadata.labels ?? {};
    assert.equal(labels["app.kubernetes.io/managed-by"], "agentbox");
    assert.equal(labels["app.kubernetes.io/instance"], name);
    assert.match(labels["agentbox/tenant"] ?? "", /^[0-9a-f]{8}$/);

    // A box runs code its agents write; the pod asks the cluster for no credential of its own.
    const podSpec = fake.pods.get(name)!.spec;
    assert.equal(podSpec.automountServiceAccountToken, false);
    assert.equal(podSpec.enableServiceLinks, false);

    // Creation order: secret, PVCs, service, pod. The pod references the others by name, so they
    // exist first — and the order is what a reader of the calls can hold the code to.
    const kinds = fake.calls.filter(c => c.verb === "apply").map(c => c.kind);
    assert.deepEqual(kinds, ["secret", "pvc", "pvc", "pvc", "service", "pod"]);

    // And the service selects exactly this pod, no other tenant's.
    assert.deepEqual(fake.services.get(name)?.spec.selector, { "app.kubernetes.io/instance": name });
  } finally {
    cleanup();
  }
});

test("allocating twice returns the same box and creates nothing twice", async () => {
  const { store, allocator, fake, cleanup } = fixture();
  try {
    const acme = store.upsertTenant({ name: "acme" });
    const first = await allocator.allocate(acme.id, { image: "agentbox/box:test" });
    const second = await allocator.allocate(acme.id, { image: "agentbox/box:test" });

    assert.equal(first.id, second.id);
    assert.equal(
      fake.calls.filter(c => c.verb === "apply" && c.kind === "pod").length,
      1,
      "a retried allocate must not re-create the pod — idempotency is the property that makes a " +
        "timed-out request safe to retry"
    );
  } finally {
    cleanup();
  }
});

test("tokens reach the box through the Secret, never the pod spec", async () => {
  const { store, allocator, fake, cleanup } = fixture({ relayUrl: "http://agentbox-control.agentbox.svc:8788" });
  try {
    const acme = store.upsertTenant({ name: "acme" });
    const handle = await allocator.allocate(acme.id, { image: "agentbox/box:test" });
    const name = handle.externalId;

    const pod = fake.pods.get(name)!;
    const container = (pod.spec.containers as Record<string, unknown>[])[0]!;

    // The reason the Secret exists: `kubectl describe pod` shows the spec to anyone with read
    // access, so a token in `env` is a token handed out. envFrom renders as a name, not a value.
    const specText = JSON.stringify(pod);
    assert.ok(!specText.includes(handle.tokens.box), "the box token is nowhere in the pod spec");
    assert.ok(!specText.includes(handle.tokens.ui), "the UI token is nowhere in the pod spec");
    assert.ok(!specText.includes(handle.tokens.relay ?? "\0"), "the relay token is nowhere in the pod spec");
    assert.deepEqual(container.envFrom, [{ secretRef: { name: `${name}-tokens` } }]);

    const secret = fake.secrets.get(`${name}-tokens`);
    const decode = (key: string) => Buffer.from(secret?.data[key] ?? "", "base64").toString("utf8");
    assert.equal(decode("BOXD_TOKEN"), handle.tokens.box);
    assert.equal(decode("AGENTBOX_UI_TOKEN"), handle.tokens.ui);
    // With a relay, the four variables compose sets go through the Secret too: they include the
    // per-box relay token, which stands in for the operator's provider key.
    assert.equal(decode("AGENTBOX_BASE_URL"), "http://agentbox-control.agentbox.svc:8788");
    assert.equal(decode("AGENTBOX_API_KEY"), handle.tokens.relay);
    assert.equal(decode("AGENTBOX_KEY_ENV"), "AGENTBOX_API_KEY");
    assert.equal(decode("AGENTBOX_PROVIDER"), "anthropic");

    // The readiness probe is boxd's /health, which is unauthenticated by design — the probe gives
    // away nothing, and a box whose desktop is still starting is not Ready to be handed out.
    const probe = container.readinessProbe as { httpGet: { path: string; port: number } };
    assert.equal(probe.httpGet.path, "/health");
    assert.equal(probe.httpGet.port, 1337);

    // The three mounts are the same paths Docker gives a box — the image must not be able to
    // tell which allocator launched it.
    const mounts = container.volumeMounts as { name: string; mountPath: string }[];
    assert.deepEqual(
      mounts.map(m => [m.name, m.mountPath]),
      [
        ["work", "/home/box/work"],
        ["config", "/home/box/.config"],
        ["hostd", "/home/hostd/.agentbox"],
        ["shm", "/dev/shm"],
      ]
    );
  } finally {
    cleanup();
  }
});

test("the policy decision lands in the manifest and the audit log", async () => {
  const policy: AllocationPolicy = {
    decide: ({ tenantId }) => ({
      resources: { memoryRequest: "8g", memoryLimit: "8g", cpuRequest: "2", cpuLimit: "4" },
      storageSize: "50Gi",
      nodeSelector: { "agentbox/pool": "big" },
      tolerations: [{ key: "dedicated", operator: "Equal", value: "agentbox", effect: "NoSchedule" }],
      priorityClassName: "tenant-workloads",
      labels: { "example.com/tier": "premium", decidedFor: tenantId.slice(0, 8) },
    }),
  };
  const { store, allocator, fake, cleanup } = fixture({ policy });
  try {
    const acme = store.upsertTenant({ name: "acme" });
    const handle = await allocator.allocate(acme.id, { image: "agentbox/box:test" });

    const pod = fake.pods.get(handle.externalId)!;
    assert.deepEqual(pod.spec.nodeSelector, { "agentbox/pool": "big" });
    assert.deepEqual(pod.spec.tolerations, [
      { key: "dedicated", operator: "Equal", value: "agentbox", effect: "NoSchedule" },
    ]);
    assert.equal(pod.spec.priorityClassName, "tenant-workloads");
    const container = (pod.spec.containers as Record<string, unknown>[])[0]!;
    assert.deepEqual(container.resources, {
      requests: { memory: "8g", cpu: "2" },
      limits: { memory: "8g", cpu: "4" },
    });
    // Policy labels merge onto the pod *and* the service: a NetworkPolicy selects either.
    assert.equal(pod.metadata.labels?.["example.com/tier"], "premium");
    assert.equal(fake.services.get(handle.externalId)?.metadata.labels?.["example.com/tier"], "premium");
    assert.equal(
      fake.pvcs.get(`${handle.externalId}-work`)?.spec.resources &&
        (fake.pvcs.get(`${handle.externalId}-work`)!.spec.resources as { requests: { storage: string } }).requests.storage,
      "50Gi"
    );

    // And the decision is auditable, because "why is this tenant on that node pool" is asked
    // later, by someone holding only the audit log.
    const audit = store.recentAudit().find(row => row.action === "allocate.policy");
    assert.ok(audit, "the policy decision is in the audit log");
    assert.equal((audit.detail as { decision: { storageSize: string } }).decision.storageSize, "50Gi");
  } finally {
    cleanup();
  }
});

test("stop keeps the volumes and the secret; destroy takes everything", async () => {
  const { store, allocator, fake, cleanup } = fixture();
  try {
    const acme = store.upsertTenant({ name: "acme" });
    const handle = await allocator.allocate(acme.id, { image: "agentbox/box:test" });
    const name = handle.externalId;

    await allocator.stop(handle);
    assert.equal(fake.pods.has(name), false, "stop deletes the pod");
    assert.equal(fake.services.has(name), false, "and the service — a stopped box is unreachable, not half-there");
    for (const suffix of ["work", "config", "hostd"]) {
      assert.ok(fake.pvcs.has(`${name}-${suffix}`), `stop keeps the ${suffix} PVC: the tenant's work survives`);
    }
    assert.ok(fake.secrets.has(`${name}-tokens`), "stop keeps the secret: re-allocating must find the same credentials");
    assert.equal(store.getBox(handle.id)?.state, "stopped");

    await allocator.destroy(handle);
    assert.equal(fake.pods.has(name), false);
    assert.equal(fake.services.has(name), false);
    assert.equal(fake.secrets.has(`${name}-tokens`), false);
    for (const suffix of ["work", "config", "hostd"]) {
      assert.equal(fake.pvcs.has(`${name}-${suffix}`), false, "destroy takes the volumes too");
    }
    assert.equal(store.getBox(handle.id)?.state, "gone");
    // The row stays: it is how anyone learns later that this tenant had a box and it was taken.
    assert.equal(store.boxForTenant(acme.id), undefined, "and the slot is free again");
  } finally {
    cleanup();
  }
});

test("a PVC that cannot be deleted is loud, not swallowed", async () => {
  const { store, allocator, cleanup } = fixture({ failPvcDelete: "-config" });
  try {
    const acme = store.upsertTenant({ name: "acme" });
    const handle = await allocator.allocate(acme.id, { image: "agentbox/box:test" });

    // A leftover PVC is worse than a failed destroy: the next box with this tenant's name would
    // pick it up and inherit a predecessor's files and logged-in browser.
    await assert.rejects(allocator.destroy(handle), /persistentvolumeclaims remain/);
    await assert.rejects(allocator.destroy(handle), /-config: pvc is still bound/);
    assert.notEqual(
      store.getBox(handle.id)?.state,
      "gone",
      "a box whose volumes survived is not gone, and the state must not claim it is"
    );
  } finally {
    cleanup();
  }
});

test("a pod left over from a previous life is recreated, not adopted", async () => {
  const seed = fixture();
  const acme = seed.store.upsertTenant({ name: "acme" });
  const name = containerNameFor("agentbox", "acme", acme.id);
  seed.cleanup();

  const leftover: KubePod = {
    metadata: { name, labels: { "app.kubernetes.io/managed-by": "agentbox" } },
    spec: {},
    status: { phase: "Running" },
  };
  const { store, allocator, fake, cleanup } = fixture({ existingPods: [leftover] });
  try {
    store.upsertTenant({ id: acme.id, name: "acme" });
    await allocator.allocate(acme.id, { image: "agentbox/box:test" });

    // Adopting it would leave a box whose baked-in tokens are not the ones just issued, so every
    // call would come back Unauthorized with nothing pointing at the cause. Delete precedes
    // apply; the PVCs, not being tokens, are applied over and kept.
    const podCalls = fake.calls.filter(c => c.kind === "pod").map(c => c.verb);
    const deleteAt = podCalls.indexOf("delete");
    const applyAt = podCalls.indexOf("apply");
    assert.ok(deleteAt !== -1 && applyAt !== -1 && deleteAt < applyAt, `pod deleted before re-applied, got ${podCalls.join(",")}`);
    assert.ok(fake.pods.has(name), "and the new incarnation is there");
  } finally {
    cleanup();
  }
});

test("locate tells a stopped box from a gone one by its volumes", async () => {
  const { store, allocator, fake, cleanup } = fixture();
  try {
    const acme = store.upsertTenant({ name: "acme" });
    const handle = await allocator.allocate(acme.id, { image: "agentbox/box:test" });
    const name = handle.externalId;

    // Stopped: pod and service deleted, volumes kept. The address is stable DNS, so there is
    // nothing to correct — the answer is "there, not running".
    await allocator.stop(handle);
    const stopped = await allocator.reconcile({ ...handle, state: "stopped" });
    assert.ok(stopped !== undefined, "a stopped box is not gone");
    assert.equal(stopped.boxdUrl, `http://${name}.agentbox.svc:1337`);
    assert.equal(store.getBox(handle.id)?.state, "stopped", "reconcile did not condemn it");

    // Gone: someone removed the volumes by hand. The row has to say so, or the tenant can never
    // be given another box.
    await allocator.destroy(handle);
    assert.equal(fake.pvcs.size, 0);
    assert.equal(await allocator.reconcile(handle), undefined);
    assert.equal(store.getBox(handle.id)?.state, "gone");
    assert.equal(store.boxForTenant(acme.id), undefined, "the slot is free again");
  } finally {
    cleanup();
  }
});

test("a ready box whose pod loses Ready is demoted, not routed to", async () => {
  const { store, allocator, fake, cleanup } = fixture();
  try {
    const acme = store.upsertTenant({ name: "acme" });
    const handle = await allocator.allocate(acme.id, { image: "agentbox/box:test" });
    assert.equal(handle.state, "ready");

    // The desktop died: the pod still runs, but its Ready condition flipped. The address cannot
    // move under Service DNS, so the base class's reconcile sees nothing to correct — the
    // demotion is the kubernetes override's whole job.
    const pod = fake.pods.get(handle.externalId)!;
    pod.status = { phase: "Running", conditions: [{ type: "Ready", status: "False" }] };

    const corrected = await allocator.reconcile(handle);
    assert.equal(corrected?.state, "starting");
    assert.equal(store.getBox(handle.id)?.state, "starting");
  } finally {
    cleanup();
  }
});

test("a pod that never becomes ready fails loudly, with its phase", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-kubernetes-"));
  const store = new SqliteControlStore({ path: join(dir, "control.db") });
  try {
    const fake = fakeApi({ neverReady: true });
    const allocator = new KubernetesAllocator(store, {
      api: fake.api,
      image: "agentbox/box:test",
      startTimeoutMs: 60,
      pollIntervalMs: 5,
    });
    const acme = store.upsertTenant({ name: "acme" });
    // The image pull is the usual suspect, and the error has to say so — "timed out" alone sends
    // the operator to the network when the registry was the problem.
    await assert.rejects(allocator.allocate(acme.id, { image: "agentbox/box:test" }), /did not become ready/);
    await assert.rejects(allocator.allocate(acme.id, { image: "agentbox/box:test" }), /phase: Pending/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two concurrent allocates serialize: one secret, one pod, and the tokens match", async () => {
  const { store, allocator, fake, cleanup } = fixture();
  try {
    const acme = store.upsertTenant({ name: "acme" });
    const spec = { image: "agentbox/box:test" };
    const [first, second] = await Promise.all([
      allocator.allocate(acme.id, spec),
      allocator.allocate(acme.id, spec),
    ]);

    assert.equal(first.id, second.id, "one box, and both callers hold it");
    // Without the per-tenant chain the loser would apply its own Secret after the winner's pod
    // started, and the store's token and the pod's environment would disagree forever.
    assert.equal(
      fake.calls.filter(c => c.verb === "apply" && c.kind === "secret").length,
      1,
      "exactly one secret was ever written"
    );
    assert.equal(fake.calls.filter(c => c.verb === "apply" && c.kind === "pod").length, 1);
    assert.equal(fake.pvcs.size, 3, "one set of volumes");

    // And the one secret that exists carries the tokens the handle claims — the property the
    // race used to break.
    const secret = fake.secrets.get(`${first.externalId}-tokens`)!;
    assert.equal(Buffer.from(secret.data.BOXD_TOKEN!, "base64").toString("utf8"), first.tokens.box);
    assert.equal(Buffer.from(secret.data.AGENTBOX_UI_TOKEN!, "base64").toString("utf8"), first.tokens.ui);
  } finally {
    cleanup();
  }
});

test("a create that fails half-way removes what it made, but keeps the volumes", async () => {
  const { store, allocator, fake, cleanup } = fixture({ failApplyService: true });
  try {
    const acme = store.upsertTenant({ name: "acme" });
    await assert.rejects(
      allocator.allocate(acme.id, { image: "agentbox/box:test" }),
      /the apiserver said no/
    );
    const name = containerNameFor("agentbox", "acme", acme.id);

    // The Secret held live tokens; an orphaned one would be a credential nobody owns.
    assert.equal(fake.secrets.size, 0, "the secret was removed");
    assert.ok(
      fake.calls.some(c => c.verb === "delete" && c.kind === "secret" && c.name === `${name}-tokens`),
      "and the removal was actually attempted"
    );
    assert.equal(fake.services.size, 0, "the service never landed");
    assert.equal(fake.pods.size, 0, "the pod never landed");
    // The volumes stay on purpose: they are data, and a retried allocate applies over them cleanly.
    assert.equal(fake.pvcs.size, 3, "the volumes are kept");
  } finally {
    cleanup();
  }
});

test("a control plane pointed at another namespace is told so, not told the box is gone", async () => {
  const { store, allocator, fake, cleanup } = fixture();
  try {
    const acme = store.upsertTenant({ name: "acme" });
    const handle = await allocator.allocate(acme.id, { image: "agentbox/box:test" });
    assert.match(handle.boxdUrl, /\.agentbox\.svc:/);

    // The namespace is encoded in the stored address, so the drift is detectable — and reporting
    // "gone" would send the next allocate to create a second box in the wrong namespace.
    const drifted = new KubernetesAllocator(store, { api: fake.api, namespace: "elsewhere" });
    await assert.rejects(drifted.find(acme.id), /lives in the "agentbox" namespace/);
    await assert.rejects(drifted.find(acme.id), /AGENTBOX_K8S_NAMESPACE=agentbox/);
  } finally {
    cleanup();
  }
});

test("policy labels can add, but never overwrite the ownership labels the Service selects on", async () => {
  // A hostile or merely careless policy: every ownership label set to something wrong.
  const policy: AllocationPolicy = {
    decide: () => ({
      resources: { memoryRequest: "4Gi", memoryLimit: "4Gi" },
      storageSize: "10Gi",
      labels: {
        "app.kubernetes.io/instance": "someone-else",
        "app.kubernetes.io/managed-by": "not-us",
        "agentbox/tenant": "forgery",
        "example.com/tier": "premium",
      },
    }),
  };
  const { store, allocator, fake, cleanup } = fixture({ policy });
  try {
    const acme = store.upsertTenant({ name: "acme" });
    const handle = await allocator.allocate(acme.id, { image: "agentbox/box:test" });

    const labels = fake.pods.get(handle.externalId)!.metadata.labels ?? {};
    assert.equal(labels["app.kubernetes.io/instance"], handle.externalId);
    assert.equal(labels["app.kubernetes.io/managed-by"], "agentbox");
    assert.match(labels["agentbox/tenant"] ?? "", /^[0-9a-f]{8}$/);
    assert.equal(labels["example.com/tier"], "premium", "the policy's own labels still land");
    // And the Service still selects exactly this pod, which is what the order protects.
    assert.deepEqual(fake.services.get(handle.externalId)?.spec.selector, {
      "app.kubernetes.io/instance": handle.externalId,
    });
  } finally {
    cleanup();
  }
});

test("a pod that vanishes while we wait is loud, not a timeout", async () => {
  const { store, allocator, cleanup } = fixture({ podFate: "vanished" });
  try {
    const acme = store.upsertTenant({ name: "acme" });
    await assert.rejects(
      allocator.allocate(acme.id, { image: "agentbox/box:test" }),
      /vanished while waiting for it to become ready/
    );
  } finally {
    cleanup();
  }
});

test("a pod that fails while we wait is loud, not a timeout", async () => {
  const { store, allocator, cleanup } = fixture({ podFate: "failed" });
  try {
    const acme = store.upsertTenant({ name: "acme" });
    await assert.rejects(
      allocator.allocate(acme.id, { image: "agentbox/box:test" }),
      /failed before it became ready/
    );
  } finally {
    cleanup();
  }
});

test("a pod deleted underneath the readiness wait is loud, not waited out", async () => {
  const { store, allocator, cleanup } = fixture({ podFate: "terminating" });
  try {
    const acme = store.upsertTenant({ name: "acme" });
    // Terminating is terminal for this incarnation; waiting five minutes would only delay the news.
    await assert.rejects(
      allocator.allocate(acme.id, { image: "agentbox/box:test" }),
      /was deleted while waiting for it to become ready/
    );
  } finally {
    cleanup();
  }
});

test("controlUrl and spec env are plain env on the container, never in the Secret", async () => {
  const { store, allocator, fake, cleanup } = fixture({
    controlUrl: "http://agentbox-control.agentbox.svc:8080",
  });
  try {
    const acme = store.upsertTenant({ name: "acme" });
    const handle = await allocator.allocate(acme.id, {
      image: "agentbox/box:test",
      env: { AGENTBOX_PROVIDER: "minimax", EXTRA_FLAG: "1" },
    });

    const container = (fake.pods.get(handle.externalId)!.spec.containers as Record<string, unknown>[])[0]!;
    assert.deepEqual(container.env, [
      { name: "AGENTBOX_CONTROL_URL", value: "http://agentbox-control.agentbox.svc:8080" },
      { name: "AGENTBOX_PROVIDER", value: "minimax" },
      { name: "EXTRA_FLAG", value: "1" },
    ]);
    // No relay configured here, so the Secret holds exactly the two tokens and nothing else.
    const secret = fake.secrets.get(`${handle.externalId}-tokens`)!;
    assert.deepEqual(Object.keys(secret.data).sort(), ["AGENTBOX_UI_TOKEN", "BOXD_TOKEN"]);
  } finally {
    cleanup();
  }
});

test("restart re-applies the secret and recreates the pod, keeping the service and volumes", async () => {
  const { store, allocator, fake, cleanup } = fixture();
  try {
    const acme = store.upsertTenant({ name: "acme" });
    const handle = await allocator.allocate(acme.id, { image: "agentbox/box:test" });
    const name = handle.externalId;

    // The accident restart exists for: a node failure takes the pod, and the secret with it.
    // The Service and the volumes survive.
    fake.pods.delete(name);
    fake.secrets.delete(`${name}-tokens`);
    store.setBoxState(handle.id, "unreachable");

    await allocator.restart(handle);

    assert.ok(fake.pods.has(name), "the pod is back");
    const secret = fake.secrets.get(`${name}-tokens`);
    assert.ok(secret !== undefined, "the secret is back");
    assert.equal(
      Buffer.from(secret.data.BOXD_TOKEN!, "base64").toString("utf8"),
      handle.tokens.box,
      "re-applied from the store's tokens — minting new ones would break every open session"
    );
    assert.ok(fake.services.has(name), "the service was never touched");
    assert.equal(fake.pvcs.size, 3, "the volumes were never touched");
    assert.equal(store.getBox(handle.id)?.state, "ready");
    assert.ok(store.recentAudit().some(row => row.action === "restart"));
  } finally {
    cleanup();
  }
});

test("restart over a surviving pod deletes it first and waits for the name to free", async () => {
  const { store, allocator, fake, cleanup } = fixture();
  try {
    const acme = store.upsertTenant({ name: "acme" });
    const handle = await allocator.allocate(acme.id, { image: "agentbox/box:test" });
    const appliesBefore = fake.calls.filter(c => c.verb === "apply" && c.kind === "pod").length;

    await allocator.restart(handle);

    // get (does it exist) → delete → get (waitPodGone; the fake deletes instantly) → apply →
    // get (waitReady).
    const podCalls = fake.calls
      .filter(c => c.kind === "pod")
      .map(c => c.verb)
      .slice(-5);
    assert.deepEqual(podCalls, ["get", "delete", "get", "apply", "get"]);
    assert.equal(
      fake.calls.filter(c => c.verb === "apply" && c.kind === "pod").length,
      appliesBefore + 1
    );
  } finally {
    cleanup();
  }
});

test("prefix and namespace are validated as DNS-1123 before anything talks to a cluster", () => {
  const { store, fake, cleanup } = fixture();
  try {
    assert.throws(
      () => new KubernetesAllocator(store, { api: fake.api, prefix: "Bad_Prefix" }),
      /not a DNS-1123 label/
    );
    assert.throws(
      () => new KubernetesAllocator(store, { api: fake.api, namespace: "not_valid" }),
      /not a DNS-1123 label/
    );
    // The name scheme is prefix + "-" + slug(≤40) + "-" + hash(8) = prefix + 50, against the 63
    // a Service name allows: 14 is over, 13 is exactly right.
    assert.throws(
      () => new KubernetesAllocator(store, { api: fake.api, prefix: "a".repeat(14) }),
      /needs 50/
    );
    assert.ok(new KubernetesAllocator(store, { api: fake.api, prefix: "a".repeat(13) }));
  } finally {
    cleanup();
  }
});

test("staticPolicy refuses a quantity the apiserver would reject", () => {
  // "4g" is Docker spelling; Kubernetes quantities are case-sensitive and lowercase g does not
  // exist, so the default would have failed every pod create with a 422 naming spec.containers.
  assert.throws(() => staticPolicy({ memory: "4g" }), /not a Kubernetes quantity/);
  assert.throws(() => staticPolicy({ storage: "ten gigs" }), /not a Kubernetes quantity/);
  const decision = staticPolicy().decide({
    tenantId: "t",
    tenant: { id: "t", name: "acme", state: "active", createdAt: "", quota: {} },
    spec: { image: "box:test" },
  });
  assert.ok(!(decision instanceof Promise));
  assert.equal(decision.resources.memoryLimit, "4Gi");
  assert.equal(decision.storageSize, "10Gi");
});
