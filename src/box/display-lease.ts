/**
 * Exclusive access to a display, per display.
 *
 * X delivers synthetic input to whichever window currently has focus, so two agents
 * driving the same screen do not merely race — they corrupt each other: keystrokes
 * interleave into the wrong window, and each agent's screenshot shows the other's
 * work, so both reason from a screen that is not theirs.
 *
 * The lease was written when the box had one display, and stayed a single global
 * slot after every agent got a desktop of its own — so Bob holding *his* screen
 * refused Ada the browser on *hers*, and she told the person she was waiting for
 * Bob to "release the desktop" (measured 2026-09-01). The comment at the computer
 * tool already said "with a display each this never fires; it still guards the case
 * where two are pointed at the same one" — which is exactly what a lease keyed by
 * display does and a global slot does not.
 *
 * Still a refusal rather than a queue for a genuine same-display conflict: queueing
 * would block one agent behind another's long GUI task while telling it nothing; a
 * refusal lets the model do something else and come back. Same-agent claims are
 * re-entrant, and a turn releases everything its agent held on the way out.
 *
 * Shell and filesystem access are deliberately not gated. The box has one
 * filesystem and concurrent use of it is normal and useful — only a screen is
 * exclusive, and only to its own second claimant.
 */

export class DisplayLease {
  private readonly holders = new Map<number, { agentId: string; acquiredAt: number }>();

  /**
   * Claims `display` for `agentId`.
   *
   * Re-entrant for the holder, so a turn can call the computer tool repeatedly.
   * Returns false when another agent holds this display.
   */
  acquire(display: number, agentId: string): boolean {
    const holder = this.holders.get(display);
    if (holder === undefined) {
      this.holders.set(display, { agentId, acquiredAt: Date.now() });
      return true;
    }
    return holder.agentId === agentId;
  }

  /** Releases every display `agentId` holds — the turn-is-over sweep. */
  releaseAll(agentId: string): void {
    for (const [display, holder] of this.holders) {
      if (holder.agentId === agentId) this.holders.delete(display);
    }
  }

  heldBy(display: number): string | undefined {
    return this.holders.get(display)?.agentId;
  }

  /** How long the current holder has had this display, for diagnostics. */
  heldForMs(display: number): number {
    const holder = this.holders.get(display);
    return holder === undefined ? 0 : Date.now() - holder.acquiredAt;
  }
}
