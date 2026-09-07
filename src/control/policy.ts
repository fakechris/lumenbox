/**
 * Who decides how big a box is and where it lands.
 *
 * The allocator's job is bookkeeping and lifecycle; the decision "this tenant gets 4Gi and no
 * scheduling constraints" is a *policy*, and it lives behind its own seam so that the enterprise
 * questions — quota tiers from `quota_json`, node pools, priority classes, labels a NetworkPolicy
 * selects on — are answered by replacing one object rather than editing the allocator. The seam is
 * drawn now, before any of those policies exist, because seams added after the second caller always
 * cost more than seams added before it.
 *
 * Deliberately free of Kubernetes imports: a policy decides resources, placement and labels, and
 * which substrate consumes the decision is the allocator's business. A future non-K8s allocator
 * reads the same shape.
 */

import type { BoxSpec } from "./allocator.ts";
import type { Tenant } from "./store.ts";

/**
 * One Kubernetes toleration, declared locally rather than imported: the whole type is five
 * optional fields, and a dependency to avoid declaring them is the dependency question answered
 * the wrong way.
 */
export interface Toleration {
  key?: string;
  operator?: "Exists" | "Equal";
  value?: string;
  effect?: "NoSchedule" | "PreferNoSchedule" | "NoExecute";
  tolerationSeconds?: number;
}

export interface AllocationDecision {
  resources: {
    cpuRequest?: string;
    cpuLimit?: string;
    memoryRequest: string;
    memoryLimit: string;
  };
  /** Per PVC — a tenant's three volumes are sized alike; differentiating them is a policy too. */
  storageSize: string;
  nodeSelector?: Record<string, string>;
  tolerations?: Toleration[];
  priorityClassName?: string;
  /**
   * Extra labels merged onto the Pod and Service. The audience is external policy: a
   * NetworkPolicy or a quota admission webhook selects on these without knowing anything about
   * agentbox's own label scheme.
   */
  labels?: Record<string, string>;
}

export interface AllocationPolicy {
  decide(input: {
    tenantId: string;
    tenant: Tenant;
    spec: BoxSpec;
  }): AllocationDecision | Promise<AllocationDecision>;
}

/**
 * The policy that exists before anyone needs another: every tenant alike.
 *
 * 4Gi matches the single-host default (`AGENTBOX_MEMORY` in the box config) closely enough that
 * moving a tenant from compose to kubernetes changes the orchestrator and nothing else. Not "4g":
 * Kubernetes quantities are case-sensitive, lowercase `g` does not exist, and the apiserver
 * rejects the pod at create time. Storage is 10Gi per volume, which a kind cluster's `standard`
 * provisioner satisfies out of the box.
 */
export function staticPolicy(overrides: { memory?: string; storage?: string } = {}): AllocationPolicy {
  const memory = quantity(overrides.memory ?? "4Gi", "memory");
  const storage = quantity(overrides.storage ?? "10Gi", "storage");
  return {
    decide: () => ({
      resources: { memoryRequest: memory, memoryLimit: memory },
      storageSize: storage,
    }),
  };
}

/**
 * The shape of a Kubernetes quantity, checked before the apiserver is asked: an invalid value
 * (`4g`, `4gb`) fails pod creation with a 422 that names a field deep in the spec, and the person
 * reading that error learns nothing about which setting produced it. Fail here instead.
 *
 * Permissive on purpose — `500m` is nonsense for memory but legal syntax, and rejecting nonsense
 * is the apiserver's call. What this catches is the case slip and the invented suffix.
 */
const QUANTITY = /^\d+(\.\d+)?(Ki|Mi|Gi|Ti|Pi|Ei|k|M|G|T|P|E|m)?$/;

function quantity(value: string, name: string): string {
  if (!QUANTITY.test(value)) {
    throw new Error(
      `${name} is not a Kubernetes quantity: ${JSON.stringify(value)} ` +
        `(quantities are case-sensitive — 4Gi, 500Mi, 2 — check AGENTBOX_K8S_MEMORY / AGENTBOX_K8S_STORAGE)`
    );
  }
  return value;
}
