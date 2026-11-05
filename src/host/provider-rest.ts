/**
 * A provider account that is out of usage rests, for every agent at once (INV-1577).
 *
 * On 2026-11-04 the installation's MiniMax Token Plan ran out. Every call answered
 * "已达到 Token Plan 用量上限 (2056)" as a 429, each was retried three times as capacity, and
 * every agent kept trying on its own: 471 failed calls, 432 of them in one hour, from one
 * long supervised turn and its summaries. A plan that is out of usage comes back when it resets
 * or is topped up, not in seconds.
 *
 * So the first `usage_limit` an account answers puts the account to rest:
 * - while it rests, no call goes out for any agent, and the turn ends saying why;
 * - when the rest ends, exactly one call is let through to find out (the others still wait);
 * - a failure extends the rest: until the reset time the provider reported, else 15 min, 1 h, then 4 h;
 * - a success ends it.
 * People hear once when a rest begins and once when it ends, not per turn.
 *
 * The rest is keyed by the account — provider label, endpoint and a hash of the key — so every
 * client built for it, in any agent, shares it. The key itself is never kept.
 */

import { createHash } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { classifyFailure } from "./transient.ts";

/** Rest lengths after the first, second and later failures, when the provider gives no reset time. */
const STEPS_MS = [15 * 60_000, 60 * 60_000, 4 * 60 * 60_000];

export interface RestState {
  account: string;
  label: string;
  since: string;
  until: string;
  /** How many usage_limit answers in a row, the first one included. */
  streak: number;
  reason: string;
}

export type RestEvent = { type: "resting" | "recovered"; state: RestState };

export class ProviderRestingError extends Error {
  readonly providerResting = true as const;
  constructor(readonly state: RestState, checking = false) {
    super(
      `${state.label}'s plan quota is used up (${state.reason.slice(0, 160)}); ` +
        (checking ? "one call is checking now whether it is back; " : `resting until ${new Date(state.until).toLocaleString()}; `) +
        "no call was made. Every agent on this account waits; an admin can retry now in Settings → Model, or top up the plan."
    );
    this.name = "ProviderRestingError";
  }
}

/** The account a client speaks for: never the key itself. */
export function accountOf(profile: { label: string; baseUrl?: string | undefined }, key: string | undefined): string {
  const keyPart = key === undefined || key === "" ? "nokey" : createHash("sha256").update(key).digest("hex").slice(0, 12);
  return `${profile.label}|${profile.baseUrl ?? ""}|${keyPart}`;
}

/** A reset time the provider reported in a header or the text, as epoch ms. */
export function usageResetAt(error: unknown, now: number): number | undefined {
  const headers = (error as { headers?: unknown } | null)?.headers;
  const read = (name: string): string | undefined => {
    if (headers === null || typeof headers !== "object") return undefined;
    const value = typeof (headers as { get?: unknown }).get === "function" ? (headers as { get(n: string): string | null }).get(name) : (headers as Record<string, unknown>)[name];
    return typeof value === "string" ? value : undefined;
  };
  for (const name of ["anthropic-ratelimit-tokens-reset", "anthropic-ratelimit-requests-reset", "x-ratelimit-reset", "x-ratelimit-reset-requests"]) {
    const raw = read(name);
    if (raw === undefined) continue;
    const at = /^\d+(\.\d+)?$/.test(raw) ? (Number(raw) > 1e12 ? Number(raw) : Number(raw) > 1e9 ? Number(raw) * 1000 : now + Number(raw) * 1000) : Date.parse(raw);
    if (Number.isFinite(at) && at > now) return at;
  }
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const iso = /reset[s]?\s+(?:at\s+)?(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)/i.exec(text)?.[1];
  const at = iso !== undefined ? Date.parse(iso) : NaN;
  return Number.isFinite(at) && at > now ? at : undefined;
}

interface Entry {
  state: RestState;
  /** A probe is out: everyone else keeps waiting until it answers. */
  probing: boolean;
}

export class ProviderRests {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<(event: RestEvent) => void>();
  private readonly now: () => number;
  private readonly steps: readonly number[];

  constructor(options: { now?: () => number; steps?: readonly number[] } = {}) {
    this.now = options.now ?? Date.now;
    this.steps = options.steps ?? STEPS_MS;
  }

  on(listener: (event: RestEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list(): RestState[] {
    return [...this.entries.values()].map(entry => ({ ...entry.state }));
  }

  /** Whether a call may go out now; a `probe` is the one call that finds out whether a rest is over. */
  check(account: string): { refuse: false; probe: boolean } | { refuse: true; error: ProviderRestingError } {
    const entry = this.entries.get(account);
    if (entry === undefined) return { refuse: false, probe: false };
    if (entry.probing) return { refuse: true, error: new ProviderRestingError(entry.state, true) };
    if (this.now() < Date.parse(entry.state.until)) return { refuse: true, error: new ProviderRestingError(entry.state) };
    entry.probing = true;
    return { refuse: false, probe: true };
  }

  /** A call failed. Returns whether it rested (or kept resting) the account. */
  failed(account: string, label: string, error: unknown, probe = false): boolean {
    const entry = this.entries.get(account);
    if (classifyFailure(error) !== "usage_limit") {
      if (probe && entry !== undefined) entry.probing = false; // inconclusive: the next call checks again
      return false;
    }
    const now = this.now();
    const reason = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 300);
    // A late answer from a call that left before the rest began says nothing new.
    if (entry !== undefined && !probe) return true;
    const streak = (entry?.state.streak ?? 0) + 1;
    const until = usageResetAt(error, now) ?? now + this.steps[Math.min(streak - 1, this.steps.length - 1)]!;
    const state: RestState = { account, label, since: entry?.state.since ?? new Date(now).toISOString(), until: new Date(until).toISOString(), streak, reason };
    this.entries.set(account, { state, probing: false });
    if (entry === undefined) this.emit({ type: "resting", state });
    return true;
  }

  /** A call answered. Ends any rest. */
  succeeded(account: string): void {
    const entry = this.entries.get(account);
    if (entry === undefined) return;
    this.entries.delete(account);
    this.emit({ type: "recovered", state: entry.state });
  }

  /** A person asked to try now: the next call goes out as the probe. */
  retryNow(account: string): boolean {
    const entry = this.entries.get(account);
    if (entry === undefined) return false;
    entry.state = { ...entry.state, until: new Date(this.now()).toISOString() };
    entry.probing = false;
    return true;
  }

  private emit(event: RestEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* a listener's failure is its own */ }
    }
  }
}

/** The process's rests: one per account, shared by every client built in this process. */
export const providerRests = new ProviderRests();

/**
 * Every call through `client` goes past the account's rest: refused while it rests, recorded when it
 * fails for usage, and ending the rest when it answers. A refused stream is a stream that fails from
 * `finalMessage`, which is where its callers meet a provider's errors.
 */
export function gateClient(client: Anthropic, account: string, label: string, rests: ProviderRests = providerRests): Anthropic {
  const messages = client.messages as unknown as Record<string, unknown>;
  const create = messages.create;
  if (typeof create === "function") {
    const bound = (create as (...args: unknown[]) => Promise<unknown>).bind(messages);
    messages.create = (...args: unknown[]) => {
      // The SDK's own stream helper calls `create({ stream: true })` and then `.withResponse()` on what
      // it returns; that call was already gated as a stream, and must get the SDK's promise back as is.
      if ((args[0] as { stream?: unknown } | undefined)?.stream === true) return bound(...args);
      const gate = rests.check(account);
      if (gate.refuse) return Promise.reject(gate.error);
      const pending = bound(...args);
      // Recorded on a side branch that handles its own rejection; the caller gets the SDK's promise, unchanged.
      pending.then(() => rests.succeeded(account), error => { rests.failed(account, label, error, gate.probe); });
      return pending;
    };
  }
  const stream = messages.stream;
  if (typeof stream === "function") {
    const bound = (stream as (...args: unknown[]) => { on: (...a: unknown[]) => unknown; finalMessage: () => Promise<unknown> }).bind(messages);
    messages.stream = (...args: unknown[]) => {
      const gate = rests.check(account);
      if (gate.refuse) {
        const refusal = gate.error;
        const refused = { on: () => refused, finalMessage: () => Promise.reject(refusal) };
        return refused;
      }
      const opened = bound(...args);
      const final = opened.finalMessage.bind(opened);
      opened.finalMessage = async () => {
        try {
          const answer = await final();
          rests.succeeded(account);
          return answer;
        } catch (error) {
          rests.failed(account, label, error, gate.probe);
          throw error;
        }
      };
      return opened;
    };
  }
  return client;
}
