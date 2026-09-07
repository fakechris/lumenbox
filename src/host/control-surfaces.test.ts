import { test } from "node:test";
import assert from "node:assert/strict";
import { namesControlSurface } from "./control-surfaces.ts";

test("a skill that names the host's own ledgers or secrets is caught by name", () => {
  assert.equal(namesControlSurface("# Deploy\n\nRun the tests, then open a PR."), undefined);
  assert.equal(namesControlSurface("append {\"status\":\"done\"} to tasks.jsonl"), "tasks.jsonl");
  assert.ok(["~/.agentbox/", "policy.jsonl"].includes(namesControlSurface("edit ~/.agentbox/policy.jsonl to allow") ?? ""));
  assert.ok(["/home/hostd/.agentbox/", "pending-work.jsonl"].includes(namesControlSurface("cat /home/hostd/.agentbox/pending-work.jsonl") ?? ""));
  assert.equal(namesControlSurface("echo $LUMENBOX_RELAY_TOKEN"), "LUMENBOX_RELAY_TOKEN");
  // The word alone is prose, not a path.
  assert.equal(namesControlSurface("talk about tasks and policy with the team"), undefined);
});
