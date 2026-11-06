/** The list order (INV-1626): waiting first, then what moved last, then the name; A→Z on request; teams by their newest member. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { ROW_ORDER_JS, rowOrder, teamOrder } from "./row-order.ts";

const row = (name: string, lastActivityAt?: string, awaiting = false) => ({ name, facts: { ...(lastActivityAt !== undefined ? { lastActivityAt } : {}), ...(awaiting ? { awaiting: { since: lastActivityAt ?? "2026-11-05T00:00:00Z" } } : {}) } });

test("blocked rows first, then the newest activity, then the name; a row that never moved sits last", () => {
  const rows = [row("Zed", "2026-11-05T10:00:00Z"), row("Ada", "2026-11-05T09:00:00Z"), row("Bob"), row("Vic", "2026-11-04T02:00:00Z", true), { name: "Mia" }];
  assert.deepEqual(rowOrder(rows, "recent").map(r => r.name), ["Vic", "Zed", "Ada", "Bob", "Mia"]);
  assert.deepEqual(rowOrder(rows, "az").map(r => r.name), ["Ada", "Bob", "Mia", "Vic", "Zed"]);
});

test("teams are ordered by their newest member, a waiting member outranking any time; A→Z on request", () => {
  const groups = { ops: [row("Ada", "2026-11-05T09:00:00Z")], media: [row("Zed", "2026-11-05T10:00:00Z"), row("Bob")], legal: [row("Vic", "2026-11-01T00:00:00Z", true)] };
  assert.deepEqual(teamOrder(groups, "recent"), ["legal", "media", "ops"]);
  assert.deepEqual(teamOrder(groups, "az"), ["legal", "media", "ops"]);
  assert.deepEqual(teamOrder({ b: [row("B")], a: [row("A")] }, "recent"), ["a", "b"], "nothing moved: the name decides");
});

test("the page's copy is the same source and runs as a classic script", () => {
  assert.match(ROW_ORDER_JS, /^function rowOrder\(rows, mode\) \{/);
  const fn = new Function(`${ROW_ORDER_JS}; return rowOrder([{ name: "B", facts: { lastActivityAt: "2" } }, { name: "A", facts: { awaiting: { since: "1" } } }], "recent").map(function (r) { return r.name; });`);
  assert.deepEqual(fn(), ["A", "B"]);
});
