/**
 * Failed attempts at a sign-in or invite code, counted so a code cannot be guessed (INV-2078).
 *
 * A code is six characters of a 31-letter alphabet (about 887 million values), sized for the
 * fifteen minutes it used to live. Codes may now live a week, and nothing limited how fast a
 * stranger could try them, so a week-long code was within reach of an unthrottled loop. The
 * code stays short — it travels by voice and by hand — and the number of tries is what is
 * bounded instead: a few per source, and a ceiling for the whole installation, so spreading the
 * guesses over many sources does not help either. At the defaults a week allows about 40,000
 * wrong guesses in all, one chance in roughly 22,000 of hitting a live code.
 *
 * A source over its limit is refused before its code is compared, so a guess made while refused
 * learns nothing. The price is that a flood of wrong guesses can make a real person wait out the
 * window; the refusal says how long, and the host logs each time a limit is reached.
 */

export interface CodeAttemptLimits {
  /** Wrong codes one source may try within the window. */
  perSource: number;
  /** Wrong codes the whole installation accepts within the window, from every source together. */
  overall: number;
  windowMs: number;
}

export const CODE_ATTEMPT_LIMITS: CodeAttemptLimits = { perSource: 10, overall: 60, windowMs: 15 * 60_000 };

export class CodeAttempts {
  private readonly bySource = new Map<string, number[]>();
  private everyone: number[] = [];

  constructor(
    private readonly limits: CodeAttemptLimits = CODE_ATTEMPT_LIMITS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Whole seconds until this source may try a code again, or undefined when it may try now. */
  waitFor(source: string): number | undefined {
    const now = this.now(), since = now - this.limits.windowMs;
    this.everyone = this.everyone.filter(at => at > since);
    const mine = (this.bySource.get(source) ?? []).filter(at => at > since);
    if (mine.length === 0) this.bySource.delete(source); else this.bySource.set(source, mine);
    const full = [
      mine.length >= this.limits.perSource ? mine[mine.length - this.limits.perSource]! : undefined,
      this.everyone.length >= this.limits.overall ? this.everyone[this.everyone.length - this.limits.overall]! : undefined,
    ].filter((at): at is number => at !== undefined);
    if (full.length === 0) return undefined;
    // Free again once the oldest attempt that still counts against the full limit leaves the window.
    return Math.max(1, Math.ceil((Math.max(...full) + this.limits.windowMs - now) / 1000));
  }

  /** A wrong or dead code from this source. Says whether that attempt reached a limit, so the host logs it once. */
  failed(source: string): boolean {
    const now = this.now();
    this.bySource.set(source, [...(this.bySource.get(source) ?? []), now]);
    this.everyone.push(now);
    return this.waitFor(source) !== undefined;
  }
}
