/**
 * Tests for telling someone when a box changes state.
 *
 * Everything here was pull-only: health, crashes and degraded desktops were recorded faithfully and
 * reported to whoever asked, and nobody asks at three in the morning. What is on test is that a
 * notice fires on a *change* and not on every sweep — because a notice every sweep gets muted, and
 * a muted channel is worse than none.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { HealthNotifier, type BoxNotice } from "./notify.ts";

const BOX = { id: "box-1", externalId: "agentbox-acme-1a2b", tenantId: "t1" };

function notifier() {
  const notices: BoxNotice[] = [];
  return { notices, sut: new HealthNotifier(notice => notices.push(notice)) };
}

test("a healthy box that stays healthy says nothing at all", () => {
  const { notices, sut } = notifier();
  for (let sweep = 0; sweep < 5; sweep++) {
    sut.observe(BOX, { reachable: true, degraded: false });
  }
  assert.deepEqual(notices, [], "a notice every sweep is a notice nobody reads");
});

test("going down is said once, and coming back is said too", () => {
  const { notices, sut } = notifier();
  sut.observe(BOX, { reachable: true, degraded: false });
  sut.observe(BOX, { reachable: false, degraded: false });
  sut.observe(BOX, { reachable: false, degraded: false });
  sut.observe(BOX, { reachable: false, degraded: false });

  assert.equal(notices.length, 1, "once per transition, not once per sweep");
  assert.equal(notices[0]?.kind, "unreachable");
  assert.match(notices[0]?.text ?? "", /stopped answering/);
  assert.match(notices[0]?.text ?? "", /Work on it is not happening/);

  // "It came back" is the thing you most want at three in the morning, and the thing systems most
  // often leave out — after which people ignore the alerts that do matter.
  sut.observe(BOX, { reachable: true, degraded: false });
  assert.equal(notices[1]?.kind, "recovered");
  assert.match(notices[1]?.text ?? "", /answering again/);
});

test("a degraded desktop is its own thing, and says what still works", () => {
  const { notices, sut } = notifier();
  sut.observe(BOX, { reachable: true, degraded: false });
  sut.observe(BOX, { reachable: true, degraded: true });

  assert.equal(notices.length, 1);
  assert.equal(notices[0]?.kind, "degraded");
  // The distinction that decides whether anyone needs to get up: the agents are fine, the watching
  // is not.
  assert.match(notices[0]?.text ?? "", /Agents will keep working/);
  assert.match(notices[0]?.text ?? "", /nobody can watch them live/);

  sut.observe(BOX, { reachable: true, degraded: true });
  assert.equal(notices.length, 1, "still degraded is not news");

  sut.observe(BOX, { reachable: true, degraded: false });
  assert.equal(notices[1]?.kind, "undegraded");
});

test("a box that is already broken when we first see it is news; a healthy one is not", () => {
  // Starting a control plane should not page anyone about every box that is fine.
  const healthy = notifier();
  healthy.sut.observe(BOX, { reachable: true, degraded: false });
  assert.deepEqual(healthy.notices, []);

  const broken = notifier();
  broken.sut.observe(BOX, { reachable: false, degraded: false });
  assert.equal(broken.notices[0]?.kind, "unreachable");
  assert.match(broken.notices[0]?.text ?? "", /already down when this control plane started/);
});

test("a box that comes back still broken does not read as fully recovered", () => {
  const { notices, sut } = notifier();
  sut.observe(BOX, { reachable: true, degraded: false });
  sut.observe(BOX, { reachable: false, degraded: false });
  sut.observe(BOX, { reachable: true, degraded: true });

  assert.deepEqual(
    notices.map(notice => notice.kind),
    ["unreachable", "recovered", "degraded"]
  );
});

test("a notice carries what an operator will type next", () => {
  const { notices, sut } = notifier();
  sut.observe(BOX, { reachable: true, degraded: false });
  sut.observe(BOX, { reachable: false, degraded: false }, new Date("2026-08-20T03:00:00Z"));
  const notice = notices[0]!;
  assert.equal(notice.externalId, "agentbox-acme-1a2b", "the container name, not just an id");
  assert.equal(notice.tenantId, "t1");
  assert.equal(notice.at, "2026-08-20T03:00:00.000Z");
});
