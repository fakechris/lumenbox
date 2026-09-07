/**
 * Who decides how big a box is and where it lands.
 *
 * The allocator's job is bookkeeping and lifecycle; the decision "this tenant gets 4g and no
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
 * 4g matches the single-host default (`AGENTBOX_MEMORY` in the box config), so moving a tenant
 * from compose to kubernetes changes the orchestrator and nothing else. Storage is 10Gi per
 * volume, which a kind cluster's `standard` provisioner satisfies out of the box.
 */
export function staticPolicy(overrides: { memory?: string; storage?: string } = {}): AllocationPolicy {
  const memory = overrides.memory ?? "4g";
  const storage = overrides.storage ?? "10Gi";
  return {
    decide: () => ({
      resources: { memoryRequest: memory, memoryLimit: memory },
      storageSize: storage,
    }),
  };
}
