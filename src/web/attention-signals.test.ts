/** The dock badge and the two notification kinds (INV-1626): needs-you when waiting begins, done when a turn ends with news; never focused; throttled. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const { badgeCount, notificationsDue, THROTTLE_MS } = createRequire(import.meta.url)("../../electron/attention-signals.cjs") as {
  badgeCount: (agents: unknown[]) => number;
  notificationsDue: (previous: unknown[], current: unknown[], focused: boolean, now: number, sent: Map<string, number>) => { kind: string; agentId: string; title: string; body: string; silent: boolean }[];
  THROTTLE_MS: number;
};

const agent = (id: string, over: Record<string, unknown> = {}) => ({ id, name: id[0]!.toUpperCase() + id.slice(1), running: false, facts: { unreadCount: 0 }, ...over });

test("the badge is the sum of unread over the agents; missing facts count nothing", () => {
  assert.equal(badgeCount([agent("ada", { facts: { unreadCount: 2 } }), agent("vic", { facts: { unreadCount: 3.7 } }), { id: "x", name: "X" }]), 5);
  assert.equal(badgeCount([]), 0);
});

test("needs-you fires once when waiting begins, with the reason; done fires when a turn ends with new unread; nothing while focused; throttled per agent and kind", () => {
  const sent = new Map<string, number>();
  const t0 = 1_000_000;
  const quiet = [agent("ada"), agent("vic", { running: true })];
  const waiting = [agent("ada", { facts: { unreadCount: 0, awaiting: { kind: "approval", reason: "bash — rm -rf .scratch", since: "x" } } }), agent("vic", { running: false, facts: { unreadCount: 1 } })];
  assert.deepEqual(notificationsDue(quiet, waiting, true, t0, sent), [], "focused: the person is looking");
  const due = notificationsDue(quiet, waiting, false, t0, sent);
  assert.deepEqual(due.map(n => [n.kind, n.agentId, n.silent]), [["needs-you", "ada", false], ["done", "vic", true]]);
  assert.equal(due[0]!.title, "Ada needs you");
  assert.equal(due[0]!.body, "bash — rm -rf .scratch");
  assert.deepEqual(notificationsDue(quiet, waiting, false, t0 + 1_000, sent), [], "the same change again inside the window is not sent twice");
  assert.equal(notificationsDue(quiet, waiting, false, t0 + THROTTLE_MS + 1, sent).length, 2, "past the window it may be said again");
  assert.deepEqual(notificationsDue(waiting, waiting, false, t0 + 20_000, sent), [], "still waiting is not news");
  const endedQuietly = [agent("ada"), agent("vic", { running: false, facts: { unreadCount: 0 } })];
  assert.deepEqual(notificationsDue(quiet, endedQuietly, false, t0 + 40_000, sent), [], "a turn that ended without saying anything is not done-news");
});
