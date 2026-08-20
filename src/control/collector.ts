/**
 * Reading health and usage out of every box.
 *
 * A poll loop, because the box does not push
 * ([../docs/08-control-plane.md](../docs/08-control-plane.md) §2). That is not a shortcut: giving a
 * box an outbound channel and an identity would mean giving the one container we deliberately do not
 * trust a way to reach the control plane and something to authenticate with. Polling costs a loop and
 * buys the property that nothing inside a box can talk to anything outside it.
 *
 * The design decisions that matter:
 *
 *   - **Usage is pulled with a cursor, never a snapshot.** The box keeps monotonic sequence numbers
 *     (`src/host/usage.ts`) and the store remembers the highest one collected. A collector that was
 *     down for an hour catches up; one that read by time would either double-count or skip,
 *     depending on which way its clock was wrong. Combined with the store's `(box_id, seq)` key,
 *     this makes collection exactly-once even though delivery is at-least-once.
 *   - **One slow box does not stall the rest.** Each box is polled on its own, with a timeout, and a
 *     failure is recorded rather than thrown. A fleet where one dead box stops metering for everyone
 *     is worse than no metering, because it looks like it is working.
 *   - **`degraded` is carried separately from `ok`.** A box whose compositor has been given up on
 *     still serves a screen; one whose x11vnc is crash-looping does not. Collapsing those into a
 *     single boolean is what makes a fleet dashboard lie, and `desktop_health` exists precisely
 *     because that distinction was worth reporting.
 *   - **`unreachable` is a state, not an error.** Repeated failures mark the box, which is the signal
 *     the reaper acts on and the gateway explains to a person. A collector that only logged would
 *     leave both blind.
 *
 * What it does not do: bill. Prices belong to whoever invoices, and totals stay queries (§6).
 */

import type { HealthResult } from "../protocol/index.ts";
import type { BoxAllocator, BoxHandle } from "./allocator.ts";
import type { BoxRow, ControlStore, UsageRow } from "./store.ts";

/** What a box's `GET /api/usage` returns. Mirrors `UsageLog.since`. */
interface BoxUsagePayload {
  records?: readonly {
    seq: number;
    at: string;
    agentId: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  }[];
}

export interface CollectorOptions {
  store: ControlStore;
  /**
   * Asked where a box really is before it is written off.
   *
   * Without this, a restart is a death sentence: a container published on an ephemeral port gets a
   * different one from `docker restart`, and these boxes carry `--restart unless-stopped`, so a
   * daemon restart re-maps every box at once. The stored URL goes stale, every poll fails, and the
   * collector marks a healthy fleet unreachable. Optional so a store-only test needs no allocator.
   */
  allocator?: Pick<BoxAllocator, "reconcile">;
  /** How often to sweep the fleet. */
  intervalMs?: number;
  /** Per-request timeout. Short: a box that is thinking hard is still expected to answer a GET. */
  timeoutMs?: number;
  /** Consecutive failures before a box is called unreachable. */
  failuresBeforeUnreachable?: number;
  /** Injected so the tests do not need a box, and so a fake can fail on demand. */
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

export interface SweepResult {
  boxes: number;
  healthy: number;
  degraded: number;
  unreachable: number;
  usageRowsStored: number;
}

export class Collector {
  private readonly failures = new Map<string, number>();
  private timer: NodeJS.Timeout | undefined;
  private readonly log: (line: string) => void;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: CollectorOptions) {
    this.log = options.log ?? (() => {});
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Sweeps every box that is supposed to be running. Never throws. */
  async sweep(): Promise<SweepResult> {
    // `gone` boxes do not exist and `stopped` ones are not expected to answer; polling either would
    // manufacture failures and then act on them.
    const boxes = this.options.store.listBoxes(["starting", "ready", "unreachable"]);
    const result: SweepResult = {
      boxes: boxes.length,
      healthy: 0,
      degraded: 0,
      unreachable: 0,
      usageRowsStored: 0,
    };

    // Concurrently, so one box that takes the whole timeout does not delay the others. The fleet is
    // tens of boxes on one host; if it becomes thousands this needs a bounded pool.
    await Promise.all(
      boxes.map(async box => {
        const outcome = await this.collectOne(box);
        if (outcome.reachable) {
          this.failures.delete(box.id);
          if (outcome.degraded) result.degraded++;
          else result.healthy++;
          result.usageRowsStored += outcome.usageRowsStored;
        } else {
          result.unreachable++;
        }
      })
    );
    return result;
  }

  private async collectOne(
    current: BoxRow
  ): Promise<{ reachable: boolean; degraded: boolean; usageRowsStored: number }> {
    let box = current;
    let health = await this.readHealth(box);

    if (health === undefined) {
      // Before believing it is dead, ask where it actually is. A moved port looks exactly like a
      // dead box from here, and the difference matters: one needs correcting, the other reporting.
      const moved = await this.relocate(box);
      if (moved !== undefined) {
        box = moved;
        health = await this.readHealth(box);
        if (health !== undefined) {
          this.log(`${box.externalId} moved to ${box.boxdUrl}; corrected`);
        }
      }
    }

    if (health === undefined) {
      this.noteFailure(box);
      return { reachable: false, degraded: false, usageRowsStored: 0 };
    }

    // A box whose compositor was abandoned still serves a screen; one whose x11vnc is
    // crash-looping does not. Both would say "running" without this.
    const degraded = (health.desktop_health ?? []).some(desktop => desktop.degraded);
    this.options.store.recordHealth({
      boxId: box.id,
      at: new Date().toISOString(),
      ok: true,
      degraded,
      components: health.desktop_health ?? null,
      crashes: health.crashes ?? null,
    });
    this.options.store.markBoxSeen(box.id);
    if (box.state !== "ready") {
      // A box that answers is ready, including one previously written off. Recovery has to be
      // automatic, or a transient network fault becomes a box nobody ever un-marks.
      this.options.store.setBoxState(box.id, "ready");
      this.log(`${box.externalId} is answering again`);
    }

    const usageRowsStored = await this.collectUsage(box);
    return { reachable: true, degraded, usageRowsStored };
  }

  /** Re-reads a box's address through the allocator, returning the row only when it changed. */
  private async relocate(box: BoxRow): Promise<BoxRow | undefined> {
    if (this.options.allocator === undefined) return undefined;
    const handle: BoxHandle = {
      tenantId: box.tenantId,
      id: box.id,
      externalId: box.externalId,
      boxdUrl: box.boxdUrl,
      uiUrl: box.uiUrl,
      tokens: { box: "", ui: "" },
      createdAt: box.createdAt,
      state: box.state,
    };
    try {
      const corrected = await this.options.allocator.reconcile(handle);
      if (corrected === undefined) return undefined;
      if (corrected.boxdUrl === box.boxdUrl && corrected.uiUrl === box.uiUrl) return undefined;
      return { ...box, boxdUrl: corrected.boxdUrl, uiUrl: corrected.uiUrl };
    } catch {
      return undefined;
    }
  }

  private async readHealth(box: BoxRow): Promise<HealthResult | undefined> {
    try {
      // Unauthenticated by design, so that Docker's own health check works without a token.
      const response = await this.fetchImpl(`${box.boxdUrl}/health`, {
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 5000),
      });
      if (!response.ok) return undefined;
      return (await response.json()) as HealthResult;
    } catch {
      return undefined;
    }
  }

  /**
   * Pulls usage from where the store left off.
   *
   * The cursor is read from the store rather than kept in memory, so a restarted collector resumes
   * instead of re-reading everything — and re-reading would be safe anyway, which is the point of
   * keying rows by the box's own sequence number.
   */
  private async collectUsage(box: BoxRow): Promise<number> {
    const cursor = this.options.store.getBox(box.id)?.usageCursor ?? 0;
    let payload: BoxUsagePayload;
    try {
      const response = await this.fetchImpl(`${box.uiUrl}/api/usage?since=${cursor}`, {
        headers: { authorization: `Bearer ${this.uiTokenFor(box)}` },
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 5000),
      });
      if (!response.ok) {
        // Worth saying out loud: a box that is healthy but whose usage cannot be read is a box
        // spending money invisibly, which is the exact gap R-03 exists to close.
        this.log(`${box.externalId}: usage unavailable (HTTP ${response.status})`);
        return 0;
      }
      payload = (await response.json()) as BoxUsagePayload;
    } catch (error) {
      this.log(
        `${box.externalId}: usage unavailable (${error instanceof Error ? error.message : String(error)})`
      );
      return 0;
    }

    const records = payload.records ?? [];
    if (records.length === 0) return 0;

    const rows: UsageRow[] = records.map(record => ({
      boxId: box.id,
      tenantId: box.tenantId,
      seq: record.seq,
      at: record.at,
      agentId: record.agentId,
      model: record.model,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      cacheReadTokens: record.cacheReadTokens,
      cacheWriteTokens: record.cacheWriteTokens,
    }));
    const stored = this.options.store.appendUsage(rows);
    if (records.length === 500) {
      // The box caps a page at 500. Said rather than assumed, so a backlog is visible instead of
      // looking like a quiet plateau in someone's bill.
      this.log(`${box.externalId}: a full page of usage was returned; more remains for next sweep`);
    }
    return stored;
  }

  private uiTokenFor(box: BoxRow): string {
    return this.options.store.readToken(box.id, "ui") ?? "";
  }

  private noteFailure(box: BoxRow): void {
    const count = (this.failures.get(box.id) ?? 0) + 1;
    this.failures.set(box.id, count);
    const limit = this.options.failuresBeforeUnreachable ?? 3;
    if (count < limit) {
      this.log(`${box.externalId} did not answer (${count}/${limit})`);
      return;
    }
    if (box.state !== "unreachable") {
      // A restart or a slow moment should not page anyone. Repeated silence should.
      this.options.store.setBoxState(box.id, "unreachable");
      this.options.store.recordHealth({
        boxId: box.id,
        at: new Date().toISOString(),
        ok: false,
        degraded: true,
        components: null,
        crashes: null,
      });
      this.options.store.audit({
        tenantId: box.tenantId,
        actor: "collector",
        action: "mark.unreachable",
        target: box.externalId,
        detail: { consecutiveFailures: count },
      });
      this.log(`${box.externalId} is unreachable after ${count} attempts`);
    }
  }

  /** Starts sweeping on a timer. Unref'd, so it never holds a process open on its own. */
  start(): void {
    if (this.timer !== undefined) return;
    const interval = this.options.intervalMs ?? 15_000;
    const tick = () => {
      void this.sweep().catch(error => {
        this.log(`sweep failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    };
    tick();
    this.timer = setInterval(tick, interval);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }
}

/**
 * Per-tenant totals, and whether a tenant is over what they were allowed.
 *
 * Metering is separated from enforcement on purpose: this reports, and the caller decides. Today
 * nothing acts on `overBudget` — that is R-03's remaining half, and pretending otherwise by wiring a
 * hard stop here without a way for a person to see it coming would be worse than the gap.
 *
 * Once the relay exists, this should read from it rather than from the box: usage measured where the
 * request passes is unforgeable, and usage reported by the thing being billed is not.
 */
export interface TenantMeter {
  tenantId: string;
  tenantName: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  records: number;
  /**
   * True when these numbers came from the relay rather than from the box.
   *
   * Worth surfacing rather than hiding: it is the difference between a figure the tenant could have
   * understated and one they could not.
   */
  measuredByRelay: boolean;
  /** From `quota.monthlyTokens`, when set. */
  limitTokens: number | undefined;
  overBudget: boolean;
}

export function meterTenants(store: ControlStore, since?: string): TenantMeter[] {
  return store.listTenants().map(tenant => {
    // Where the relay measured this tenant, that is the number to bill from: it was observed as the
    // request passed rather than reported by the thing being billed. The two are *not* summed —
    // they are two measurements of the same traffic, and adding them would double-count.
    //
    // "Any relay rows at all" rather than a per-period comparison, because a tenant that moved onto
    // a relay mid-month would otherwise be billed twice for the days on either side of the switch.
    // The cost is that the box's own record for the days before is dropped; that is the right way
    // round, since the unforgeable number is the one to under-bill from rather than over.
    const measuredByRelay = store.hasRelayUsage(tenant.id);
    const totals = measuredByRelay
      ? store.relayTotals(tenant.id, since)
      : store.tenantTotals(tenant.id, since);
    const limit = tenant.quota.monthlyTokens;
    const limitTokens = typeof limit === "number" && Number.isFinite(limit) ? limit : undefined;
    // Cache reads are counted: they are cheaper, not free, and a tenant whose whole bill is cache
    // reads is still spending. Applying a discount here would bake a price into the wrong file.
    const billable = totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheWriteTokens;
    return {
      tenantId: tenant.id,
      tenantName: tenant.name,
      ...totals,
      measuredByRelay,
      limitTokens,
      overBudget: limitTokens !== undefined && billable > limitTokens,
    };
  });
}
