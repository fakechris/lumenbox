/**
 * Exclusive access to the box's single X display.
 *
 * The box has one display, and X delivers synthetic input to whichever window
 * currently has focus. Two agents driving the desktop at once therefore do not
 * merely race — they corrupt each other: keystrokes interleave into the wrong
 * window, and each agent's screenshot shows the other's work, so both reason from
 * a screen that is not theirs. Nothing about coordinate handling can fix that.
 *
 * The fix is a lease: hold the
 * display for the duration of a turn, and REFUSE a second claimant rather than
 * queueing it. Queueing would block one agent behind another's long GUI task while
 * telling it nothing; a refusal lets the model do something else, or say so, and
 * come back.
 *
 * Shell and filesystem access are deliberately not gated. The box has one
 * filesystem and concurrent use of it is normal and useful — only the screen is
 * exclusive.
 */

export class DisplayLease {
  private holderId: string | undefined;
  private acquiredAt = 0;

  /**
   * Claims the display for `agentId`.
   *
   * Re-entrant for the holder, so a turn can call the computer tool repeatedly.
   * Returns false when another agent holds it.
   */
  acquire(agentId: string): boolean {
    if (this.holderId === undefined) {
      this.holderId = agentId;
      this.acquiredAt = Date.now();
      return true;
    }
    return this.holderId === agentId;
  }

  /** Releases the display if `agentId` holds it. A non-holder is a no-op. */
  release(agentId: string): void {
    if (this.holderId === agentId) {
      this.holderId = undefined;
      this.acquiredAt = 0;
    }
  }

  heldBy(): string | undefined {
    return this.holderId;
  }

  /** How long the current holder has had it, for diagnostics. */
  heldForMs(): number {
    return this.acquiredAt === 0 ? 0 : Date.now() - this.acquiredAt;
  }
}
