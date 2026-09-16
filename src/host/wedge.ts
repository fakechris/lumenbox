/**
 * A box that is alive and stuck (INV-135).
 *
 * What the host could see until now was whether it *had* a client for a box — which
 * answers "was the daemon killed" and nothing else. The failure that actually costs a
 * morning is the other one: the daemon is up, the socket is open, and every call hangs.
 * From the outside it looks identical to a busy box, and the only signal was a person
 * eventually asking why nothing had moved.
 *
 * So: every call the host makes to a box reports back here, and this keeps two numbers
 * per box — when it last answered, and when it was last asked. The verdict is the gap
 * between them:
 *
 *   - **ok** — it answered recently.
 *   - **slow** — it has been asked and not answered for a while, but not long enough to
 *     act on. Said once, not repeated.
 *   - **wedged** — asked repeatedly over a long window and answering nothing. This is the
 *     one worth waking somebody for: a restart fixes it and nothing else will.
 *   - **quiet** — nobody has asked it anything. Not a verdict about the box at all, and
 *     deliberately never an alert: an idle box is the normal state of most boxes.
 *
 * The collector runs whether or not anybody is looking. That is the whole point of it:
 * the existing health surface told an operator who opened the page, and a box that wedges
 * at 02:00 was found at 09:00 (docs/47).
 */

export type WedgeState = "ok" | "slow" | "wedged" | "quiet";

export interface BoxProbe {
  boxId: string;
  name: string;
  /** When it was asked. */
  asked: number;
  /** When it last answered anything, or undefined if it never has. */
  answered?: number;
}

export interface WedgeVerdict {
  boxId: string;
  name: string;
  state: WedgeState;
  /** How long it has been asked without answering, in ms. */
  silentFor: number;
  detail: string;
}

/** Asked and unanswered this long: worth saying once. */
export const SLOW_AFTER_MS = 2 * 60_000;
/** Asked and unanswered this long: worth waking somebody. */
export const WEDGED_AFTER_MS = 10 * 60_000;

export class WedgeWatch {
  private readonly probes = new Map<string, BoxProbe>();

  /** A call to a box is about to be made. */
  asked(boxId: string, name: string, now = Date.now()): void {
    const probe = this.probes.get(boxId) ?? { boxId, name, asked: now };
    probe.name = name;
    probe.asked = now;
    this.probes.set(boxId, probe);
  }

  /** A call to a box came back — whatever it said. An answer is an answer. */
  answered(boxId: string, now = Date.now()): void {
    const probe = this.probes.get(boxId);
    if (probe === undefined) return;
    probe.answered = now;
  }

  /** A box nobody talks to any more: its verdict is nobody's business. */
  forget(boxId: string): void {
    this.probes.delete(boxId);
  }

  assess(now = Date.now()): WedgeVerdict[] {
    const out: WedgeVerdict[] = [];
    for (const probe of this.probes.values()) {
      // Never asked, or answered since the last ask: nothing is outstanding.
      const outstanding = probe.answered === undefined || probe.answered < probe.asked;
      const since = probe.answered ?? probe.asked;
      const silentFor = outstanding ? now - since : 0;
      const state: WedgeState = !outstanding
        ? "ok"
        : silentFor >= WEDGED_AFTER_MS
          ? "wedged"
          : silentFor >= SLOW_AFTER_MS
            ? "slow"
            : "ok";
      out.push({
        boxId: probe.boxId,
        name: probe.name,
        state,
        silentFor,
        detail:
          state === "wedged"
            ? `${probe.name} has been asked and has answered nothing for ${Math.round(silentFor / 60_000)} minutes — the daemon is up and stuck, not gone. Restarting the box is what fixes this.`
            : state === "slow"
              ? `${probe.name} has not answered for ${Math.round(silentFor / 60_000)} minutes; still waiting.`
              : `${probe.name} is answering.`,
      });
    }
    return out;
  }

  /**
   * The verdicts worth telling somebody about now, given what they were told last time.
   * A state that has not changed is not repeated: an alert that repeats every minute is
   * an alert people filter, including on the occasion it is true (the same rule the
   * channel health line follows).
   */
  changed(previous: Map<string, WedgeState>, now = Date.now()): WedgeVerdict[] {
    const news: WedgeVerdict[] = [];
    for (const verdict of this.assess(now)) {
      const before = previous.get(verdict.boxId);
      if (before === verdict.state) continue;
      previous.set(verdict.boxId, verdict.state);
      // Two transitions are worth somebody's attention: becoming stuck, and coming back.
      // `slow` is recorded so the next change is a change, and never announced — it is
      // "still waiting", which is what every busy box looks like.
      if (verdict.state === "wedged") news.push(verdict);
      else if (before === "wedged" && verdict.state === "ok") news.push(verdict);
    }
    return news;
  }
}
