/**
 * Which incarnation of a box a slow callback belongs to (INV-1476).
 *
 * A box is reconnected when it was updated, recreated, restarted, or newly attached — a
 * personal box included — and nothing it had is guaranteed to still be there. Work that
 * started against the old incarnation can still come back: a job watch that wakes an agent
 * with "your command ended", a routine run whose result is about to be delivered. Each of
 * those takes a stamp of the box's generation when it starts and asks here before it acts;
 * a stamp from an earlier generation is dropped with one log line, `stale-generation`, and
 * nothing else happens. The counter lives in the process: a restart is a new generation for
 * every box, which is the right answer, since every callback died with the process.
 */

export interface GenerationStamp {
  boxId: string;
  generation: number;
}

export class BoxGenerations {
  private readonly current_ = new Map<string, number>();
  private readonly lastStale = new Map<string, { at: string; what: string }>();

  constructor(private readonly log: (line: string) => void = () => {}) {}

  /** The box's current generation; a box never bumped is at 0. */
  current(boxId: string): number {
    return this.current_.get(boxId) ?? 0;
  }

  /** A reconnect, recreate or attach: everything stamped before this is stale. */
  bump(boxId: string, why: string): number {
    const next = this.current(boxId) + 1;
    this.current_.set(boxId, next);
    this.log(`box ${boxId}: generation ${next} (${why})`);
    return next;
  }

  stamp(boxId: string): GenerationStamp {
    return { boxId, generation: this.current(boxId) };
  }

  /** True, and logged, when the stamp is from an earlier generation; the caller then does nothing. */
  stale(stamp: GenerationStamp, what: string): boolean {
    if (stamp.generation === this.current(stamp.boxId)) return false;
    this.lastStale.set(stamp.boxId, { at: new Date().toISOString(), what });
    this.log(`stale-generation: ${what} was for box ${stamp.boxId} generation ${stamp.generation}, now ${this.current(stamp.boxId)}; dropped`);
    return true;
  }

  /** For the box status: the generation and the last thing dropped as stale, if any. */
  statusOf(boxId: string): { generation: number; lastStaleDrop?: { at: string; what: string } } {
    const dropped = this.lastStale.get(boxId);
    return { generation: this.current(boxId), ...(dropped !== undefined ? { lastStaleDrop: dropped } : {}) };
  }
}
