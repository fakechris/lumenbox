/**
 * Did the input reach the desktop? Decided per batch from what this batch showed, not from
 * what kind of action it was (INV-1480).
 *
 * The category rule (read / idempotent / unsafe) is right about tools and wrong about
 * desktops: a toggle is idempotent as a class and undoes itself as an instance, and a click
 * repeated after a lost answer clicks twice. So a desktop result carries its own delivery
 * verdict, and only `not_delivered` is safe to send again:
 *
 *   - not_delivered       — nothing was dispatched: refused, or the batch failed before its first write.
 *   - delivery_uncertain  — the batch failed after some writes went out; which landed is unknown.
 *   - delivered_unverified — the writes went out and nothing showed whether they took.
 *   - delivered_verified  — the writes went out and something was seen: pixels changed near the
 *                           point, or a postcondition held. Delivered is not done: the application
 *                           may still have discarded it.
 *   - unknown             — the box went quiet after dispatch; the writes may or may not have landed.
 */

import type { ActionVerification, ComputerProgress, Delivery, Effect } from "../protocol/index.ts";

export function deliveryOf(input: { dispatch: ComputerProgress["dispatch"]; effect?: Effect; verification?: ActionVerification; answered?: boolean }): Delivery {
  if (input.dispatch === "not_started") return "not_delivered";
  if (input.dispatch === "partial") return "delivery_uncertain";
  if (input.answered === false) return "unknown";
  const seen = input.verification?.status === "satisfied" || input.verification?.status === "unsatisfied" ||
    input.effect === "observed_change" || input.effect === "partial" || input.effect === "confirmed";
  return seen ? "delivered_verified" : "delivered_unverified";
}

/** The sentence a model reads: what the verdict means for acting again. */
export function deliveryLine(delivery: Delivery): string {
  switch (delivery) {
    case "not_delivered": return "Delivery: not_delivered — nothing was sent; the same actions may be sent again.";
    case "delivery_uncertain": return "Delivery: delivery_uncertain — some of the batch went out before it failed; look at the screen before sending any of it again.";
    case "delivered_unverified": return "Delivery: delivered_unverified — the input went out, nothing showed whether it took; look before repeating it.";
    case "delivered_verified": return "Delivery: delivered_verified — the input went out and the screen answered; repeating it would do it twice.";
    case "unknown": return "Delivery: unknown — the box went quiet after dispatch; look before acting again, never repeat a write on this.";
  }
}
