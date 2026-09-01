/**
 * The guards that make every other test trustworthy, tested themselves.
 *
 * A guard nobody checks is a guard that quietly stops working — and its failure looks
 * exactly like everything being fine, because what it prevents is invisible when it
 * works. Hermes learned this the expensive way and keeps a regression test for its live
 * system guard; these are ours.
 *
 * Both guards are installed by the runner (`npm test`), not by this file, so these
 * assertions also prove the runner is the one being used: run the suite the wrong way
 * and these fail rather than silently passing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { agentboxHome } from "../config.ts";

test("a test cannot reach the network, and says so where the call was made", async () => {
  // The two that would cost real money and real state if a test ever slipped through.
  await assert.rejects(
    fetch("https://api.anthropic.com/v1/messages", { method: "POST" }),
    /reach https:\/\/api\.anthropic\.com/,
    "a model call must not leave the machine"
  );
  await assert.rejects(
    fetch("https://open.feishu.cn/open-apis/im/v1/chats"),
    /reach https:\/\/open\.feishu\.cn/,
    "a vendor call must not leave the machine"
  );

  // Loopback stays open on purpose: several suites stand up a real server and call it.
  // Nothing is listening on this port, so the failure is a connection refusal from the
  // stack rather than a refusal from the guard — which is the distinction being pinned.
  await assert.rejects(fetch("http://127.0.0.1:9/nothing"), error => {
    assert.doesNotMatch(String(error), /BlockedByTestGuard/, "loopback must not be blocked");
    return true;
  });
});

test("a test cannot reach the live installation by accident", () => {
  // The failure this prevents was real and silent: the orchestrator opens its usage
  // ledger off this path, so the resume tests appended to a person's actual spend
  // record on every run until 2026-09-01.
  const previous = process.env.AGENTBOX_HOME;
  try {
    delete process.env.AGENTBOX_HOME;
    assert.throws(() => agentboxHome(), /must not touch the live installation/);
    // With somewhere of its own, it answers normally.
    process.env.AGENTBOX_HOME = "/tmp/agentbox-guard-probe";
    assert.equal(agentboxHome(), "/tmp/agentbox-guard-probe");
  } finally {
    if (previous === undefined) delete process.env.AGENTBOX_HOME;
    else process.env.AGENTBOX_HOME = previous;
  }
});

test("the run carries no credential a test could accidentally depend on", () => {
  // The allowlist is in scripts/test-env.mjs; this is the claim it exists to make.
  // Checked by shape rather than by name, so a credential added next month is covered
  // by a rule written today.
  const leaked = Object.keys(process.env).filter(key =>
    /(_API_KEY|_SECRET|_TOKEN|_APP_ID|_CLIENT_ID|PASSWORD)$/.test(key)
  );
  assert.deepEqual(leaked, [], `credentials visible to tests: ${leaked.join(", ")}`);
});
