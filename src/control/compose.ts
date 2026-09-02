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
import type { BoxSpec, AllocatorKind, BoxHandle, BoxTokens } from "./allocator.ts";
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
  /**
   * The model relay, as the box will reach it — usually `http://host.docker.internal:8788`.
   *
   * Set, a box is given this and its own relay token instead of a provider key, and the operator's
   * credential never enters a container. Unset, boxes keep taking a key from this process's
   * environment, which is what happened before the relay existed.
   */
  relayUrl?: string;
  /**
   * The control plane, as the box will reach it — usually `http://host.docker.internal:8080`.
   * Set, a box is told where to publish templates to (docs/29 §6 B), with its own token.
   */
  controlUrl?: string;
  /**
   * Which provider's capabilities a relayed box should assume.
   *
   * The relay decides where a token's traffic actually goes; this only tells the box which model and
   * which optional features to use. The two have to agree, and the control plane is what knows both.
   */
  relayProvider?: string;
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
  status(): Promise<BoxStatus>;
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
export function containerNameFor(prefix: string, tenantName: string, tenantId: string): string {
  // The tenant id, always, not only when the name is unusable.
  //
  // Because the transform above is lossy in both directions: "Acme Inc" and "Acme-Inc" both flatten
  // to `acme-inc`, and two names sharing a forty-character prefix truncate to the same string. The
  // *volumes* are named from this, so a collision does not merely confuse a listing — allocating
  // the second tenant recreates the first tenant's container against the first tenant's work
  // volume, handing over their files and their logged-in browser.
  //
  // Short enough to keep the name readable, long enough that a collision is not a thing to plan
  // for. The readable name still lives in the store; this string only has to identify a container.
  const suffix = createHash("sha256").update(tenantId).digest("hex").slice(0, 8);
  const safe = tenantName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  // A name with nothing usable in it — `北京公司`, `🚀`, `...` — is not an error; it just carries no
  // readable part.
  return safe === "" ? `${prefix}-t${suffix}` : `${prefix}-${safe}-${suffix}`;
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
    tokens: BoxTokens
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
        // With a relay, this machine's provider credentials must not be passed in — otherwise the
        // box has both a relay token and the real key, and the relay protects nothing.
        relayed: this.options.relayUrl !== undefined && tokens.relay !== undefined,
        runArgs: [
          // The relay, when there is one. This is what replaces a provider key in the box: the box
          // is told an address and a token of its own, and the real credential stays outside.
          ...(this.options.relayUrl !== undefined && tokens.relay !== undefined
            ? [
                "--env",
                `AGENTBOX_BASE_URL=${this.options.relayUrl}`,
                "--env",
                `AGENTBOX_API_KEY=${tokens.relay}`,
                // Named so `resolveProvider` reads the two above rather than a provider preset — the
                // capabilities still come from the model, but the endpoint and credential do not.
                "--env",
                "AGENTBOX_KEY_ENV=AGENTBOX_API_KEY",
                // The provider is named as well, because a bare base URL selects the `custom` preset
                // — which defaults vision, caching and thinking off and would leave an agent unable
                // to see its own screen. Behind a relay only the endpoint and credential change; the
                // capabilities still follow the model.
                "--env",
                `AGENTBOX_PROVIDER=${this.options.relayProvider ?? "anthropic"}`,
                // host.docker.internal resolves on Docker Desktop already; the mapping is what makes
                // the same address work on a Linux engine.
                "--add-host",
                "host.docker.internal:host-gateway",
              ]
            : []),
          ...(this.options.controlUrl !== undefined
            ? ["--env", `AGENTBOX_CONTROL_URL=${this.options.controlUrl}`, "--add-host", "host.docker.internal:host-gateway"]
            : []),
          ...Object.entries(spec.env ?? {}).flatMap(([key, value]) => [
            "--env",
            `${key}=${value}`,
          ]),
        ],
    });
  }

  protected async create(
    tenantId: string,
    _boxId: string,
    spec: BoxSpec,
    tokens: BoxTokens
  ): Promise<{ externalId: string; boxdUrl: string; uiUrl: string; state: BoxState }> {
    const tenant = this.store.getTenant(tenantId);
    if (tenant === undefined) throw new Error(`no such tenant: ${tenantId}`);
    const containerName = containerNameFor(this.prefix, tenant.name, tenant.id);
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

  /**
   * Asks Docker where this container's ports are now.
   *
   * The reason `reconcile` exists at all: `docker restart` on a container published with an
   * ephemeral port gives it a *different* host port, and these containers carry
   * `--restart unless-stopped`, so a daemon restart or a host reboot re-maps all of them at once.
   */
  protected async locate(
    handle: BoxHandle
  ): Promise<{ boxdUrl: string; uiUrl: string; running: boolean } | undefined> {
    const manager = this.managerFor(
      handle.externalId,
      { image: this.defaultImage },
      handle.tokens
    );
    const state = await manager.state();
    if (state === "missing") return undefined;
    const status = await manager.status();
    // A stopped container publishes nothing, so there is no address to correct — but it is not
    // gone either. Keeping the last known address is right: it will be republished on start, and
    // reconcile runs again then.
    if (status.boxdUrl === undefined || status.uiUrl === undefined) {
      return { boxdUrl: handle.boxdUrl, uiUrl: handle.uiUrl, running: false };
    }
    return { boxdUrl: status.boxdUrl, uiUrl: status.uiUrl, running: status.state === "running" };
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
    // The ports moved: `up` republished them. Correcting the store here rather than waiting for the
    // collector to notice means the gateway does not serve a 502 in between.
    if (status.boxdUrl !== undefined && status.uiUrl !== undefined) {
      this.store.updateBoxLocation(handle.id, status.boxdUrl, status.uiUrl);
    }
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
