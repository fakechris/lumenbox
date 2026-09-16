/**
 * A spend ceiling the box cannot talk its way past (INV-580, docs/10 S-5).
 *
 * The policy gate runs inside the box: the party being billed is the party enforcing the
 * budget. That is the right place to *explain* a limit to an agent — it has the context and
 * can say what to do instead — and the wrong place to *impose* one, because an agent with a
 * shell can edit the thing that is stopping it.
 *
 * The relay is outside the box and holds the credential. It already measures every request
 * where it passes. This turns that measurement into a refusal.
 *
 * Three honesty rules, each of which is the difference between a ceiling and a decoration:
 *
 * - **No ceiling configured means nothing changes.** The default deployment is not silently
 *   given a limit it did not ask for.
 * - **A limit that cannot be measured is refused, not assumed.** If usage in the window came
 *   from a model with no configured rate, the money total is a floor rather than a total —
 *   so a money ceiling fails closed and says which model it could not price. The alternative
 *   is a ceiling that an unpriced model walks straight through.
 * - **The refusal is readable by whoever hits it.** It says what the limit is, what has been
 *   spent, when the window resets, and that the operator sets it — the agent on the other end
 *   has to be able to tell its person something better than "403".
 */

import { priceOf, type Rates } from "../host/spend.ts";
import type { RelayUsage } from "./server.ts";

export interface Ceiling {
  /** Money in the window. Needs rates for every model used, or it fails closed. */
  limitUsd?: number;
  /** Tokens in the window — input, output and cache together. Needs no rates. */
  limitTokens?: number;
  /** How far back the window reaches. Default 24 hours. */
  windowHours?: number;
}

export interface CeilingRefusal {
  boxId: string;
  tenantId: string;
  reason: string;
  spentUsd?: number;
  spentTokens: number;
  limit: string;
  resetsAt: string;
}

export interface CeilingOptions {
  /** The ceiling for one box, or `undefined` for no limit. Read per request, so a change lands without a restart. */
  ceilingFor: (input: { boxId: string; tenantId: string }) => Ceiling | undefined;
  /** What each model costs. Missing rates make a money ceiling fail closed rather than leak. */
  rates?: Rates;
  /** Every refusal, for the audit. */
  onRefusal?: (refusal: CeilingRefusal) => void;
  now?: () => Date;
}

interface Entry {
  at: number;
  boxId: string;
  tokens: number;
  usd: number | undefined;
  model: string;
}

const DEFAULT_WINDOW_HOURS = 24;

const tokensOf = (usage: Pick<RelayUsage, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens">): number =>
  usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;

/** Two decimals, for a message a person reads rather than a number a machine compares. */
const money = (value: number): string => `$${value.toFixed(2)}`;

export class SpendCeilings {
  private readonly entries: Entry[] = [];
  private readonly now: () => Date;

  constructor(private readonly options: CeilingOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /**
   * What the relay measured. Recorded whether or not a ceiling is configured, so turning one
   * on works immediately — and takes a stored row as happily as a live one, which is how a
   * restart keeps the window it was already in.
   */
  record(usage: Omit<RelayUsage, "streamed">): void {
    this.entries.push({
      at: Date.parse(usage.at),
      boxId: usage.boxId,
      tokens: tokensOf(usage),
      usd: priceOf(usage, this.options.rates ?? {}),
      model: usage.model,
    });
    // Anything older than the longest window we could be asked about is dead weight. A day
    // either way costs nothing to keep and saves the cost of getting the bound wrong.
    const horizon = this.now().getTime() - 32 * 24 * 3_600_000;
    while (this.entries.length > 0 && this.entries[0]!.at < horizon) this.entries.shift();
  }

  /** What has been spent in this box's window: tokens always, money only when everything was priced. */
  spent(
    boxId: string,
    windowHours = DEFAULT_WINDOW_HOURS
  ): { tokens: number; usd: number | undefined; unpriced: string[]; since: number; oldest: number | undefined } {
    const since = this.now().getTime() - windowHours * 3_600_000;
    let tokens = 0;
    let usd = 0;
    let oldest: number | undefined;
    const unpriced = new Set<string>();
    for (const entry of this.entries) {
      if (entry.at < since || entry.boxId !== boxId) continue;
      if (oldest === undefined) oldest = entry.at;
      tokens += entry.tokens;
      if (entry.usd === undefined) unpriced.add(entry.model === "" ? "an unnamed model" : entry.model);
      else usd += entry.usd;
    }
    return { tokens, usd: unpriced.size === 0 ? usd : undefined, unpriced: [...unpriced], since, oldest };
  }

  /** Whether this box may make another request. Called before anything is forwarded. */
  check(input: { boxId: string; tenantId: string }): { ok: true } | { ok: false; refusal: CeilingRefusal } {
    const ceiling = this.options.ceilingFor(input);
    if (ceiling === undefined || (ceiling.limitUsd === undefined && ceiling.limitTokens === undefined)) {
      return { ok: true };
    }
    const windowHours = ceiling.windowHours ?? DEFAULT_WINDOW_HOURS;
    const spent = this.spent(input.boxId, windowHours);
    // The window rolls, so nothing "resets": the allowance comes back as the oldest requests
    // fall out of it. This is the earliest moment anything can change, which is a promise that
    // can be kept — a round "midnight" would not be.
    const resetsAt = new Date((spent.oldest ?? this.now().getTime()) + windowHours * 3_600_000).toISOString();
    const refuse = (reason: string, limit: string): { ok: false; refusal: CeilingRefusal } => {
      const refusal: CeilingRefusal = {
        boxId: input.boxId,
        tenantId: input.tenantId,
        reason,
        ...(spent.usd !== undefined ? { spentUsd: spent.usd } : {}),
        spentTokens: spent.tokens,
        limit,
        resetsAt,
      };
      this.options.onRefusal?.(refusal);
      return { ok: false, refusal };
    };

    if (ceiling.limitTokens !== undefined && spent.tokens >= ceiling.limitTokens) {
      return refuse(
        `This box has used ${spent.tokens.toLocaleString("en-US")} tokens in the last ${windowHours} hours, which is its limit ` +
          `(${ceiling.limitTokens.toLocaleString("en-US")}). Its allowance starts coming back after ${resetsAt}, as the oldest ` +
          `requests fall out of the window. ` +
          `The limit is set by whoever runs this deployment, not by anything in the box — ask them to raise it if the work needs it.`,
        `${ceiling.limitTokens.toLocaleString("en-US")} tokens / ${windowHours}h`
      );
    }
    if (ceiling.limitUsd !== undefined) {
      if (spent.usd === undefined) {
        // Fail closed and say exactly why. An unpriced model is otherwise a hole straight
        // through a money ceiling, and the operator asked for a hard limit.
        return refuse(
          `This deployment has a spend limit of ${money(ceiling.limitUsd)} per ${windowHours} hours, and usage from ` +
            `${spent.unpriced.join(", ")} cannot be priced — no rate is configured for it, so what has been spent is a floor ` +
            `rather than a total. Requests are refused until a rate is configured or the limit is removed: a limit that ` +
            `cannot be measured is not a limit.`,
          `${money(ceiling.limitUsd)} / ${windowHours}h`
        );
      }
      if (spent.usd >= ceiling.limitUsd) {
        return refuse(
          `This box has spent ${money(spent.usd)} in the last ${windowHours} hours, which is its limit (${money(ceiling.limitUsd)}). ` +
            `Its allowance starts coming back after ${resetsAt}, as the oldest requests fall out of the window. ` +
            `The limit is set by whoever runs this deployment, not by anything in the box — ask them to raise it if the work needs it.`,
          `${money(ceiling.limitUsd)} / ${windowHours}h`
        );
      }
    }
    return { ok: true };
  }
}

/** Reads a ceiling out of a tenant's quota, where a deployment keeps it. */
export function ceilingFromQuota(quota: Record<string, unknown> | undefined): Ceiling | undefined {
  const relay = quota?.relay;
  if (relay === null || typeof relay !== "object") return undefined;
  const row = relay as Record<string, unknown>;
  const number = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
  const ceiling: Ceiling = {
    ...(number(row.limitUsd) !== undefined ? { limitUsd: number(row.limitUsd)! } : {}),
    ...(number(row.limitTokens) !== undefined ? { limitTokens: number(row.limitTokens)! } : {}),
    ...(number(row.windowHours) !== undefined ? { windowHours: number(row.windowHours)! } : {}),
  };
  return ceiling.limitUsd === undefined && ceiling.limitTokens === undefined ? undefined : ceiling;
}
