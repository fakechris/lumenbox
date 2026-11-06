/**
 * An agent's ask-before settings (INV-1664): how a chip's state is resolved, what a body may
 * carry, and — the claim that matters — that at the gate the organisation's policy outranks
 * the agent's setting, which outranks the group default, and that an agent's "allow" loosens
 * nothing. Plus the verdict each step carries for the chat, live and after a restart.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PolicyGate, type PolicyLimits } from "./policy.ts";
import { RuleStore } from "./rules.ts";
import { agentRulesFor, groupOf, orgFloor, parseToolPermissions, permissionFor, type ToolPermissions } from "./tool-permissions.ts";

test("a tool's setting is its own chip, else its group's default, else allow; the talking tools are never asked", () => {
  const permissions: ToolPermissions = { groups: { desk: "ask", web: "ask" }, tools: { read_file: "allow", Delegate: "ask" } };
  assert.equal(groupOf("bash"), "desk");
  assert.equal(groupOf("notion__search"), "desk", "a connected service's tools ride with the desk");
  assert.equal(groupOf("browser_open"), "web");
  assert.equal(groupOf("Delegate"), "code");
  assert.equal(groupOf("CreateAgent"), "team");
  assert.equal(groupOf("RunOnHost"), "other");
  assert.deepEqual(permissionFor(permissions, "bash"), { permission: "ask", source: "group", group: "desk" });
  assert.deepEqual(permissionFor(permissions, "read_file"), { permission: "allow", source: "tool", group: "desk" }, "a chip overrides its group");
  assert.deepEqual(permissionFor(permissions, "Delegate"), { permission: "ask", source: "tool", group: "code" });
  assert.deepEqual(permissionFor(permissions, "CreateAgent"), { permission: "allow", source: "default", group: "team" });
  assert.equal(permissionFor(permissions, "AskUser").permission, "allow", "asking a person before asking a person is a loop");
  assert.equal(permissionFor(undefined, "bash").permission, "allow");
  // Only an ask makes a rule, scoped to the agent, named for where it came from.
  const [rule] = agentRulesFor({ id: "a-1", name: "Nova" }, permissions, "bash");
  assert.equal(rule?.id, "agent:Nova/desk");
  assert.deepEqual(rule?.agents, ["a-1"]);
  assert.equal(rule?.source, "agent");
  assert.deepEqual(agentRulesFor({ id: "a-1", name: "Nova" }, permissions, "read_file"), [], "an allow makes no rule, so it can lift nothing");
});

test("a body's toolPermissions is checked by name, not quietly dropped", () => {
  assert.deepEqual(parseToolPermissions({ groups: { web: "ask" }, tools: { bash: "ask", AskUser: "ask" } }), { groups: { web: "ask" }, tools: { bash: "ask" } });
  assert.equal(parseToolPermissions(null), null);
  assert.equal(parseToolPermissions({}), null, "nothing set is no setting");
  assert.match(String(parseToolPermissions({ groups: { kitchen: "ask" } })), /no tool group "kitchen"/);
  assert.match(String(parseToolPermissions({ tools: { bash: "off" } })), /"off" is the tool list's/);
  assert.match(String(parseToolPermissions([])), /must be an object/);
});

function world(limits: Partial<PolicyLimits> = {}, rules: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-toolperm-"));
  const rulesDir = join(dir, "rules");
  mkdirSync(rulesDir);
  for (const [name, content] of Object.entries(rules)) writeFileSync(join(rulesDir, `${name}.md`), content);
  const permissions = new Map<string, ToolPermissions>();
  const make = () => {
    const gate = new PolicyGate({
      path: join(dir, "policy.jsonl"),
      rules: new RuleStore(rulesDir),
      limits: { budgetWindowHours: 24, wakesPerWindow: 30, wakeWindowMinutes: 10, approvalRequiredTools: [], approvalRequiredCommands: [], tierGate: "off", ...limits },
    });
    gate.agentPermissions = agentId => permissions.get(agentId);
    return gate;
  };
  const call = (gate: PolicyGate, tool: string, callId: string, agentId = "a-1", input: Record<string, unknown> = { command: "ls" }) =>
    gate.check({ kind: "tool", agentId, agentName: agentId === "a-1" ? "Nova" : "Rex", tool, input, callId });
  return { permissions, make, call, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("at the gate: the organisation's policy, then the agent's setting, then the group default — and an agent's allow loosens nothing", () => {
  const ask = (tool: string) => `---\neffect: ask\ntool: ${tool}\n---\nThe operator reviews ${tool}.\n`;
  const w = world({ approvalRequiredTools: ["write_file"] }, { "review-edit": ask("edit_file"), "no-delete": "---\neffect: deny\ntool: RemoveFile\n---\nNever.\n" });
  try {
    const gate = w.make();
    // Group default asks for the desk; the agent's own chip allows read_file; edit_file is allowed by the agent but the operator asks.
    w.permissions.set("a-1", { groups: { desk: "ask" }, tools: { read_file: "allow", edit_file: "allow", write_file: "allow" } });
    const bash = w.call(gate, "bash", "c1");
    assert.equal(bash.allow, false, "the group default asks");
    assert.ok(!bash.allow && bash.approval !== undefined, "with a consent card");
    assert.match(!bash.allow ? bash.approval!.description : "", /^\[rule agent:Nova\/desk\]/, "and the card says whose setting asked");
    assert.equal(w.call(gate, "read_file", "c2", "a-1", { path: "/x" }).allow, true, "the agent's own chip outranks its group");
    assert.equal(w.call(gate, "edit_file", "c3", "a-1", { path: "/x" }).allow, false, "an operator's ask is not lifted by the agent's allow");
    assert.equal(w.call(gate, "write_file", "c4", "a-1", { path: "/x" }).allow, false, "nor is the installation's approval list");
    assert.equal(w.call(gate, "bash", "c5", "a-2").allow, true, "another agent's calls are its own business");
    // The verdicts the chat draws, with their reasons.
    assert.equal(gate.verdicts.get("c1")?.verdict, "waiting");
    assert.match(gate.verdicts.get("c1")!.basis, /the agent's setting \(Nova: ask before any desk tool\)/);
    assert.deepEqual([gate.verdicts.get("c2")?.verdict, gate.verdicts.get("c2")?.basis], ["allowed", "nothing asks for this"]);
    assert.match(gate.verdicts.get("c3")!.basis, /operator rule review-edit/);
    assert.match(gate.verdicts.get("c4")!.basis, /approval list/);
    // The person allows the card: the step's mark says so, and the agent's retry runs on that consent.
    gate.grant(bash.allow ? "" : bash.approval!.id);
    assert.equal(gate.verdicts.get("c1")?.verdict, "asked");
    assert.equal(w.call(gate, "bash", "c6").allow, true);
    assert.equal(gate.verdicts.get("c6")?.verdict, "asked");
    assert.match(gate.verdicts.get("c6")!.basis, /a person's approval, once/);
    // A rule's deny, whatever the agent says.
    w.permissions.set("a-1", { tools: { RemoveFile: "allow" } });
    assert.equal(w.call(gate, "RemoveFile", "c7", "a-1", {}).allow, false);
    assert.deepEqual([gate.verdicts.get("c7")?.verdict, gate.verdicts.get("c7")?.basis], ["refused", "operator rule no-delete refuses it"]);
    // After a restart the marks are read back from the ledger.
    const again = w.make();
    assert.equal(again.verdicts.get("c1")?.verdict, "asked", "the answered card is not 'waiting' after a restart");
    assert.equal(again.verdicts.get("c7")?.verdict, "refused");
    // The floors the dialog greys, with their sources.
    const floor = (tool: string) => orgFloor(tool, { id: "a-1", name: "Nova" }, gate.floorContext());
    assert.deepEqual(floor("edit_file"), { effect: "ask", source: "operator rule review-edit" });
    assert.deepEqual(floor("RemoveFile"), { effect: "deny", source: "operator rule no-delete" });
    assert.equal(floor("write_file")?.source, "the installation's approval list of tools that always ask");
    assert.equal(floor("RunOnHost")?.effect, "ask");
    assert.equal(floor("bash"), undefined, "nothing outside the agent's own setting asks about bash here");
  } finally {
    w.cleanup();
  }
});
