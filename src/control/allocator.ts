/**
 * Getting a box for a tenant.
 *
 * The existing `BoxProvisioner` answers "where is *the* box". This is one level up: "which box is
 * this person's, and make one if they have none". Three implementations are named here because the
 * point of drawing the seam now is that `kubernetes` has to be a substitution later rather than a
 * rewrite ([../docs/08-control-plane.md](../docs/08-control-plane.md) §4).
 *
 * The property that matters most, and the one most likely to be got wrong:
 *
 * > **`allocate` is idempotent per tenant.** Asking twice returns the same box.
 *
 * That is what makes a retried request after a timeout safe, and a timeout on box creation is the
 * normal case rather than the exception — pulling an image takes minutes. It is enforced in two
 * places on purpose: this code looks first, and the store's unique index refuses a second live box
 * even if two callers race past the look. Idempotency that rests only on checking first is a race
 * with a comment on it.
 */

import { randomBytes, randomUUID } from "node:crypto";
import type { BoxRow, BoxState, ControlStore } from "./store.ts";

export type AllocatorKind = "static" | "compose" | "kubernetes";

export interface BoxSpec {
  image: string;
  /** Passed to the box as environment. Provider configuration lives here for now. */
  env?: Record<string, string>;
}

export interface BoxHandle {
  tenantId: string;
  /** Our id for it. Stable across restarts of the thing it names. */
  id: string;
  /** Container or pod name — how the allocator finds it again. */
  externalId: string;
  boxdUrl: string;
  uiUrl: string;
  tokens: { box: string; ui: string };
  createdAt: string;
  state: BoxState;
}

export interface BoxAllocator {
  readonly kind: AllocatorKind;
  /** Idempotent per tenant: the same tenant gets the same box. */
  allocate(tenantId: string, spec: BoxSpec): Promise<BoxHandle>;
  find(tenantId: string): Promise<BoxHandle | undefined>;
  /** Keeps volumes, so the tenant's work survives. */
  stop(handle: BoxHandle): Promise<void>;
  /** Takes the volumes too. The one destructive operation, and it is audited. */
  destroy(handle: BoxHandle): Promise<void>;
  /** Everything this allocator believes it created — for reconciling against the store. */
  list(): Promise<BoxHandle[]>;
}

export class NotImplementedAllocator extends Error {
  constructor(kind: AllocatorKind, operation: string) {
    super(
      `the ${kind} allocator cannot ${operation} yet — see docs/08-control-plane.md §4.2 for what it ` +
        `will do, and use the static or compose allocator until then`
    );
    this.name = "NotImplementedAllocator";
  }
}

function newToken(): string {
  return randomBytes(16).toString("hex");
}

/**
 * A base class holding the part every allocator shares: the store is the record.
 *
 * Subclasses supply only what it means to create, stop and destroy the thing itself. Nothing about
 * bookkeeping is duplicated, which is what keeps `compose` and `kubernetes` from each inventing
 * their own idea of when a box exists.
 */
abstract class StoreBackedAllocator implements BoxAllocator {
  abstract readonly kind: AllocatorKind;

  constructor(protected readonly store: ControlStore) {}

  /** Bring the real thing into being and say where it is. Called only when the store has no box. */
  protected abstract create(
    tenantId: string,
    boxId: string,
    spec: BoxSpec,
    tokens: { box: string; ui: string }
  ): Promise<{ externalId: string; boxdUrl: string; uiUrl: string; state: BoxState }>;

  protected abstract stopExternal(handle: BoxHandle): Promise<void>;
  protected abstract destroyExternal(handle: BoxHandle): Promise<void>;

  async allocate(tenantId: string, spec: BoxSpec): Promise<BoxHandle> {
    const tenant = this.store.getTenant(tenantId);
    if (tenant === undefined) throw new Error(`no such tenant: ${tenantId}`);
    // A suspended tenant is refused here rather than at the gateway, so every path that can
    // create a box goes past the same check.
    if (tenant.state !== "active") {
      throw new Error(`tenant ${tenant.name} is ${tenant.state}; not allocating a box`);
    }

    const existing = await this.find(tenantId);
    if (existing !== undefined) return existing;

    const boxId = randomUUID();
    const tokens = { box: newToken(), ui: newToken() };
    const placed = await this.create(tenantId, boxId, spec, tokens);

    let row: BoxRow;
    try {
      row = this.store.createBox({
        id: boxId,
        tenantId,
        allocatorKind: this.kind,
        externalId: placed.externalId,
        boxdUrl: placed.boxdUrl,
        uiUrl: placed.uiUrl,
        state: placed.state,
        image: spec.image,
        createdAt: new Date().toISOString(),
      });
    } catch (error) {
      // The unique index refused: someone else allocated for this tenant while we were creating.
      // Their box is the real one; ours has to go, or it runs forever owned by nobody.
      const winner = await this.find(tenantId);
      if (winner !== undefined) {
        await this.destroyExternal({
          tenantId,
          id: boxId,
          externalId: placed.externalId,
          boxdUrl: placed.boxdUrl,
          uiUrl: placed.uiUrl,
          tokens,
          createdAt: new Date().toISOString(),
          state: placed.state,
        }).catch(() => {});
        this.store.audit({
          tenantId,
          actor: `${this.kind}-allocator`,
          action: "allocate.lost-race",
          target: placed.externalId,
          detail: { keptBox: winner.id },
        });
        return winner;
      }
      throw error;
    }

    this.store.putToken(boxId, "box", tokens.box);
    this.store.putToken(boxId, "ui", tokens.ui);
    this.store.audit({
      tenantId,
      actor: `${this.kind}-allocator`,
      action: "allocate",
      target: row.externalId,
      detail: { boxId, image: spec.image },
    });
    return this.toHandle(row);
  }

  async find(tenantId: string): Promise<BoxHandle | undefined> {
    const row = this.store.boxForTenant(tenantId);
    return row === undefined ? undefined : this.toHandle(row);
  }

  async stop(handle: BoxHandle): Promise<void> {
    await this.stopExternal(handle);
    this.store.setBoxState(handle.id, "stopped");
    this.store.audit({
      tenantId: handle.tenantId,
      actor: `${this.kind}-allocator`,
      action: "stop",
      target: handle.externalId,
    });
  }

  async destroy(handle: BoxHandle): Promise<void> {
    await this.destroyExternal(handle);
    // `gone` rather than deleted: the row is how anyone learns later that this tenant had a box
    // and that someone took it away. The unique index only counts live boxes, so the slot frees.
    this.store.setBoxState(handle.id, "gone");
    this.store.audit({
      tenantId: handle.tenantId,
      actor: `${this.kind}-allocator`,
      action: "destroy",
      target: handle.externalId,
      detail: { volumesRemoved: true },
    });
  }

  async list(): Promise<BoxHandle[]> {
    return this.store
      .listBoxes()
      .filter(row => row.allocatorKind === this.kind && row.state !== "gone")
      .map(row => this.toHandle(row));
  }

  protected toHandle(row: BoxRow): BoxHandle {
    return {
      tenantId: row.tenantId,
      id: row.id,
      externalId: row.externalId,
      boxdUrl: row.boxdUrl,
      uiUrl: row.uiUrl,
      tokens: {
        box: this.store.readToken(row.id, "box") ?? "",
        ui: this.store.readToken(row.id, "ui") ?? "",
      },
      createdAt: row.createdAt,
      state: row.state,
    };
  }
}

export interface StaticAllocatorOptions {
  /** The one box everyone gets. As reachable from the control plane. */
  boxdUrl: string;
  uiUrl: string;
  /** The box's real tokens, since a running box already has its own and will not take new ones. */
  tokens: { box: string; ui: string };
}

/**
 * One box, already running, handed to whoever asks.
 *
 * For development: it lets the whole control plane run against a box on a laptop, which is the only
 * way to exercise the store, the gateway and the collector before there is a cluster. It is the
 * `attached` provisioner promoted to this interface.
 *
 * Honest about what it is not: allocation creates a row, not a container, so two tenants asking both
 * get *the same box* and can see each other's work. Refused rather than allowed silently — a second
 * tenant is an error here, because the alternative is a development shortcut that looks like
 * multi-tenancy and is not.
 */
export class StaticAllocator extends StoreBackedAllocator {
  readonly kind = "static" as const;

  constructor(
    store: ControlStore,
    private readonly options: StaticAllocatorOptions
  ) {
    super(store);
  }

  protected async create(
    tenantId: string,
    boxId: string
  ): Promise<{ externalId: string; boxdUrl: string; uiUrl: string; state: BoxState }> {
    const taken = this.store
      .listBoxes()
      .filter(row => row.allocatorKind === "static" && row.state !== "gone" && row.tenantId !== tenantId);
    if (taken.length > 0) {
      throw new Error(
        `the static allocator has one box and tenant ${taken[0]!.tenantId} already has it; ` +
          `use the compose allocator for more than one tenant`
      );
    }
    return {
      externalId: `static:${boxId}`,
      boxdUrl: this.options.boxdUrl,
      uiUrl: this.options.uiUrl,
      state: "ready",
    };
  }

  /** Nothing to stop: this allocator did not start it, and stopping someone's laptop box is rude. */
  protected async stopExternal(): Promise<void> {}
  protected async destroyExternal(): Promise<void> {}

  /**
   * The pre-existing box's own tokens, not minted ones.
   *
   * A running box will not accept a new token — its is baked into its environment — so returning a
   * freshly minted one would hand out a credential that authenticates nothing. That was the exact
   * shape of an earlier bug in the attach path, where a token was minted when it should have been
   * read.
   */
  protected override toHandle(row: BoxRow): BoxHandle {
    return { ...super.toHandle(row), tokens: this.options.tokens };
  }
}
