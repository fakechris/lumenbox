import { test } from "node:test";
import assert from "node:assert/strict";
import { deliveryLine, deliveryOf } from "./delivery.ts";
import { afterTimeout } from "../protocol/idempotency.ts";

test("delivery is decided by what the batch showed, not by what kind of action it was (INV-1480)", () => {
  assert.equal(deliveryOf({ dispatch: "not_started" }), "not_delivered", "refused or failed before the first write: nothing went out");
  assert.equal(deliveryOf({ dispatch: "partial" }), "delivery_uncertain", "failed after some writes: which landed is not known");
  assert.equal(deliveryOf({ dispatch: "sent" }), "delivered_unverified", "sent, nothing seen");
  assert.equal(deliveryOf({ dispatch: "sent", effect: "unverifiable" }), "delivered_unverified");
  assert.equal(deliveryOf({ dispatch: "sent", effect: "suspected_noop" }), "delivered_unverified", "nothing changed near the point is not evidence it landed");
  assert.equal(deliveryOf({ dispatch: "sent", effect: "observed_change" }), "delivered_verified");
  assert.equal(deliveryOf({ dispatch: "sent", verification: { status: "unsatisfied", source: "native", detail: "x" } }), "delivered_verified", "verified to have landed, even though it did not do what was asked");
  assert.equal(deliveryOf({ dispatch: "sent", answered: false }), "unknown", "the box went quiet after dispatch");
  for (const delivery of ["not_delivered", "delivery_uncertain", "delivered_unverified", "delivered_verified", "unknown"] as const) {
    assert.match(deliveryLine(delivery), new RegExp(`^Delivery: ${delivery} — `));
  }
});

test("only not_delivered is sent again; the category rule stands where there is no verdict", () => {
  const toggle = { kind: "idempotent" as const, key: "ref" };
  assert.equal(afterTimeout(toggle, { ref: "a1" }, 1).retry, true, "without a verdict, an idempotent class is retried once, as before");
  assert.equal(afterTimeout(toggle, { ref: "a1" }, 1, "not_delivered").retry, true);
  assert.equal(afterTimeout(toggle, { ref: "a1" }, 2, "not_delivered").retry, false, "not forever");
  for (const delivery of ["delivery_uncertain", "delivered_unverified", "delivered_verified", "unknown"] as const) {
    const plan = afterTimeout(toggle, { ref: "a1" }, 1, delivery);
    assert.equal(plan.retry, false, `${delivery}: a toggle that landed undoes itself when repeated`);
    assert.match(plan.note ?? "", new RegExp(`\\(${delivery}\\) — look at the screen`));
  }
  assert.equal(afterTimeout({ kind: "read" }, {}, 1, "delivered_verified").retry, false, "the verdict outranks even a read's class");
});
