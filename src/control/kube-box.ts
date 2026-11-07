/**
 * One box as Kubernetes objects — the single home of "a box is a pod" (INV-1692).
 *
 * Two callers ask for boxes in a cluster and key them differently:
 *
 *   - the control plane's `KubernetesAllocator` — one box per *tenant*, bookkept in the control
 *     store (docs/08 §4.2);
 *   - an organisation installation's per-box driver (`src/box/kubernetes-box.ts`) — one box per
 *     *box record* (company, department, personal; docs/36 Scene 4).
 *
 * What a box *is* in a cluster is the same for both and lives here once: the resource model, the
 * create / wait / stop / destroy / restart / locate semantics, the failure reasons, the config
 * digest. The callers own only the key, the bookkeeping and the placement decision. A second copy
 * of any of this is the bug AGENTS.md calls "a concept has one home".
 *
 * The resource model per box:
 *
 *   - a **Pod** running the box image, `restartPolicy: Always`;
 *   - a **ClusterIP Service** of the same name — `http://<name>.<ns>.svc:1337` never drifts;
 *   - **three PVCs** — work, config, hostd — at the paths Docker mounts them, because the image
 *     must not be able to tell which allocator launched it;
 *   - a **Secret** holding the box's tokens, injected with `envFrom` (never in the pod spec, which
 *     `kubectl describe` shows to anyone with read access);
 *   - a **NetworkPolicy** admitting ingress only from pods labelled `agentbox/role=control`, so a
 *     box can reach the internet and its orchestrator can reach it, but no box can reach another.
 */

import { createHash } from "node:crypto";
import { BOXD_PORT, UI_PORT } from "../protocol/index.ts";
import type { BoxSpec } from "./allocator.ts";
import { DEFAULT_RELAY_PROVIDER } from "./allocator.ts";
import type { KubeApi, KubeNetworkPolicy, KubePod, KubePvc, KubeSecret, KubeService } from "./kube-client.ts";
import { KubernetesError } from "./kube-client.ts";
import type { AllocationDecision } from "./policy.ts";

export const MANAGED_BY = "app.kubernetes.io/managed-by";
export const INSTANCE = "app.kubernetes.io/instance";
/** The label a box's NetworkPolicy admits. deploy/kubernetes/control-plane.yaml carries it. */
export const ROLE_LABEL = "agentbox/role";
export const CONTROL_ROLE = "control";
/** Where the launch-config digest lives on the pod (INV-712's drift check). */
export const DIGEST_ANNOTATION = "agentbox/config-digest";

/**
 * The three persistent volumes every box gets. PVC construction, the pod's mounts and destroy's
 * loop all derive from this one list: a volume added in one place and forgotten in another is
 * either a mount that never binds or data destroy leaves behind.
 */
export const VOLUMES = [
  { name: "work", mountPath: "/home/box/work" },
  { name: "config", mountPath: "/home/box/.config" },
  { name: "hostd", mountPath: "/home/hostd/.agentbox" },
] as const;

/** A deleted pod's name still held after a minute is a wedged kubelet, not a slow one. */
const POD_DELETION_WAIT_MS = 60_000;

/**
 * Waiting reasons that will not resolve by waiting. Image *pull* back-off is not here: a registry
 * blip recovers, and the timeout reports it by name if it does not.
 */
const HOPELESS = new Set(["InvalidImageName", "ErrImageNeverPull", "CreateContainerConfigError"]);

/**
 * A box that did not start, with the platform's reason attached — the `state_reason` INV-712 asks
 * the waiting page and the fleet view to show instead of "starting" forever.
 */
export class BoxStartError extends KubernetesError {
  constructor(
    message: string,
    /** A short machine word: ImagePullBackOff, Unschedulable, Timeout, Failed, Deleted, Vanished. */
    readonly reason: string
  ) {
    super(message);
    this.name = "BoxStartError";
  }
}

export interface KubeBoxTokens {
  box: string;
  /** Only a box running its own orchestrator serves a UI; one driven from outside has none. */
  ui?: string;
  relay?: string;
}

/** Everything that decides one box's objects. The caller chooses the name and the owner labels. */
export interface KubeBoxPlacement {
  name: string;
  /** Owner labels (`agentbox/tenant` or `agentbox/box`) — added to every object, never selected on. */
  owner: Record<string, string>;
  spec: BoxSpec;
  tokens: KubeBoxTokens;
  decision: AllocationDecision;
}

export interface KubeBoxesOptions {
  api: KubeApi;
  /** Encoded in every box's address; keep it in agreement with the client's. */
  namespace: string;
  /** The image when a spec names none. A function so reading config waits until it is needed. */
  defaultImage: () => string;
  storageClassName?: string;
  imagePullPolicy?: string;
  /** Set: the relay endpoint and the per-box relay token reach the box through the Secret. */
  relayUrl?: string;
  relayProvider?: string;
  /** Plain env the caller fixes for every box; a spec's env cannot override these names. */
  fixedEnv?: Record<string, string>;
  /** How long to wait for Ready. Pulling the image dominates; five minutes. */
  startTimeoutMs?: number;
  pollIntervalMs?: number;
  onOutput?: (line: string) => void;
}

/** Where a box is right now, asked of the cluster rather than remembered. */
export interface KubeBoxLocation {
  boxdUrl: string;
  uiUrl: string;
  running: boolean;
  /** The digest the pod was launched with; undefined when there is no pod. */
  digest?: string;
}

/**
 * Run independent calls in parallel without dropping rejections on the floor: every call settles
 * and the first failure is the one thrown.
 */
export async function allOrFirst(calls: readonly (() => Promise<void>)[]): Promise<void> {
  const results = await Promise.allSettled(calls.map(call => call()));
  const failed = results.find(result => result.status === "rejected");
  if (failed !== undefined) throw (failed as PromiseRejectedResult).reason;
}

const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export class KubeBoxes {
  readonly namespace: string;

  constructor(private readonly options: KubeBoxesOptions) {
    this.namespace = options.namespace;
    if (!DNS_LABEL.test(this.namespace)) {
      throw new KubernetesError(
        `namespace "${this.namespace}" is not a DNS-1123 label (lowercase letters, digits and ` +
          `dashes, not starting or ending with a dash) — every box address derives from it`
      );
    }
  }

  /** The addresses never move — that is the entire reason the Service exists. */
  boxdUrlFor(name: string): string {
    return `http://${name}.${this.namespace}.svc:${BOXD_PORT}`;
  }

  uiUrlFor(name: string): string {
    return `http://${name}.${this.namespace}.svc:${UI_PORT}`;
  }

  private labelsFor(placement: KubeBoxPlacement): Record<string, string> {
    return {
      // Policy labels first, ownership last: the Service selects its pod on INSTANCE, so a policy
      // that could overwrite these would point the Service at nothing — or at another box's pod.
      ...placement.decision.labels,
      [MANAGED_BY]: "agentbox",
      ...placement.owner,
      [INSTANCE]: placement.name,
    };
  }

  private env(placement: KubeBoxPlacement): { name: string; value: string }[] {
    const fixed = this.options.fixedEnv ?? {};
    return [
      ...Object.entries(fixed).map(([name, value]) => ({ name, value })),
      // What the caller fixed is the caller's to set, never a spec's to unset (INV-1543).
      ...Object.entries(placement.spec.env ?? {})
        .filter(([key]) => !(key in fixed))
        .map(([name, value]) => ({ name, value })),
    ];
  }

  /**
   * The launch configuration as one digest: image, plain env (keys and values), resources,
   * placement — and the Secret by *name* only. A rotated token must not read as drift; a pod
   * pointed at a different Secret must (INV-712).
   */
  digestOf(placement: KubeBoxPlacement): string {
    const { decision } = placement;
    const canonical = JSON.stringify({
      image: this.imageOf(placement),
      env: this.env(placement),
      secret: `${placement.name}-tokens`,
      resources: decision.resources,
      storage: decision.storageSize,
      nodeSelector: decision.nodeSelector ?? null,
      tolerations: decision.tolerations ?? null,
      priorityClassName: decision.priorityClassName ?? null,
    });
    return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  }

  private imageOf(placement: KubeBoxPlacement): string {
    return placement.spec.image || this.options.defaultImage();
  }

  /** Every object one box owns, named and labelled, before any of it is sent. */
  manifests(placement: KubeBoxPlacement): {
    secret: KubeSecret;
    pvcs: KubePvc[];
    service: KubeService;
    networkPolicy: KubeNetworkPolicy;
    pod: KubePod;
  } {
    const { name, tokens, decision } = placement;
    const labels = this.labelsFor(placement);

    // Everything another box — or anyone with pod-read access — must not learn.
    const secretData: Record<string, string> = { BOXD_TOKEN: tokens.box };
    if (tokens.ui !== undefined) secretData.AGENTBOX_UI_TOKEN = tokens.ui;
    if (this.options.relayUrl !== undefined && tokens.relay !== undefined) {
      // Together these make the box's provider layer take the relay as its endpoint and this
      // token as its credential, while the capabilities follow the named provider's model.
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

    const pvcs: KubePvc[] = VOLUMES.map(({ name: suffix }) => ({
      metadata: { name: `${name}-${suffix}`, labels },
      spec: {
        accessModes: ["ReadWriteOnce"],
        resources: { requests: { storage: decision.storageSize } },
        ...(this.options.storageClassName !== undefined ? { storageClassName: this.options.storageClassName } : {}),
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

    // Ingress only from the orchestrator. Egress is left open: a box browses the web and calls
    // its relay. Another box is a pod without the control label, so it is refused — measured on
    // a kind cluster, where the same probe answered before the policy and timed out after.
    const networkPolicy: KubeNetworkPolicy = {
      metadata: { name, labels },
      spec: {
        podSelector: { matchLabels: { [INSTANCE]: name } },
        policyTypes: ["Ingress"],
        ingress: [{ from: [{ podSelector: { matchLabels: { [ROLE_LABEL]: CONTROL_ROLE } } }] }],
      },
    };

    const pod: KubePod = {
      metadata: { name, labels, annotations: { [DIGEST_ANNOTATION]: this.digestOf(placement) } },
      spec: {
        restartPolicy: "Always",
        // A box runs code its agents write; the last thing it needs is a mounted ServiceAccount
        // credential for the cluster it lives in, or service-link env vars advertising it.
        automountServiceAccountToken: false,
        enableServiceLinks: false,
        ...(decision.nodeSelector !== undefined ? { nodeSelector: decision.nodeSelector } : {}),
        ...(decision.tolerations !== undefined ? { tolerations: decision.tolerations } : {}),
        ...(decision.priorityClassName !== undefined ? { priorityClassName: decision.priorityClassName } : {}),
        containers: [
          {
            name: "box",
            image: this.imageOf(placement),
            imagePullPolicy: this.options.imagePullPolicy ?? "IfNotPresent",
            ports: [
              { name: "boxd", containerPort: BOXD_PORT },
              { name: "ui", containerPort: UI_PORT },
            ],
            // By reference, never by value: describe renders this as a secret name.
            envFrom: [{ secretRef: { name: `${name}-tokens` } }],
            env: this.env(placement),
            resources: {
              requests: {
                memory: decision.resources.memoryRequest,
                ...(decision.resources.cpuRequest !== undefined ? { cpu: decision.resources.cpuRequest } : {}),
              },
              limits: {
                memory: decision.resources.memoryLimit,
                ...(decision.resources.cpuLimit !== undefined ? { cpu: decision.resources.cpuLimit } : {}),
              },
            },
            // boxd's /health is unauthenticated by design, so a probe gives away nothing.
            readinessProbe: {
              httpGet: { path: "/health", port: BOXD_PORT },
              periodSeconds: 5,
              timeoutSeconds: 3,
              // A box's desktop takes seconds to come up; the default threshold of 3 would mark it
              // NotReady during a perfectly normal boot.
              failureThreshold: 12,
            },
            volumeMounts: [
              ...VOLUMES.map(({ name: volume, mountPath }) => ({ name: volume, mountPath })),
              { name: "shm", mountPath: "/dev/shm" },
            ],
          },
        ],
        volumes: [
          ...VOLUMES.map(({ name: volume }) => ({ name: volume, persistentVolumeClaim: { claimName: `${name}-${volume}` } })),
          // Docker's `--shm-size 1g`: Chrome needs more than the default 64MiB of /dev/shm.
          { name: "shm", emptyDir: { medium: "Memory", sizeLimit: "1Gi" } },
        ],
      },
    };
    return { secret, pvcs, service, networkPolicy, pod };
  }

  /**
   * Bring a box into being and wait until it is Ready.
   *
   * A pod already carrying this name is a previous incarnation: its baked-in tokens are not the
   * ones just issued, so it is recreated, never adopted. The PVCs are kept — that is where the
   * work lives. A create that fails half-way removes the pod, service, policy and secret (the
   * secret holds live tokens) and keeps the volumes.
   */
  async create(placement: KubeBoxPlacement): Promise<{ boxdUrl: string; uiUrl: string }> {
    const { name } = placement;
    const { secret, pvcs, service, networkPolicy, pod } = this.manifests(placement);
    const existing = await this.options.api.getPod(name);
    if (existing !== undefined) {
      this.options.onOutput?.(
        `${name} already exists (${existing.status?.phase ?? "unknown"}); recreating it with this box's tokens — volumes are kept`
      );
      await this.options.api.deletePod(name);
      await this.waitPodGone(name);
    }
    // Secret, PVCs (in parallel), Service, NetworkPolicy, then the pod that references them all —
    // the policy before the pod, so there is no moment the box is up and open.
    try {
      await this.options.api.applySecret(secret);
      await allOrFirst(pvcs.map(pvc => () => this.options.api.applyPvc(pvc)));
      await this.options.api.applyService(service);
      await this.options.api.applyNetworkPolicy(networkPolicy);
      await this.options.api.applyPod(pod);
      await this.waitReady(name);
    } catch (error) {
      await this.removeOrphans(name);
      throw error;
    }
    return { boxdUrl: this.boxdUrlFor(name), uiUrl: this.uiUrlFor(name) };
  }

  /**
   * Recreate the pod — and only the pod — from the tokens the caller already holds: the recovery
   * for "the pod is gone but everything else survived" (node failure, eviction, a hand on
   * kubectl, a server that restarted while its boxes were stopped). The Secret, Service and
   * policy are re-applied because the same accident may have taken them; the PVCs are untouched.
   */
  async restart(placement: KubeBoxPlacement): Promise<void> {
    const { name } = placement;
    const { secret, service, networkPolicy, pod } = this.manifests(placement);
    await this.options.api.applySecret(secret);
    await this.options.api.applyService(service);
    await this.options.api.applyNetworkPolicy(networkPolicy);
    if ((await this.options.api.getPod(name)) !== undefined) {
      await this.options.api.deletePod(name);
      await this.waitPodGone(name);
    }
    await this.options.api.applyPod(pod);
    await this.waitReady(name);
  }

  /** Pod and Service go; PVCs, Secret and policy stay — reversible, like compose's stop. */
  async stop(name: string): Promise<void> {
    await allOrFirst([() => this.options.api.deletePod(name), () => this.options.api.deleteService(name)]);
  }

  /** Everything, volumes last and loud: a PVC left behind is inherited by the next box of this name. */
  async destroy(name: string): Promise<void> {
    await allOrFirst([
      () => this.options.api.deletePod(name),
      () => this.options.api.deleteService(name),
      () => this.options.api.deleteNetworkPolicy(name),
      () => this.options.api.deleteSecret(`${name}-tokens`),
    ]);
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
   * Where a box is: undefined when it is genuinely gone (no pod, no service, no work volume);
   * not-running at its stable address when stopped (volumes kept); running means Ready, not
   * phase Running — a container whose desktop has not come up answers TCP and nothing else.
   */
  async locate(name: string): Promise<KubeBoxLocation | undefined> {
    const [service, pod] = await Promise.all([this.options.api.getService(name), this.options.api.getPod(name)]);
    if (service === undefined && pod === undefined) {
      const work = await this.options.api.getPvc(`${name}-work`);
      if (work === undefined) return undefined;
      return { boxdUrl: this.boxdUrlFor(name), uiUrl: this.uiUrlFor(name), running: false };
    }
    const digest = pod?.metadata.annotations?.[DIGEST_ANNOTATION];
    return {
      boxdUrl: this.boxdUrlFor(name),
      uiUrl: this.uiUrlFor(name),
      running: pod?.status?.conditions?.some(c => c.type === "Ready" && c.status === "True") === true,
      ...(digest !== undefined ? { digest } : {}),
    };
  }

  /** DELETE returns when the pod is *marked*; re-creating before the name frees is a 409 loop. */
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

  /** Cleanup failures are reported, not thrown: the original error is the one the caller needs. */
  private async removeOrphans(name: string): Promise<void> {
    const results = await Promise.allSettled([
      this.options.api.deletePod(name),
      this.options.api.deleteService(name),
      this.options.api.deleteNetworkPolicy(name),
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
   * Wait for the pod's Ready condition, and say *why* when it does not come: the container's
   * waiting reason (ImagePullBackOff, CreateContainerConfigError) or the scheduler's
   * (Unschedulable), so the person waiting reads a cause instead of a spinner.
   */
  private async waitReady(name: string): Promise<void> {
    const timeoutMs = this.options.startTimeoutMs ?? 5 * 60 * 1000;
    const deadline = Date.now() + timeoutMs;
    const interval = this.options.pollIntervalMs ?? 2_000;
    for (;;) {
      const pod = await this.options.api.getPod(name);
      if (pod === undefined) {
        throw new BoxStartError(`pod ${name} vanished while waiting for it to become ready`, "Vanished");
      }
      if (pod.status?.phase === "Failed") {
        throw new BoxStartError(`pod ${name} failed before it became ready`, "Failed");
      }
      if (pod.metadata.deletionTimestamp !== undefined) {
        throw new BoxStartError(
          `pod ${name} was deleted while waiting for it to become ready (node drain, eviction, or ` +
            `a hand on kubectl) — recreating it is restart's job, not this wait's`,
          "Deleted"
        );
      }
      if (pod.status?.conditions?.some(c => c.type === "Ready" && c.status === "True") === true) return;
      const waiting = pod.status?.containerStatuses?.find(c => c.state?.waiting?.reason !== undefined)?.state?.waiting;
      const unscheduled = pod.status?.conditions?.find(c => c.type === "PodScheduled" && c.status === "False");
      const reason = waiting?.reason ?? unscheduled?.reason;
      const detail = waiting?.message ?? unscheduled?.message;
      if (waiting?.reason !== undefined && HOPELESS.has(waiting.reason)) {
        throw new BoxStartError(`pod ${name} cannot start: ${waiting.reason}${detail ? ` — ${detail}` : ""}`, waiting.reason);
      }
      if (Date.now() > deadline) {
        throw new BoxStartError(
          `pod ${name} did not become ready within ${timeoutMs}ms (phase: ${pod.status?.phase ?? "unknown"}` +
            `${reason !== undefined ? `, ${reason}` : ""})${detail ? ` — ${detail}` : " — the image pull is the usual suspect"}`,
          reason ?? "Timeout"
        );
      }
      await new Promise(resolve => setTimeout(resolve, interval));
    }
  }
}
