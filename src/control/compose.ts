/**
 * One container per tenant, on one host.
 *
 * The first allocator that is genuinely multi-tenant, and enough for a long time: everything in the
 * control-plane design except cluster scheduling is exercised here
 * ([../docs/08-control-plane.md](../docs/08-control-plane.md) §4.2), which is why it comes before
 * Kubernetes rather than after.
 *
 * It is a thin layer over `BoxManager`, deliberately. That class already knows how to run the image,
 * wait for the desktop, and — the part that matters most — put the two things that must survive an
 * upgrade on named volumes derived from the container name. Per-tenant container names therefore
 * give per-tenant volumes for free, and a second implementation of that logic is a second chance to
 * get the volume names wrong and destroy someone's work.
 *
 * Two things this has to do that the single-box CLI never had to:
 *
 *   - **A UI token per box.** One token across the fleet would mean anyone who reached one tenant's
 *     UI could drive every tenant's agents. The control plane issues one per box and it goes in as
 *     environment.
 *   - **Ephemeral host ports.** Two boxes cannot both publish 7777. Docker picks, and the port is
 *     read back afterwards rather than assumed — which is also why `boxdUrl` and `uiUrl` are stored
 *     rather than computed from the tenant name.
 *
 * What it does not do: schedule. One host, no rolling upgrade, no bin-packing. The limit is that
 * host's memory divided by the per-box ceiling, and nothing here pretends otherwise.
 */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BoxManager, DockerError, defaultBoxConfig } from "../box/docker.ts";
import type { BoxStatus, ContainerState } from "../box/docker.ts";
import type { BoxSpec, AllocatorKind, BoxHandle } from "./allocator.ts";
import { StoreBackedAllocator } from "./allocator.ts";
import type { BoxState, ControlStore } from "./store.ts";

export interface ComposeAllocatorOptions {
  image?: string;
  /**
   * Prefix for container and volume names. A tenant's box is `<prefix>-<tenant>`, and its volumes
   * are that plus `-work`, `-config` and `-hostd`.
   */
  prefix?: string;
  /** How long to wait for a box to answer before giving up on it. Pulling an image is slow. */
  startTimeoutMs?: number;
  onOutput?: (line: string) => void;
  /**
   * How a volume is removed. Injected rather than imported so `destroy` is testable without an
   * engine — the one operation whose test must not be "trust me".
   */
  removeVolume?: (name: string) => Promise<void>;
  /**
   * How a container is managed. Injected for the same reason the provisioner seam exists: the whole
   * suite has to pass with no Docker on PATH, and a seam that is never substituted is a seam
   * nobody has checked.
   */
  managerFactory?: (config: Parameters<typeof defaultBoxConfig>[0]) => ContainerManager;
}

/** The part of `BoxManager` this allocator uses. Narrow on purpose: it is also the test's contract. */
export interface ContainerManager {
  state(): Promise<ContainerState>;
  up(options?: { recreate?: boolean; onOutput?: (line: string) => void }): Promise<{
    status: BoxStatus;
  }>;
  down(options?: { remove?: boolean }): Promise<void>;
}

/**
 * A tenant name turned into a container name.
 *
 * Predictable, because the name is how a box is found again after the control plane restarts. Also
 * the place a tenant's own text reaches a command line, so anything outside `[a-z0-9-]` is replaced
 * rather than escaped: a name that survives is worth more than a name that round-trips.
 *
 * A name with nothing usable in it — `北京公司`, `🚀`, `...` — is *not* an error. Docker cannot hold
 * those characters, but refusing the tenant would mean a system that only serves people whose
 * company name is spelt in ASCII. Such a name falls back to a short hash of the original, which is
 * stable, unique, and collision-free where a truncation would not be. The readable name still lives
 * in the store; this string only has to identify a container.
 */
export function containerNameFor(prefix: string, tenantName: string): string {
  const safe = tenantName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  if (safe !== "") return `${prefix}-${safe}`;
  const digest = createHash("sha256").update(tenantName).digest("hex").slice(0, 12);
  return `${prefix}-t${digest}`;
}

export class ComposeAllocator extends StoreBackedAllocator {
  readonly kind: AllocatorKind = "compose";

  private readonly prefix: string;
  private readonly defaultImage: string;

  constructor(
    store: ControlStore,
    private readonly options: ComposeAllocatorOptions = {}
  ) {
    super(store);
    this.prefix = options.prefix ?? "agentbox";
    this.defaultImage = options.image ?? defaultBoxConfig().image;
  }

  /** A manager for one tenant's container. Cheap: it holds configuration, not a connection. */
  private managerFor(
    containerName: string,
    spec: BoxSpec,
    tokens: { box: string; ui: string }
  ): ContainerManager {
    const make = this.options.managerFactory ?? (config => new BoxManager(defaultBoxConfig(config)));
    return make({
        containerName,
        image: spec.image || this.defaultImage,
        token: tokens.box,
        uiToken: tokens.ui,
        // Docker picks both, because a second tenant on this host cannot have the first's ports.
        boxdPort: 0,
        uiPort: 0,
        // The whole point of this allocator: the orchestrator lives in the box, so the only thing
        // outside a container is a browser.
        withHost: true,
        runArgs: Object.entries(spec.env ?? {}).flatMap(([key, value]) => [
          "--env",
          `${key}=${value}`,
        ]),
    });
  }

  protected async create(
    tenantId: string,
    boxId: string,
    spec: BoxSpec,
    tokens: { box: string; ui: string }
  ): Promise<{ externalId: string; boxdUrl: string; uiUrl: string; state: BoxState }> {
    const tenant = this.store.getTenant(tenantId);
    if (tenant === undefined) throw new Error(`no such tenant: ${tenantId}`);
    const containerName = containerNameFor(this.prefix, tenant.name);
    const manager = this.managerFor(containerName, spec, tokens);

    // A container already carrying this name is the previous incarnation of this tenant's box —
    // the control plane restarted, or a row was lost. Adopting it is wrong: its baked-in tokens
    // are not the ones just issued, so nothing would authenticate. Recreating it keeps the
    // volumes, which is where the tenant's work actually lives.
    const existing = await manager.state();
    const recreate = existing !== "missing";
    if (recreate) {
      this.options.onOutput?.(
        `${containerName} already exists (${existing}); recreating it with this box's tokens — ` +
          `volumes are kept`
      );
    }

    const { status } = await manager.up({ recreate, onOutput: this.options.onOutput });
    if (status.boxdUrl === undefined || status.uiUrl === undefined) {
      // Both are read back from Docker rather than assumed. A box whose ports did not publish is
      // unreachable, and reporting a URL for it would turn that into a confusing 404 later.
      throw new DockerError(
        `${containerName} started but did not publish both ports ` +
          `(boxd: ${status.boxdUrl ?? "none"}, ui: ${status.uiUrl ?? "none"})`
      );
    }

    return {
      externalId: containerName,
      boxdUrl: status.boxdUrl,
      uiUrl: status.uiUrl,
      state: "ready",
    };
  }

  protected async stopExternal(handle: BoxHandle): Promise<void> {
    // Stop, do not remove: the container's own layer is disposable but stopping is meant to be
    // reversible, and `docker start` is much faster than a fresh `run`.
    await this.managerFor(handle.externalId, { image: this.defaultImage }, handle.tokens).down({
      remove: false,
    });
  }

  protected async destroyExternal(handle: BoxHandle): Promise<void> {
    await this.managerFor(handle.externalId, { image: this.defaultImage }, handle.tokens).down({
      remove: true,
    });
    // The volumes are the tenant's work and their logged-in browser profiles. Removing them is the
    // one irreversible thing this system does, which is why only `destroy` reaches it, why it is
    // audited by the caller, and why a failure here is reported rather than swallowed.
    await this.removeVolumes(handle.externalId);
  }

  private async removeVolumes(containerName: string): Promise<void> {
    const names = ["work", "config", "hostd"].map(suffix => `${containerName}-${suffix}`);
    const failures: string[] = [];
    for (const name of names) {
      try {
        await (this.options.removeVolume ?? dockerVolumeRemove)(name);
      } catch (error) {
        failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (failures.length > 0) {
      // Loud: a volume left behind will be picked up by the next box with the same tenant name,
      // which would hand one tenant's work to their replacement.
      throw new DockerError(
        `container removed but volumes remain, and a later box with this name would inherit them: ` +
          failures.join("; ")
      );
    }
  }

  /**
   * Restarts a box that is not answering, keeping its volumes.
   *
   * The recovery the design calls for: restart the smallest thing. Never recreate a container to
   * recover a process — the box supervises its own components and gives up loudly when it cannot
   * (see `component-health.ts`), so a container restart here means the container itself is wrong.
   */
  async restart(handle: BoxHandle): Promise<void> {
    const manager = this.managerFor(
      handle.externalId,
      { image: this.defaultImage },
      handle.tokens
    );
    await manager.down({ remove: false });
    this.store.setBoxState(handle.id, "starting");
    const { status } = await manager.up({ onOutput: this.options.onOutput });
    this.store.setBoxState(handle.id, status.state === "running" ? "ready" : "unreachable");
    this.store.audit({
      tenantId: handle.tenantId,
      actor: "compose-allocator",
      action: "restart",
      target: handle.externalId,
    });
  }
}

async function dockerVolumeRemove(name: string): Promise<void> {
  await promisify(execFile)("docker", ["volume", "rm", "--force", name], { timeout: 30_000 });
}
