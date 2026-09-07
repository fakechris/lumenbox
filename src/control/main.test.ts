/**
 * Tests for control-plane assembly: `startControlPlane` wiring options and environment into an
 * allocator, gateway and store.
 *
 * The kubernetes path is exercised with an injected in-memory `KubeApi` (a smaller twin of the
 * one in kubernetes.test.ts — duplicated deliberately, because one test file importing another
 * re-runs the imported file's tests in this process). The point here is not allocation semantics
 * but assembly: that `--allocator kubernetes` constructs a working allocator, and that
 * `AGENTBOX_K8S_NAMESPACE` reaches it, since the namespace is encoded in every box address.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { KubeApi, KubePod, KubePvc, KubeSecret, KubeService } from "./kube-client.ts";
import { DEFAULT_NAMESPACE } from "./kubernetes.ts";
import { type RunningControlPlane, startControlPlane } from "./main.ts";

/** The whole KubeApi contract over four maps; pods are Ready on apply. */
function fakeKubeApi(): KubeApi {
  const pods = new Map<string, KubePod>();
  const services = new Map<string, KubeService>();
  const pvcs = new Map<string, KubePvc>();
  const secrets = new Map<string, KubeSecret>();
  return {
    async applyPod(pod) {
      pods.set(pod.metadata.name, {
        ...pod,
        status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] },
      });
    },
    async getPod(name) {
      return pods.get(name);
    },
    async deletePod(name) {
      pods.delete(name);
    },
    async applyService(service) {
      services.set(service.metadata.name, service);
    },
    async getService(name) {
      return services.get(name);
    },
    async deleteService(name) {
      services.delete(name);
    },
    async applyPvc(pvc) {
      pvcs.set(pvc.metadata.name, pvc);
    },
    async getPvc(name) {
      return pvcs.get(name);
    },
    async deletePvc(name) {
      pvcs.delete(name);
    },
    async applySecret(secret) {
      secrets.set(secret.metadata.name, secret);
    },
    async deleteSecret(name) {
      secrets.delete(name);
    },
  };
}

async function withControlPlane(
  env: Record<string, string | undefined>,
  fn: (plane: RunningControlPlane) => Promise<void>
): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const dir = mkdtempSync(join(tmpdir(), "agentbox-main-"));
  let plane: RunningControlPlane | undefined;
  try {
    plane = await startControlPlane({
      // Port 0: the OS picks, and no test ever fights another for a port.
      port: 0,
      host: "127.0.0.1",
      allocator: "kubernetes",
      image: "agentbox/box:test",
      kubeApi: fakeKubeApi(),
      users: "admin:pw:default",
      statePath: dir,
      sweepSeconds: 0,
      out: () => {},
    });
    await fn(plane);
  } finally {
    await plane?.close();
    rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("startControlPlane assembles the kubernetes allocator and honours AGENTBOX_K8S_NAMESPACE", async () => {
  await withControlPlane({ AGENTBOX_K8S_NAMESPACE: "fleet" }, async plane => {
    assert.equal(plane.allocator.kind, "kubernetes");
    assert.match(plane.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(plane.collector, undefined, "sweepSeconds: 0 disables the collector");

    // The env var reached the allocator: the namespace is encoded in the box's address.
    const tenant = plane.store.upsertTenant({ name: "acme" });
    const handle = await plane.allocator.allocate(tenant.id, { image: "agentbox/box:test" });
    assert.equal(handle.boxdUrl, `http://${handle.externalId}.fleet.svc:1337`);
  });
});

test("the namespace defaults when AGENTBOX_K8S_NAMESPACE is unset", async () => {
  await withControlPlane({ AGENTBOX_K8S_NAMESPACE: undefined }, async plane => {
    const tenant = plane.store.upsertTenant({ name: "acme" });
    const handle = await plane.allocator.allocate(tenant.id, { image: "agentbox/box:test" });
    assert.equal(handle.boxdUrl, `http://${handle.externalId}.${DEFAULT_NAMESPACE}.svc:1337`);
  });
});
