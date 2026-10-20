/**
 * The receiver decides when it is woken (Yobiru SPEC §5.6, INV-1288): the sender's `wake` is a
 * wish, and the effective level only ever goes down — a per-sender ceiling, quiet hours, a
 * rate per (sender, agent), an unknown agent. The counters that back the rate live in a file,
 * not in memory as Yobiru's do: a restart must not hand every sender a fresh hour.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { TailmsgWake } from "./tailmsg-envelope.ts";
import { canonicalHost, sameHost } from "./tailmsg-envelope.ts";

const ORDER: Record<TailmsgWake, number> = { none: 0, batch: 1, now: 2 };
const lower = (a: TailmsgWake, b: TailmsgWake): TailmsgWake => (ORDER[a] <= ORDER[b] ? a : b);

export interface WakePolicy {
  /** Per sender (hostname or FQDN) the most it may ask for; first match wins. */
  senderMax?: { sender: string; max: TailmsgWake }[];
  /** When no sender rule matches. Default batch, as the spec's `default_max`. */
  defaultMax?: TailmsgWake;
  /** Local hours during which `now` becomes `batch`: start and end, 0–23; end < start wraps midnight. */
  quietHours?: { start: number; end: number };
  /** Effective `now` wakes per (sender, agent) per hour. Default 6. */
  ratePerHour?: number;
}

export interface WakeDecision {
  requested: TailmsgWake;
  effective: TailmsgWake;
  reason?: string;
}

export function inQuietHours(hour: number, quiet: { start: number; end: number } | undefined): boolean {
  if (quiet === undefined) return false;
  return quiet.start <= quiet.end ? hour >= quiet.start && hour < quiet.end : hour >= quiet.start || hour < quiet.end;
}

/** The `now` wakes already spent per (sender, agent), persisted so a restart forgets nothing. */
export class WakeCounters {
  private spent = new Map<string, number[]>();

  constructor(private readonly path?: string) {
    if (path !== undefined && existsSync(path)) {
      try {
        const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, number[]>;
        this.spent = new Map(Object.entries(raw));
      } catch {
        // A torn file is an empty hour, which is the safe direction: nobody is over-woken.
      }
    }
  }

  private key(sender: string, agent: string | undefined): string {
    return `${canonicalHost(sender)}\u0000${agent ?? ""}`;
  }

  inLastHour(sender: string, agent: string | undefined, now: number): number {
    return (this.spent.get(this.key(sender, agent)) ?? []).filter(at => now - at < 3_600_000).length;
  }

  record(sender: string, agent: string | undefined, now: number): void {
    const key = this.key(sender, agent);
    const kept = (this.spent.get(key) ?? []).filter(at => now - at < 3_600_000);
    kept.push(now);
    this.spent.set(key, kept);
    this.flush(now);
  }

  private flush(now: number): void {
    if (this.path === undefined) return;
    const out: Record<string, number[]> = {};
    for (const [key, times] of this.spent) {
      const recent = times.filter(at => now - at < 3_600_000);
      if (recent.length > 0) out[key] = recent;
    }
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(`${this.path}.tmp`, JSON.stringify(out));
      renameSync(`${this.path}.tmp`, this.path);
    } catch {
      // The count stays in memory for this process; the file is a best effort.
    }
  }
}

/**
 * Where a wish ends up. In order, each step only lowers: the sender's ceiling, quiet hours,
 * the hourly rate for this (sender, agent), and an agent nobody here has. The reason names
 * the first step that lowered it, which is what the record and the log say.
 */
export function decideWake(input: {
  requested: TailmsgWake;
  sender: string;
  agent: string | undefined;
  agentKnown: boolean;
  policy: WakePolicy;
  counters: WakeCounters;
  now: number;
  /** Local hour 0–23, so the test can pick one. */
  hour: number;
}): WakeDecision {
  const { requested, policy } = input;
  let effective = requested;
  let reason: string | undefined;
  const rule = (policy.senderMax ?? []).find(entry => sameHost(entry.sender, input.sender) || sameHost(input.sender, entry.sender));
  const max = rule?.max ?? policy.defaultMax ?? "batch";
  if (ORDER[max] < ORDER[effective]) {
    effective = lower(effective, max);
    reason = rule !== undefined ? `sender ceiling ${max}` : `default ceiling ${max}`;
  }
  if (effective === "now" && inQuietHours(input.hour, policy.quietHours)) {
    effective = "batch";
    reason = "quiet hours";
  }
  if (effective === "now" && input.counters.inLastHour(input.sender, input.agent, input.now) >= (policy.ratePerHour ?? 6)) {
    effective = "batch";
    reason = `rate: ${policy.ratePerHour ?? 6} now-wakes per hour for this sender and agent`;
  }
  if (effective === "now" && !input.agentKnown) {
    effective = "batch";
    reason = "no such agent here";
  }
  if (effective === "now") input.counters.record(input.sender, input.agent, input.now);
  return { requested, effective, ...(reason !== undefined ? { reason } : {}) };
}
