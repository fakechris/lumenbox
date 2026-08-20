/**
 * How often a desktop component may be restarted before we stop trying.
 *
 * Restarting a dead component is right; restarting it forever is not. Two failures need
 * different answers, and telling them apart is this file's whole job.
 *
 * A component that dies once and stays up afterwards is a hiccup — restart it and forget
 * it. A component that dies as fast as it is started is flapping, and hammering it costs
 * CPU, fills the logs, and hides the fact that the box is broken behind a stream of
 * "restarting" lines. So restarts are counted in a sliding window, backed off between
 * attempts, and abandoned past a cap — reported rather than retried. As old restarts age
 * out of the window the component becomes eligible again, so a box that was briefly
 * broken heals itself.
 *
 * The compositor is a special case, and not a hypothetical one: the reference
 * implementation carries a ticket number for it. A picom that keeps crash-looping
 * redirects and repaints the screen on every relaunch, smearing the root wallpaper over
 * window content, while a desktop with no compositor merely loses the dock's translucency.
 * So after a few distinct crashloop episodes it is disabled for good: "no compositor" is
 * strictly better than "a compositor that flaps".
 *
 * Backoff is on top of a poll, not a process exit. A supervisor that waits on the process
 * gets a backoff floor of about a second for free; boxd notices on its next tick instead,
 * so the floor here is the tick interval and the growth is what stops a flapping component
 * being retried on every single one.
 */

import { envNumber } from "../config.ts";

const MINUTE_MS = 60_000;

export interface ComponentPolicy {
  /** Restarts older than this stop counting. */
  windowMs: number;
  /** More than this many restarts inside the window means it is not coming back. */
  maxInWindow: number;
  /** Waiting time after the first restart; doubles per restart. */
  backoffBaseMs: number;
  backoffMaxMs: number;
  /** Components abandoned permanently after this many crashloop episodes. */
  giveUpAfterEpisodes: number;
  /** Which components get that treatment: ones the desktop is better off without. */
  optional: readonly string[];
}

export const DEFAULT_POLICY: ComponentPolicy = {
  windowMs: Number(process.env.BOXD_RESTART_WINDOW_MS ?? 10 * MINUTE_MS),
  maxInWindow: envNumber("BOXD_MAX_RESTARTS", 8),
  backoffBaseMs: envNumber("BOXD_BACKOFF_BASE_MS", 15_000),
  backoffMaxMs: Number(process.env.BOXD_BACKOFF_MAX_MS ?? 5 * MINUTE_MS),
  giveUpAfterEpisodes: envNumber("BOXD_GIVE_UP_EPISODES", 2),
  // The dock goes with it: without a compositor it paints an opaque slab, which is worse
  // than not having it.
  optional: ["picom", "plank"],
};

export type ComponentState =
  /** Running, or restarted and stayed up. */
  | "ok"
  /** Restarted recently and waiting out its backoff before another attempt. */
  | "backoff"
  /** Hit the cap inside the window. Not being restarted until the window ages out. */
  | "crashloop"
  /** Abandoned for the life of this process. The desktop runs without it. */
  | "disabled";

export interface ComponentStatus {
  name: string;
  state: ComponentState;
  /** Restarts still inside the window. */
  restarts: number;
  /** Times it has hit the cap, cooled off, and hit it again. */
  crashloops: number;
  /** Why it is not being restarted, for anything deciding whether to recycle the box. */
  reason?: string;
  lastRestartAt?: string;
}

interface Record_ {
  restarts: number[];
  crashloops: number;
  disabled: boolean;
  reason?: string;
}

/**
 * Restart bookkeeping for one desktop's components.
 *
 * Deliberately has no idea how a component is started or checked: it answers "may this be
 * restarted now", is told when one was, and reports what it thinks. That is what makes it
 * testable without an X server.
 */
export class ComponentHealth {
  private readonly records = new Map<string, Record_>();

  constructor(
    private readonly policy: ComponentPolicy = DEFAULT_POLICY,
    private readonly now: () => number = () => Date.now()
  ) {}

  private record(name: string): Record_ {
    const existing = this.records.get(name);
    if (existing) return existing;
    const fresh: Record_ = { restarts: [], crashloops: 0, disabled: false };
    this.records.set(name, fresh);
    return fresh;
  }

  /** Drops restarts that have aged out, which is what makes a crashloop self-heal. */
  private prune(record: Record_): void {
    const cutoff = this.now() - this.policy.windowMs;
    record.restarts = record.restarts.filter(at => at > cutoff);
  }

  /** Names that must not be started on this pass. */
  blocked(): string[] {
    return [...this.records.keys()].filter(name => {
      const state = this.stateOf(name);
      return state === "backoff" || state === "crashloop" || state === "disabled";
    });
  }

  stateOf(name: string): ComponentState {
    const record = this.records.get(name);
    if (!record) return "ok";
    if (record.disabled) return "disabled";

    this.prune(record);
    if (record.restarts.length === 0) return "ok";
    if (record.restarts.length > this.policy.maxInWindow) return "crashloop";

    const last = record.restarts[record.restarts.length - 1]!;
    const delay = Math.min(
      this.policy.backoffBaseMs * 2 ** (record.restarts.length - 1),
      this.policy.backoffMaxMs
    );
    return this.now() - last < delay ? "backoff" : "ok";
  }

  /**
   * Records that a component had to be started, and decides what that means.
   *
   * Called after the fact rather than before, because the thing that knows a component
   * was missing is whatever just started it.
   */
  restarted(name: string): ComponentStatus {
    const record = this.record(name);
    this.prune(record);
    record.restarts.push(this.now());

    if (record.restarts.length > this.policy.maxInWindow) {
      // A distinct episode: it hit the cap, and either it is the first time or it had
      // cooled off in between.
      const wasAlreadyLooping = record.restarts.length === this.policy.maxInWindow + 1;
      if (wasAlreadyLooping) record.crashloops += 1;

      if (
        this.policy.optional.includes(name) &&
        record.crashloops >= this.policy.giveUpAfterEpisodes
      ) {
        record.disabled = true;
        record.reason =
          `${name} crash-looped ${record.crashloops} times; the desktop runs without it ` +
          "rather than being repainted on every relaunch";
      } else {
        record.reason =
          `${name} restarted more than ${this.policy.maxInWindow} times in ` +
          `${Math.round(this.policy.windowMs / MINUTE_MS)} minutes`;
      }
    }

    return this.statusOf(name);
  }

  statusOf(name: string): ComponentStatus {
    const record = this.records.get(name);
    const state = this.stateOf(name);
    return {
      name,
      state,
      restarts: record?.restarts.length ?? 0,
      crashloops: record?.crashloops ?? 0,
      reason: state === "ok" || state === "backoff" ? undefined : record?.reason,
      lastRestartAt:
        record && record.restarts.length > 0
          ? new Date(record.restarts[record.restarts.length - 1]!).toISOString()
          : undefined,
    };
  }

  /** Everything known about this desktop, for the health endpoint. */
  report(): ComponentStatus[] {
    return [...this.records.keys()].sort().map(name => this.statusOf(name));
  }

  /** True when something is not running and is not going to be. */
  degraded(): boolean {
    return this.report().some(
      status => status.state === "crashloop" || status.state === "disabled"
    );
  }
}
