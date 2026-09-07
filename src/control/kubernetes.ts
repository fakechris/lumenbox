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
 * second naming scheme is a second chance to hand one tenant another's volumes.
 */

import { createHash } from "node:crypto";
import { defaultBoxConfig } from "../box/docker.ts";
import { BOXD_PORT, UI_PORT } from "../protocol/index.ts";
import type { AllocatorKind, BoxHandle, BoxSpec, BoxTokens } from "./allocator.ts";
import { StoreBackedAllocator } from "./allocator.ts";
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

export class KubernetesAllocator extends StoreBackedAllocator {
  readonly kind: AllocatorKind = "kubernetes";

  private readonly namespace: string;
  private readonly prefix: string;
  private readonly defaultImage: string;
  private readonly policy: AllocationPolicy;

  constructor(
    store: ControlStore,
    private readonly options: KubernetesAllocatorOptions
  ) {
    super(store);
    this.namespace = options.namespace ?? "agentbox";
    this.prefix = options.prefix ?? "agentbox";
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
      [MANAGED_BY]: "agentbox",
      [INSTANCE]: name,
      [TENANT_LABEL]: this.tenantLabel(tenantId),
      ...extra,
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
      secretData.AGENTBOX_PROVIDER = this.options.relayProvider ?? "anthropic";
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
    const pvcs: KubePvc[] = (
      [
        ["work", "/home/box/work"],
        ["config", "/home/box/.config"],
        ["hostd", "/home/hostd/.agentbox"],
      ] as const
    ).map(([suffix]) => ({
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
              { name: "work", mountPath: "/home/box/work" },
              { name: "config", mountPath: "/home/box/.config" },
              { name: "hostd", mountPath: "/home/hostd/.agentbox" },
              { name: "shm", mountPath: "/dev/shm" },
            ],
          },
        ],
        volumes: [
          { name: "work", persistentVolumeClaim: { claimName: `${name}-work` } },
          { name: "config", persistentVolumeClaim: { claimName: `${name}-config` } },
          { name: "hostd", persistentVolumeClaim: { claimName: `${name}-hostd` } },
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
    // Recreating keeps the PVCs, which is where the tenant's work actually lives.
    const existing = await this.options.api.getPod(name);
    if (existing !== undefined) {
      this.options.onOutput?.(
        `${name} already exists (${existing.status?.phase ?? "unknown"}); recreating it with ` +
          `this box's tokens — volumes are kept`
      );
      await this.options.api.deletePod(name);
    }

    // Secret first: the pod references it by name and Kubernetes starts a pod whose secret is
    // missing only after the secret appears — but ordering it first makes the intent legible and
    // the startup immediate. PVCs before the pod for the same reason. Service last before the
    // pod, so the DNS name resolves the moment the pod is Ready.
    await this.options.api.applySecret(secret);
    for (const pvc of pvcs) await this.options.api.applyPvc(pvc);
    await this.options.api.applyService(service);
    await this.options.api.applyPod(pod);

    await this.waitReady(name);

    return {
      externalId: name,
      boxdUrl: this.boxdUrlFor(name),
      uiUrl: this.uiUrlFor(name),
      state: "ready",
    };
  }

  /** The addresses never move — that is the entire reason the Service exists. */
  private boxdUrlFor(name: string): string {
    return `http://${name}.${this.namespace}.svc:${BOXD_PORT}`;
  }

  private uiUrlFor(name: string): string {
    return `http://${name}.${this.namespace}.svc:${UI_PORT}`;
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
    const deadline = Date.now() + (this.options.startTimeoutMs ?? 5 * 60 * 1000);
    const interval = this.options.pollIntervalMs ?? 2_000;
    for (;;) {
      const pod = await this.options.api.getPod(name);
      if (pod === undefined) {
        throw new KubernetesError(`pod ${name} vanished while waiting for it to become ready`);
      }
      if (pod.status?.phase === "Failed") {
        throw new KubernetesError(`pod ${name} failed before it became ready`);
      }
      const ready = pod.status?.conditions?.some(c => c.type === "Ready" && c.status === "True");
      if (ready === true) return;
      if (Date.now() > deadline) {
        throw new KubernetesError(
          `pod ${name} did not become ready within ${this.options.startTimeoutMs ?? 5 * 60 * 1000}ms ` +
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
    await this.options.api.deletePod(handle.externalId);
    await this.options.api.deleteService(handle.externalId);
  }

  protected async destroyExternal(handle: BoxHandle): Promise<void> {
    const name = handle.externalId;
    await this.options.api.deletePod(name);
    await this.options.api.deleteService(name);
    await this.options.api.deleteSecret(`${name}-tokens`);
    // The PVCs are the tenant's work and their logged-in browser profiles. Last, and loud on
    // failure, for the same reason as compose's volumes: a PVC left behind is picked up by the
    // next box with this name, handing one tenant's work to their replacement.
    const failures: string[] = [];
    for (const suffix of ["work", "config", "hostd"]) {
      try {
        await this.options.api.deletePvc(`${name}-${suffix}`);
      } catch (error) {
        failures.push(`${name}-${suffix}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (failures.length > 0) {
      throw new KubernetesError(
        `pod and service removed but persistentvolumeclaims remain, and a later box with this name ` +
          `would inherit them: ${failures.join("; ")}`
      );
    }
  }

  protected async locate(
    handle: BoxHandle
  ): Promise<{ boxdUrl: string; uiUrl: string; running: boolean } | undefined> {
    const name = handle.externalId;
    const service = await this.options.api.getService(name);
    const pod = await this.options.api.getPod(name);
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
