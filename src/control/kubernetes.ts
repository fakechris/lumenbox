/**
 * One pod per tenant, in a cluster.
 *
 * The third allocator, and the one the seam in `allocator.ts` was drawn for. What a box *is* in a
 * cluster lives in `kube-box.ts`, shared with the organisation installation's per-box driver
 * (INV-1692); this file is the per-tenant key, the store bookkeeping and the placement policy.
 * The resource model per tenant:
 *
 *   - a **Pod** running the same box image compose runs, with `restartPolicy: Always` standing in
 *     for `--restart unless-stopped`;
 *   - a **ClusterIP Service** of the same name, because it is what makes `locate` trivial: the
 *     address is `http://<name>.<ns>.svc:1337` forever, so the published-port drift that compose's
 *     `reconcile` exists to correct simply does not occur here;
 *   - **three PVCs** — work, config, hostd — the same three volumes Docker carries, at the same
 *     mount paths, because the image does not know which allocator launched it and must not;
 *   - a **Secret** holding the box's tokens, injected with `envFrom`;
 *   - a **NetworkPolicy** admitting only the control plane, so no tenant's box reaches another's.
 *
 * Two things this has to do better than compose, both because `kubectl describe pod` shows the
 * whole spec to anyone with read access:
 *
 *   - **Tokens never appear in the Pod spec.** Compose passes `BOXD_TOKEN` as a container env var,
 *     which `docker inspect` shows to whoever can ask the engine — one machine, one operator, an
 *     accepted trade. A cluster is shared infrastructure with broader read access, so the same
 *     values here would hand every tenant's credentials to anyone who can list pods. They live in
 *     a Secret and arrive via `envFrom`, which describe renders as a name, not a value.
 *   - **Placement is a policy decision, not a flag.** Every create asks an `AllocationPolicy` how
 *     big the box is and where it may land, and the decision lands in the manifest *and* the audit
 *     log. Today the policy is `staticPolicy()` — everyone alike — but quota tiers and node pools
 *     are a substitution, not an edit (see `policy.ts`).
 *
 * What it does not do: invent its own names. `containerNameFor` is reused unchanged — the
 * DNS-1123-safe, id-suffixed names it produces are already legal pod and service names, and a
 * second naming scheme is a second chance to hand one tenant another's volumes. It also does not
 * set a pod securityContext: the box image is built around root/sudo inside its own sandbox, so
 * `runAsNonRoot` is a declared non-goal here — the pod boundary, not the uid, is the isolation.
 */

import { createHash } from "node:crypto";
import { defaultBoxImage } from "../box/docker.ts";
import type { AllocatorKind, BoxHandle, BoxSpec, BoxTokens } from "./allocator.ts";
import { StoreBackedAllocator } from "./allocator.ts";
import { containerNameFor } from "./compose.ts";
import { KubeBoxes, type KubeBoxPlacement } from "./kube-box.ts";
import type { KubeApi } from "./kube-client.ts";
import { KubernetesError } from "./kube-client.ts";
import type { AllocationPolicy } from "./policy.ts";
import { staticPolicy } from "./policy.ts";
import type { BoxState, ControlStore } from "./store.ts";

export interface KubernetesAllocatorOptions {
  /**
   * The cluster, behind the narrow seam. Required rather than defaulted, because the suite has to
   * pass with no cluster and no network — the caller decides whether this is the real
   * `HttpKubeApi` or the test's in-memory one.
   */
  api: KubeApi;
  /**
   * The namespace boxes are created in *and named by*: `boxdUrl` is Service DNS, so the allocator
   * must know the namespace itself and not only through the client. Keep the two in agreement —
   * `main.ts` reads `AGENTBOX_K8S_NAMESPACE` once and hands it to both.
   */
  namespace?: string;
  image?: string;
  /** Prefix for object names, same role as compose's. A tenant's pod is `<prefix>-<tenant>-<hash>`. */
  prefix?: string;
  storageClassName?: string;
  imagePullPolicy?: string;
  /**
   * The model relay, as a box reaches it — inside a cluster, Service DNS such as
   * `http://agentbox-control.<ns>.svc:8788`. Same rule as compose: set, a box gets this and its
   * own relay token *through the Secret*, and no provider key enters the pod.
   */
  relayUrl?: string;
  /** The control plane, as a box reaches it. Plain env: an address is not a credential. */
  controlUrl?: string;
  relayProvider?: string;
  policy?: AllocationPolicy;
  /** How long to wait for a pod to report Ready. Pulling the image dominates; five minutes. */
  startTimeoutMs?: number;
  /** How often readiness is polled. An option so tests do not wait in real time. */
  pollIntervalMs?: number;
  onOutput?: (line: string) => void;
}

/** Which tenant an object belongs to — the hash, not the name, because the name is not safe. */
const TENANT_LABEL = "agentbox/tenant";

/**
 * The namespace boxes live in when nothing says otherwise. Exported so `main.ts` and the deploy
 * manifests spell it the same way — the namespace is encoded in every box's address, so two
 * defaults that disagreed would strand every existing box (see the `find` override below).
 */
export const DEFAULT_NAMESPACE = "agentbox";

export class KubernetesAllocator extends StoreBackedAllocator {
  readonly kind: AllocatorKind = "kubernetes";

  private readonly namespace: string;
  private readonly prefix: string;
  private readonly boxes: KubeBoxes;
  private readonly policy: AllocationPolicy;
  /**
   * One allocation per tenant at a time, in-process: a promise chain the next allocate for the
   * same tenant waits behind. The store's unique index already makes a lost race safe *between
   * processes*, but within this process two concurrent allocates both pass the `find` check and
   * both mint tokens — and the loser's Secret would land after the winner's pod started, leaving
   * the store's token and the running pod's environment permanently mismatched. The gateway's
   * meta-refresh retries every five seconds, so the race is not hypothetical.
   */
  private readonly allocations = new Map<string, Promise<unknown>>();

  constructor(
    store: ControlStore,
    options: KubernetesAllocatorOptions
  ) {
    super(store);
    this.namespace = options.namespace ?? DEFAULT_NAMESPACE;
    this.prefix = options.prefix ?? DEFAULT_NAMESPACE;
    // Both strings end up inside object names and the Service DNS the gateway resolves, so they
    // are checked against DNS-1123 here rather than discovered as a 422 from the apiserver on the
    // first allocation. The length budget: a box's name — which is also its Service's name — is
    // `<prefix>-<tenant-slug, ≤40>-<hash, 8>`, i.e. prefix + 50 characters against the 63 a label
    // (and a Service name) allows.
    for (const [what, value] of [
      ["prefix", this.prefix],
      ["namespace", this.namespace],
    ] as const) {
      if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(value)) {
        throw new KubernetesError(
          `${what} "${value}" is not a DNS-1123 label (lowercase letters, digits and dashes, ` +
            `not starting or ending with a dash) — every box name and address derives from it`
        );
      }
    }
    if (this.prefix.length + 50 > 63) {
      throw new KubernetesError(
        `prefix "${this.prefix}" leaves ${63 - this.prefix.length} characters for a box name, and ` +
          `the naming scheme needs 50 — shorten the prefix`
      );
    }
    this.policy = options.policy ?? staticPolicy();
    let resolvedDefaultImage: string | undefined;
    this.boxes = new KubeBoxes({
      api: options.api,
      namespace: this.namespace,
      // Resolved when first needed, not here: reading it consults the installation's config file,
      // which a constructor that only validates names has no business touching (INV-875).
      defaultImage: () => (resolvedDefaultImage ??= options.image ?? defaultBoxImage()),
      ...(options.storageClassName !== undefined ? { storageClassName: options.storageClassName } : {}),
      ...(options.imagePullPolicy !== undefined ? { imagePullPolicy: options.imagePullPolicy } : {}),
      ...(options.relayUrl !== undefined ? { relayUrl: options.relayUrl } : {}),
      ...(options.relayProvider !== undefined ? { relayProvider: options.relayProvider } : {}),
      fixedEnv: {
        // The gateway proxies to the box's UI, so the in-box orchestrator is not optional here the
        // way it is for a laptop box: without it nothing listens on the UI port and every proxied
        // request is a 502. Compose sets the same variable (box/docker.ts).
        AGENTBOX_HOST_ENABLED: "1",
        // The gateway's identity headers are believed only where a gateway is in front; the trust
        // flag is the control plane's to set, never a spec's to unset (INV-1543).
        AGENTBOX_TRUST_GATEWAY_IDENTITY: "1",
        ...(options.controlUrl !== undefined ? { AGENTBOX_CONTROL_URL: options.controlUrl } : {}),
      },
      ...(options.startTimeoutMs !== undefined ? { startTimeoutMs: options.startTimeoutMs } : {}),
      ...(options.pollIntervalMs !== undefined ? { pollIntervalMs: options.pollIntervalMs } : {}),
      ...(options.onOutput !== undefined ? { onOutput: options.onOutput } : {}),
    });
  }

  /**
   * A tenant's label value. The readable name is neither safe (a label value is more permissive
   * than a pod name, but `北京公司` is still out) nor unique (two tenants may share one), so the
   * same hash that anchors the object name anchors the label.
   */
  private tenantLabel(tenantId: string): string {
    return createHash("sha256").update(tenantId).digest("hex").slice(0, 8);
  }

  private async placementFor(tenantId: string, name: string, spec: BoxSpec, tokens: BoxTokens): Promise<KubeBoxPlacement> {
    const tenant = this.store.getTenant(tenantId);
    if (tenant === undefined) throw new Error(`no such tenant: ${tenantId}`);
    const decision = await this.policy.decide({ tenantId, tenant, spec });
    return { name, owner: { [TENANT_LABEL]: this.tenantLabel(tenantId) }, spec, tokens, decision };
  }

  protected async create(
    tenantId: string,
    _boxId: string,
    spec: BoxSpec,
    tokens: BoxTokens
  ): Promise<{ externalId: string; boxdUrl: string; uiUrl: string; state: BoxState }> {
    const tenant = this.store.getTenant(tenantId);
    if (tenant === undefined) throw new Error(`no such tenant: ${tenantId}`);
    const name = containerNameFor(this.prefix, tenant.name, tenant.id);

    // Policy first, before anything is rendered: the decision shapes the manifests, and if the
    // policy refuses or fails, nothing half-exists for destroy to clean up.
    const placement = await this.placementFor(tenantId, name, spec, tokens);
    // The decision goes in the audit because "why is this tenant's box on that node pool" is a
    // question asked later, by someone holding only the audit log.
    this.store.audit({
      tenantId,
      actor: `${this.kind}-allocator`,
      action: "allocate.policy",
      target: name,
      detail: { decision: placement.decision },
    });
    const placed = await this.boxes.create(placement);
    return { externalId: name, ...placed, state: "ready" };
  }

  /**
   * `allocate`, serialized per tenant.
   *
   * Two concurrent allocates for one tenant both mint tokens, and without this chain the loser's
   * Secret lands after the winner's pod started — the store's token and the running pod's
   * environment disagreeing forever. (Between processes the store's unique index still decides;
   * this only keeps this process honest with itself.) A rejected run must not block the next one,
   * hence the caught gate. The map entry is dropped when it is still ours, so the map does not
   * grow a dead promise per tenant.
   */
  override async allocate(tenantId: string, spec: BoxSpec): Promise<BoxHandle> {
    const gate = (this.allocations.get(tenantId) ?? Promise.resolve()).catch(() => {});
    const run = gate.then(() => super.allocate(tenantId, spec));
    this.allocations.set(tenantId, run);
    try {
      return await run;
    } finally {
      if (this.allocations.get(tenantId) === run) this.allocations.delete(tenantId);
    }
  }

  /**
   * `find`, plus a guard against the one configuration drift only this allocator can have: the
   * namespace is encoded in every box's stored address (`http://<name>.<ns>.svc`), so a control
   * plane restarted with a different `AGENTBOX_K8S_NAMESPACE` would locate nothing of its own
   * boxes and — worse — would be answering about *another* namespace's. Loud, in the same style
   * as the allocator-kind check in the base class, because silently reporting "gone" would send
   * the next allocate to create a second box in the wrong namespace.
   */
  override async find(tenantId: string): Promise<BoxHandle | undefined> {
    const handle = await super.find(tenantId);
    if (handle === undefined) return undefined;
    const stored = /^https?:\/\/[^.]+\.([a-z0-9-]+)\.svc(?::|\/|$)/.exec(handle.boxdUrl)?.[1];
    if (stored !== undefined && stored !== this.namespace) {
      throw new Error(
        `This tenant's box lives in the "${stored}" namespace (its stored address is ` +
          `${handle.boxdUrl}) but this control plane is configured for "${this.namespace}". ` +
          `Start it with AGENTBOX_K8S_NAMESPACE=${stored}, or destroy the box first.`
      );
    }
    return handle;
  }

  protected async stopExternal(handle: BoxHandle): Promise<void> {
    // Pod and Service go; PVCs and the Secret stay. A stopped box should be unreachable, not
    // half-there — and the tenant's work and credentials are what a later allocate finds again.
    await this.boxes.stop(handle.externalId);
  }

  protected async destroyExternal(handle: BoxHandle): Promise<void> {
    await this.boxes.destroy(handle.externalId);
  }

  /**
   * Recreate the pod — and only the pod — from the tokens the store already holds: the recovery
   * for "the pod is gone but everything else survived". The image comes from the stored row — the
   * pod must come back as the box it was. The original spec.env is not stored (same limitation as
   * compose's restart); what the box needs to authenticate is all in the Secret.
   */
  async restart(handle: BoxHandle): Promise<void> {
    const row = this.store.getBox(handle.id);
    const tenant = this.store.getTenant(handle.tenantId);
    if (row === undefined || tenant === undefined) {
      throw new KubernetesError(`cannot restart ${handle.externalId}: the store has lost its row`);
    }
    this.store.setBoxState(handle.id, "starting");
    const placement = await this.placementFor(handle.tenantId, handle.externalId, { image: row.image }, handle.tokens);
    try {
      await this.boxes.restart(placement);
    } catch (error) {
      // A box that did not come back is unreachable, not starting forever — and the error still
      // travels to whoever asked.
      this.store.setBoxState(handle.id, "unreachable");
      throw error;
    }
    this.store.setBoxState(handle.id, "ready");
    this.store.audit({
      tenantId: handle.tenantId,
      actor: `${this.kind}-allocator`,
      action: "restart",
      target: handle.externalId,
    });
  }

  protected async locate(
    handle: BoxHandle
  ): Promise<{ boxdUrl: string; uiUrl: string; running: boolean } | undefined> {
    return this.boxes.locate(handle.externalId);
  }

  /**
   * `reconcile`, plus the one correction the base class's contract cannot express.
   *
   * The base class corrects addresses, and these cannot move, so without this override a pod that
   * lost its Ready condition keeps its `ready` row forever and the gateway routes to a box that
   * cannot answer. A not-ready box is demoted to `starting`, the state the gateway already renders
   * as "your box is coming".
   */
  override async reconcile(handle: BoxHandle): Promise<BoxHandle | undefined> {
    const corrected = await super.reconcile(handle);
    if (corrected === undefined || corrected.state !== "ready") return corrected;
    const found = await this.locate(corrected).catch(() => undefined);
    if (found !== undefined && !found.running) {
      this.store.setBoxState(corrected.id, "starting");
      return { ...corrected, state: "starting" };
    }
    return corrected;
  }
}
