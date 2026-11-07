/**
 * An in-memory Kubernetes API server for the suite — one fake, held to the one `KubeApi` contract,
 * shared by every test that needs a cluster (the per-tenant allocator, the control plane's
 * assembly, the per-box driver). The suite passes with no cluster and no network.
 */

import type { KubeApi, KubeNetworkPolicy, KubePod, KubePvc, KubeSecret, KubeService } from "../kube-client.ts";

export interface KubeCall {
  verb: "apply" | "get" | "delete";
  kind: "pod" | "service" | "pvc" | "secret" | "networkpolicy";
  name: string;
}

/**
 * An in-memory API server: remembers which objects "exist" and records every call.
 *
 * Pods become Ready the moment they are applied — the fake is a *kind* cluster where everything
 * schedules instantly — unless `neverReady` asks it to be the other kind (the timeout path's
 * whole test) or `podFate` asks for one of the ways a pod never becomes Ready at all.
 */
export function fakeKubeApi(
  options: {
    existingPods?: KubePod[];
    neverReady?: boolean;
    failPvcDelete?: string;
    failApplyService?: boolean;
    /** `vanished`: apply never lands. `failed` / `terminating`: the pod exists but cannot Ready. */
    podFate?: "vanished" | "failed" | "terminating";
    /** The pod sits Pending with this container waiting reason (ImagePullBackOff, …). */
    waitingReason?: string;
  } = {}
) {
  const pods = new Map<string, KubePod>();
  const services = new Map<string, KubeService>();
  const pvcs = new Map<string, KubePvc>();
  const secrets = new Map<string, KubeSecret>();
  const policies = new Map<string, KubeNetworkPolicy>();
  const calls: KubeCall[] = [];

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
            : options.waitingReason !== undefined
              ? { phase: "Pending", containerStatuses: [{ state: { waiting: { reason: options.waitingReason, message: `fake: ${options.waitingReason}` } } }] }
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
    async applyNetworkPolicy(policy) {
      calls.push({ verb: "apply", kind: "networkpolicy", name: policy.metadata.name });
      policies.set(policy.metadata.name, policy);
    },
    async deleteNetworkPolicy(name) {
      calls.push({ verb: "delete", kind: "networkpolicy", name });
      policies.delete(name);
    },
  };
  return { api, pods, services, pvcs, secrets, policies, calls };
}
