/**
 * One pod per tenant, in a cluster.
 *
 * The third allocator, and the one the seam in `allocator.ts` was drawn for. The resource model
 * per tenant:
 *
 *   - a **Pod** running the same box image compose runs, with `restartPolicy: Always` standing in
 *     for `--restart unless-stopped`;
 *   - a **ClusterIP Service** of the same name, because it is what makes `locate` trivial: the
 *     address is `http://<name>.<ns>.svc:1337` forever, so the published-port drift that compose's
 *     `reconcile` exists to correct simply does not occur here;
 *   - **three PVCs** — work, config, hostd — the same three volumes Docker carries, at the same
 *     mount paths, because the image does not know which allocator launched it and must not;
 *   - a **Secret** holding the box's tokens, injected with `envFrom`.
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
import { defaultBoxConfig } from "../box/docker.ts";
import { BOXD_PORT, UI_PORT } from "../protocol/index.ts";
import type { AllocatorKind, BoxHandle, BoxSpec, BoxTokens } from "./allocator.ts";
import { DEFAULT_RELAY_PROVIDER, StoreBackedAllocator } from "./allocator.ts";
import { containerNameFor } from "./compose.ts";
import type { KubeApi, KubePod, KubePvc, KubeSecret, KubeService } from "./kube-client.ts";
import { KubernetesError } from "./kube-client.ts";
import type { AllocationDecision, AllocationPolicy } from "./policy.ts";
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

const MANAGED_BY = "app.kubernetes.io/managed-by";
const INSTANCE = "app.kubernetes.io/instance";
/** Which tenant an object belongs to — the hash, not the name, because the name is not safe. */
const TENANT_LABEL = "agentbox/tenant";

/**
 * The namespace boxes live in when nothing says otherwise. Exported so `main.ts` and the deploy
 * manifests spell it the same way — the namespace is encoded in every box's address, so two
 * defaults that disagreed would strand every existing box (see the `find` override below).
 */
export const DEFAULT_NAMESPACE = "agentbox";

/**
 * The three persistent volumes every box gets, with their mount paths — the same three, at the
 * same paths, that Docker gives a box, because the image must not be able to tell which allocator
 * launched it. PVC construction, the pod's volumes and volumeMounts, and destroy's loop all
 * derive from this one list: a volume added in one place and forgotten in another is either a
 * mount that never binds or data destroy leaves behind.
 */
const VOLUMES = [
  { name: "work", mountPath: "/home/box/work" },
  { name: "config", mountPath: "/home/box/.config" },
  { name: "hostd", mountPath: "/home/hostd/.agentbox" },
] as const;

/**
 * How long to wait for a deleted pod's name to free before re-creating it. Deletion is
 * asynchronous; a name still held after a minute is a wedged kubelet, not a slow one.
 */
const POD_DELETION_WAIT_MS = 60_000;

/**
 * Run independent calls in parallel without dropping rejections on the floor: `Promise.all`
 * rejects on the first failure and leaves the rest unobserved, which Node quite reasonably
 * complains about. Everything settles; the first failure is the one thrown.
 */
async function allOrFirst(calls: readonly (() => Promise<void>)[]): Promise<void> {
  const results = await Promise.allSettled(calls.map(call => call()));
  const failed = results.find(result => result.status === "rejected");
  if (failed !== undefined) throw (failed as PromiseRejectedResult).reason;
}

export class KubernetesAllocator extends StoreBackedAllocator {
  readonly kind: AllocatorKind = "kubernetes";

  private readonly namespace: string;
  private readonly prefix: string;
  private readonly defaultImage: string;
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
    private readonly options: KubernetesAllocatorOptions
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
    this.defaultImage = options.image ?? defaultBoxConfig().image;
    this.policy = options.policy ?? staticPolicy();
  }

  /**
   * A tenant's label value. The readable name is neither safe (a label value is more permissive
   * than a pod name, but `北京公司` is still out) nor unique (two tenants may share one), so the
   * same hash that anchors the object name anchors the label.
   */
  private tenantLabel(tenantId: string): string {
    return createHash("sha256").update(tenantId).digest("hex").slice(0, 8);
  }

  private labelsFor(name: string, tenantId: string, extra?: Record<string, string>): Record<string, string> {
    return {
      // Policy labels first, ownership last: the Service selects its pod on INSTANCE, so a policy
      // that could overwrite these would point the Service at nothing — or at another tenant's pod.
      ...extra,
      [MANAGED_BY]: "agentbox",
      [INSTANCE]: name,
      [TENANT_LABEL]: this.tenantLabel(tenantId),
    };
  }

  /** Every object a tenant owns, named and labelled, before any of it is sent. */
  private manifestsFor(
    tenantId: string,
    name: string,
    spec: BoxSpec,
    tokens: BoxTokens,
    decision: AllocationDecision
  ): { secret: KubeSecret; pvcs: KubePvc[]; service: KubeService; pod: KubePod } {
    const labels = this.labelsFor(name, tenantId, decision.labels);

    // The secret carries everything another tenant — or anyone with pod-read access — must not
    // learn: the box's own two tokens, and the relay configuration when there is one, which
    // includes the per-box relay token that stands in for the operator's provider key. The pod
    // references it by name only.
    const secretData: Record<string, string> = {
      BOXD_TOKEN: tokens.box,
      AGENTBOX_UI_TOKEN: tokens.ui,
    };
    if (this.options.relayUrl !== undefined && tokens.relay !== undefined) {
      // The same four variables compose sets, for the same reason: together they make the box's
      // provider layer take the relay as its endpoint and this token as its credential, while the
      // capabilities still follow the named provider's model.
      secretData.AGENTBOX_BASE_URL = this.options.relayUrl;
      secretData.AGENTBOX_API_KEY = tokens.relay;
      secretData.AGENTBOX_KEY_ENV = "AGENTBOX_API_KEY";
      secretData.AGENTBOX_PROVIDER = this.options.relayProvider ?? DEFAULT_RELAY_PROVIDER;
    }
    const secret: KubeSecret = {
      metadata: { name: `${name}-tokens`, labels },
      data: Object.fromEntries(
        Object.entries(secretData).map(([key, value]) => [key, Buffer.from(value, "utf8").toString("base64")])
      ),
    };

    // The same three volumes Docker gives a box, at the same paths. The image's entrypoint
    // populates the config volume on start exactly as it does under compose — the box must not be
    // able to tell which allocator launched it.
    const pvcs: KubePvc[] = VOLUMES.map(({ name: suffix }) => ({
      metadata: { name: `${name}-${suffix}`, labels },
      spec: {
        accessModes: ["ReadWriteOnce"],
        resources: { requests: { storage: decision.storageSize } },
        ...(this.options.storageClassName !== undefined
          ? { storageClassName: this.options.storageClassName }
          : {}),
      },
    }));

    const service: KubeService = {
      metadata: { name, labels },
      spec: {
        type: "ClusterIP",
        selector: { [INSTANCE]: name },
        ports: [
          { name: "boxd", port: BOXD_PORT, targetPort: BOXD_PORT },
          { name: "ui", port: UI_PORT, targetPort: UI_PORT },
        ],
      },
    };

    const pod: KubePod = {
      metadata: { name, labels },
      spec: {
        restartPolicy: "Always",
        // A box runs code its agents write; the last thing it needs is a mounted ServiceAccount
        // credential for the cluster it lives in, or service-link env vars advertising it.
        automountServiceAccountToken: false,
        enableServiceLinks: false,
        ...(decision.nodeSelector !== undefined ? { nodeSelector: decision.nodeSelector } : {}),
        ...(decision.tolerations !== undefined ? { tolerations: decision.tolerations } : {}),
        ...(decision.priorityClassName !== undefined
          ? { priorityClassName: decision.priorityClassName }
          : {}),
        containers: [
          {
            name: "box",
            image: spec.image || this.defaultImage,
            imagePullPolicy: this.options.imagePullPolicy ?? "IfNotPresent",
            ports: [
              { name: "boxd", containerPort: BOXD_PORT },
              { name: "ui", containerPort: UI_PORT },
            ],
            // The whole credential story: by reference, never by value. `kubectl describe pod`
            // shows this stanza as a secret name; the values are visible only to whoever may
            // already read secrets in this namespace.
            envFrom: [{ secretRef: { name: `${name}-tokens` } }],
            env: [
              ...(this.options.controlUrl !== undefined
                ? [{ name: "AGENTBOX_CONTROL_URL", value: this.options.controlUrl }]
                : []),
              ...Object.entries(spec.env ?? {}).map(([key, value]) => ({ name: key, value })),
            ],
            resources: {
              requests: {
                memory: decision.resources.memoryRequest,
                ...(decision.resources.cpuRequest !== undefined
                  ? { cpu: decision.resources.cpuRequest }
                  : {}),
              },
              limits: {
                memory: decision.resources.memoryLimit,
                ...(decision.resources.cpuLimit !== undefined
                  ? { cpu: decision.resources.cpuLimit }
                  : {}),
              },
            },
            // boxd's /health is unauthenticated by design (the collector relies on the same), so a
            // probe gives away nothing.
            readinessProbe: {
              httpGet: { path: "/health", port: BOXD_PORT },
              periodSeconds: 5,
              timeoutSeconds: 3,
              // A box's desktop takes seconds to come up after the container starts; the default
              // threshold of 3 would mark it NotReady during a perfectly normal boot.
              failureThreshold: 12,
            },
            volumeMounts: [
              ...VOLUMES.map(({ name: volume, mountPath }) => ({ name: volume, mountPath })),
              { name: "shm", mountPath: "/dev/shm" },
            ],
          },
        ],
        volumes: [
          ...VOLUMES.map(({ name: volume }) => ({
            name: volume,
            persistentVolumeClaim: { claimName: `${name}-${volume}` },
          })),
          // Docker gives a box `--shm-size 1g` because Chrome needs more than the default 64MiB
          // of /dev/shm; Kubernetes's equivalent is a memory-backed emptyDir. Without it the
          // browser crashes in ways that look like the page's fault.
          { name: "shm", emptyDir: { medium: "Memory", sizeLimit: "1Gi" } },
        ],
      },
    };
    return { secret, pvcs, service, pod };
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
    const decision = await this.policy.decide({ tenantId, tenant, spec });
    // The decision goes in the audit because "why is this tenant's box on that node pool" is a
    // question asked later, by someone holding only the audit log.
    this.store.audit({
      tenantId,
      actor: `${this.kind}-allocator`,
      action: "allocate.policy",
      target: name,
      detail: { decision },
    });

    const { secret, pvcs, service, pod } = this.manifestsFor(tenantId, name, spec, tokens, decision);

    // A pod already carrying this name is the previous incarnation of this tenant's box — the
    // control plane restarted, or a row was lost. Adopting it is wrong for the same reason as
    // compose: its baked-in tokens are not the ones just issued, so nothing would authenticate.
    // Recreating keeps the PVCs, which is where the tenant's work actually lives. Deletion is
    // asynchronous, so the re-apply waits for the name to free rather than meeting a 409.
    const existing = await this.options.api.getPod(name);
    if (existing !== undefined) {
      this.options.onOutput?.(
        `${name} already exists (${existing.status?.phase ?? "unknown"}); recreating it with ` +
          `this box's tokens — volumes are kept`
      );
      await this.options.api.deletePod(name);
      await this.waitPodGone(name);
    }

    // Secret first: the pod references it by name and Kubernetes starts a pod whose secret is
    // missing only after the secret appears — but ordering it first makes the intent legible and
    // the startup immediate. PVCs (independent of each other, so in parallel) before the pod for
    // the same reason. Service last before the pod, so the DNS name resolves the moment the pod
    // is Ready.
    try {
      await this.options.api.applySecret(secret);
      await allOrFirst(pvcs.map(pvc => () => this.options.api.applyPvc(pvc)));
      await this.options.api.applyService(service);
      await this.options.api.applyPod(pod);
      await this.waitReady(name);
    } catch (error) {
      // A create that fails half-way must not leave what it made: the Secret holds live tokens,
      // and an orphaned one is a credential nobody owns. The PVCs stay on purpose — they are
      // data, they may predate this attempt (the recreate path above), and a retried allocate
      // applies over them cleanly.
      await this.removeOrphans(name);
      throw error;
    }

    return {
      externalId: name,
      boxdUrl: this.boxdUrlFor(name),
      uiUrl: this.uiUrlFor(name),
      state: "ready",
    };
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

  /** The addresses never move — that is the entire reason the Service exists. */
  private boxdUrlFor(name: string): string {
    return `http://${name}.${this.namespace}.svc:${BOXD_PORT}`;
  }

  private uiUrlFor(name: string): string {
    return `http://${name}.${this.namespace}.svc:${UI_PORT}`;
  }

  /**
   * Wait for a deleted pod's name to free.
   *
   * DELETE returns when the object is *marked*, not when it is gone, and a pod keeps its name
   * until the kubelet confirms the teardown — so re-creating on the strength of a returned DELETE
   * is the 409 loop this wait exists to prevent.
   */
  private async waitPodGone(name: string): Promise<void> {
    const deadline = Date.now() + POD_DELETION_WAIT_MS;
    const interval = this.options.pollIntervalMs ?? 2_000;
    for (;;) {
      if ((await this.options.api.getPod(name)) === undefined) return;
      if (Date.now() > deadline) {
        throw new KubernetesError(
          `pod ${name} still existed ${POD_DELETION_WAIT_MS / 1000}s after deletion — the kubelet ` +
            `is not letting go; look at the node before retrying`
        );
      }
      await new Promise(resolve => setTimeout(resolve, interval));
    }
  }

  /**
   * Undo a failed create: pod, service and secret go (absence tolerated — a delete after a
   * half-finished create is a normal path), the volumes stay. Cleanup failures are reported
   * rather than thrown: the original error is the one the caller needs, and a throw here would
   * replace it.
   */
  private async removeOrphans(name: string): Promise<void> {
    const results = await Promise.allSettled([
      this.options.api.deletePod(name),
      this.options.api.deleteService(name),
      this.options.api.deleteSecret(`${name}-tokens`),
    ]);
    for (const result of results) {
      if (result.status === "rejected") {
        const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
        this.options.onOutput?.(`${name}: cleanup after a failed create itself failed: ${reason}`);
      }
    }
  }

  /**
   * Wait for the pod's Ready condition.
   *
   * Readiness, not Running: a container whose desktop has not come up is a pod that answers TCP
   * and nothing else, and handing out its address would repeat the compose bug where the second
   * box's UI refused a request the first box had answered. The timeout is generous because the
   * wait includes the image pull.
   */
  private async waitReady(name: string): Promise<void> {
    const timeoutMs = this.options.startTimeoutMs ?? 5 * 60 * 1000;
    const deadline = Date.now() + timeoutMs;
    const interval = this.options.pollIntervalMs ?? 2_000;
    for (;;) {
      const pod = await this.options.api.getPod(name);
      if (pod === undefined) {
        throw new KubernetesError(`pod ${name} vanished while waiting for it to become ready`);
      }
      if (pod.status?.phase === "Failed") {
        throw new KubernetesError(`pod ${name} failed before it became ready`);
      }
      if (pod.metadata.deletionTimestamp !== undefined) {
        // Terminating is not "not ready yet": this pod is going away and will never report Ready,
        // so waiting out the full timeout would only delay the news.
        throw new KubernetesError(
          `pod ${name} was deleted while waiting for it to become ready (node drain, eviction, or ` +
            `a hand on kubectl) — recreating it is restart's job, not this wait's`
        );
      }
      const ready = pod.status?.conditions?.some(c => c.type === "Ready" && c.status === "True");
      if (ready === true) return;
      if (Date.now() > deadline) {
        throw new KubernetesError(
          `pod ${name} did not become ready within ${timeoutMs}ms ` +
            `(phase: ${pod.status?.phase ?? "unknown"}) — the image pull is the usual suspect`
        );
      }
      await new Promise(resolve => setTimeout(resolve, interval));
    }
  }

  protected async stopExternal(handle: BoxHandle): Promise<void> {
    // Pod and Service go; PVCs and the Secret stay. Same rule as compose's stop: reversible, and
    // the tenant's work and credentials are exactly what a later allocate must find again. The
    // Service goes too because a Service selecting a pod that does not exist still answers DNS —
    // a stopped box should be unreachable, not half-there.
    await allOrFirst([
      () => this.options.api.deletePod(handle.externalId),
      () => this.options.api.deleteService(handle.externalId),
    ]);
  }

  protected async destroyExternal(handle: BoxHandle): Promise<void> {
    const name = handle.externalId;
    // Pod, service and secret are independent objects — parallel, with every rejection observed.
    await allOrFirst([
      () => this.options.api.deletePod(name),
      () => this.options.api.deleteService(name),
      () => this.options.api.deleteSecret(`${name}-tokens`),
    ]);
    // The PVCs are the tenant's work and their logged-in browser profiles. Last, and loud on
    // failure, for the same reason as compose's volumes: a PVC left behind is picked up by the
    // next box with this name, handing one tenant's work to their replacement.
    const failures: string[] = [];
    await Promise.all(
      VOLUMES.map(({ name: suffix }) =>
        this.options.api.deletePvc(`${name}-${suffix}`).catch((error: unknown) => {
          failures.push(`${name}-${suffix}: ${error instanceof Error ? error.message : String(error)}`);
        })
      )
    );
    if (failures.length > 0) {
      throw new KubernetesError(
        `pod and service removed but persistentvolumeclaims remain, and a later box with this name ` +
          `would inherit them: ${failures.join("; ")}`
      );
    }
  }

  /**
   * Recreate the pod — and only the pod — from the tokens the store already holds.
   *
   * The recovery for "the pod is gone but everything else survived": a node failure, an eviction,
   * or someone's `kubectl delete pod`. The PVCs and the Service are left alone — the data and the
   * address are fine (and unlike compose's restart, nothing re-publishes a port: the address is
   * Service DNS and cannot move, so the store needs no correction). The Secret is re-applied
   * because the same accident may have taken it, and the pod reads its tokens from the Secret, so
   * no token passes through a spec here either.
   */
  async restart(handle: BoxHandle): Promise<void> {
    const row = this.store.getBox(handle.id);
    const tenant = this.store.getTenant(handle.tenantId);
    if (row === undefined || tenant === undefined) {
      throw new KubernetesError(`cannot restart ${handle.externalId}: the store has lost its row`);
    }
    const name = handle.externalId;
    this.store.setBoxState(handle.id, "starting");

    // The image comes from the stored row — the pod must come back as the box it was. The
    // original spec.env is not stored (same limitation as compose's restart); what the box needs
    // to authenticate is all in the Secret.
    const decision = await this.policy.decide({
      tenantId: handle.tenantId,
      tenant,
      spec: { image: row.image },
    });
    const { secret, pod } = this.manifestsFor(handle.tenantId, name, { image: row.image }, handle.tokens, decision);

    await this.options.api.applySecret(secret);
    // A pod still holding the name is a previous incarnation: delete and wait for the name to
    // free, exactly as create does — re-applying over a terminating pod is a 409.
    if ((await this.options.api.getPod(name)) !== undefined) {
      await this.options.api.deletePod(name);
      await this.waitPodGone(name);
    }
    await this.options.api.applyPod(pod);
    try {
      await this.waitReady(name);
    } catch (error) {
      // Same bookkeeping as compose's restart: a box that did not come back is unreachable, not
      // starting forever — and the error still travels to whoever asked.
      this.store.setBoxState(handle.id, "unreachable");
      throw error;
    }

    this.store.setBoxState(handle.id, "ready");
    this.store.audit({
      tenantId: handle.tenantId,
      actor: `${this.kind}-allocator`,
      action: "restart",
      target: name,
    });
  }

  protected async locate(
    handle: BoxHandle
  ): Promise<{ boxdUrl: string; uiUrl: string; running: boolean } | undefined> {
    const name = handle.externalId;
    // Independent lookups, in parallel — this runs on every collector sweep of every box.
    const [service, pod] = await Promise.all([
      this.options.api.getService(name),
      this.options.api.getPod(name),
    ]);
    if (service === undefined && pod === undefined) {
      // Stopped, or gone. The PVC answers: stop deletes pod and service but keeps the volumes, so
      // a surviving work volume means this box is stopped and coming back — report it not-running
      // at its stable address, exactly as compose reports an exited container. No volume means
      // the box is genuinely gone.
      const work = await this.options.api.getPvc(`${name}-work`);
      if (work === undefined) return undefined;
      return { boxdUrl: handle.boxdUrl, uiUrl: handle.uiUrl, running: false };
    }
    // The address is computed, never read back: Service DNS does not drift, which is the whole
    // point of running under a scheduler. `running` is all that can change.
    return {
      boxdUrl: this.boxdUrlFor(name),
      uiUrl: this.uiUrlFor(name),
      running: pod?.status?.phase === "Running",
    };
  }
}
