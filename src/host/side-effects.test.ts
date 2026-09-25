import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTools } from "./tools.ts";
import { SEARCH_PROVIDERS } from "./web.ts";
import { declaredTools, sideEffectOf, tierAsks, tierGateMode } from "./side-effects.ts";
import { PolicyGate, type PolicyLimits } from "./policy.ts";

/** Every tool this installation can offer, with every optional one switched on. */
function everyTool(): string[] {
  const key = SEARCH_PROVIDERS[0]!.keyEnv;
  const before = process.env[key];
  process.env[key] = "offered-for-the-guard";
  try {
    return buildTools(true, true, undefined, true, true, true, true, false, ["github"]).map(tool => tool.name);
  } finally {
    if (before === undefined) delete process.env[key];
    else process.env[key] = before;
  }
}

test("every offered tool has a declared effect, and every declaration names a real tool", () => {
  const offered = new Set(everyTool());
  const declared = new Set(declaredTools());
  // connector_request is decided per call, by its method.
  const undeclared = [...offered].filter(name => name !== "connector_request" && !declared.has(name));
  assert.deepEqual(undeclared, [], "a new tool must say what it does to the world in side-effects.ts");
  // The table this replaced named a tool that did not exist (SendToChat). A declaration for
  // nothing is worse than none: it reads as coverage.
  const phantom = [...declared].filter(name => !offered.has(name));
  assert.deepEqual(phantom, [], "a declaration must name a tool buildTools can offer");
});

test("tiers follow reach and reversibility, not read versus write", () => {
  assert.equal(sideEffectOf("read_file").tier, "observe");
  assert.equal(sideEffectOf("write_file").tier, "self", "writing in its own box is the agent's work, not a person's decision");
  assert.equal(sideEffectOf("bash").tier, "self");
  assert.equal(sideEffectOf("AskUser").tier, "self", "talking to the person who asked reaches no one else");
  assert.equal(sideEffectOf("SendToAgent").tier, "self");
  assert.equal(sideEffectOf("browser_act").tier, "self", "a click is self until the box says this click pays");
  assert.equal(sideEffectOf("browser_upload").tier, "reach");
  assert.equal(sideEffectOf("RunOnHost").tier, "credential");
  assert.equal(sideEffectOf("connector_request", { connector: "github", method: "GET", path: "/user" }).tier, "observe");
  const write = sideEffectOf("connector_request", { connector: "github", method: "POST", path: "/repos/x/issues" });
  assert.equal(write.tier, "reach");
  assert.match(write.action!, /github/);
  const mcp = sideEffectOf("linear__create_issue");
  assert.equal(mcp.tier, "reach", "a tool we cannot see into is assumed to leave the box");
  assert.match(mcp.action!, /create_issue on linear/);
  assert.equal(sideEffectOf("ext__anything").tier, "reach");
  assert.equal(sideEffectOf("NoSuchTool").tier, "reach", "never assumed harmless");
});

test("only reach, spend, credential and irreversible would ask", () => {
  assert.deepEqual(
    (["observe", "self", "reach", "spend", "credential", "irreversible"] as const).filter(tierAsks),
    ["reach", "spend", "credential", "irreversible"]
  );
});

test("the gate mode is shadow unless somebody says otherwise", () => {
  assert.equal(tierGateMode({}), "shadow");
  assert.equal(tierGateMode({ AGENTBOX_TIER_GATE: "enforce" }), "enforce");
  assert.equal(tierGateMode({ AGENTBOX_TIER_GATE: "off" }), "off");
  assert.equal(tierGateMode({ AGENTBOX_TIER_GATE: "nonsense" }), "shadow", "an unreadable value falls to the mode that changes nothing");
});

function gate(tierGate: PolicyLimits["tierGate"], path?: string) {
  const dir = path === undefined ? mkdtempSync(join(tmpdir(), "agentbox-tier-")) : undefined;
  const file = path ?? join(dir!, "policy.jsonl");
  const made = new PolicyGate({
    path: file,
    limits: {
      budgetWindowHours: 24, wakesPerWindow: 30, wakeWindowMinutes: 10,
      approvalRequiredTools: [], approvalRequiredCommands: [],
      ...(tierGate !== undefined ? { tierGate } : {}),
    },
  });
  return { gate: made, file, cleanup: () => { if (dir !== undefined) rmSync(dir, { recursive: true, force: true }); } };
}

const call = (tool: string, input: Record<string, unknown> = {}) =>
  ({ kind: "tool" as const, agentId: "a1", agentName: "Ada", tool, input });

test("shadow changes no decision, and writes what it would have asked", () => {
  const { gate: shadow, file, cleanup } = gate("shadow");
  try {
    assert.deepEqual(shadow.check(call("write_file", { path: "/home/box/work/a.md", content: "x" })), { allow: true });
    assert.deepEqual(shadow.check(call("linear__create_issue", { title: "t" })), { allow: true }, "shadow never asks");
    assert.deepEqual(shadow.check(call("CreateAgent", { name: "B" })), { allow: true });
    const rows = readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(rows.map(row => [row.tier, row.wouldAsk]), [
      ["self", undefined],
      ["reach", "linear__create_issue"],
      ["credential", "CreateAgent"],
    ]);
    const summary = shadow.tierShadow();
    assert.equal(summary.mode, "shadow");
    assert.equal(summary.total, 2);
    assert.deepEqual(summary.tools.map(entry => entry.tool).sort(), ["CreateAgent", "linear__create_issue"]);
  } finally { cleanup(); }
});

test("the shadow summary survives a restart, because it is read back from the log", () => {
  const { gate: first, file, cleanup } = gate("shadow");
  try {
    first.check(call("browser_upload", { path: "/home/box/work/a.pdf" }));
    const second = gate("shadow", file).gate;
    assert.equal(second.tierShadow().total, 1);
    assert.equal(second.tierShadow().tools[0]!.tool, "browser_upload");
  } finally { cleanup(); }
});

test("RunOnHost still asks in every mode, and in shadow it is not counted as would-have-asked: it did ask", () => {
  for (const mode of ["off", "shadow", "enforce"] as const) {
    const { gate: made, cleanup } = gate(mode);
    try {
      const decision = made.check(call("RunOnHost", { command: "ls" }));
      assert.equal(decision.allow, false, mode);
      assert.equal(made.tierShadow().total, 0, mode);
      assert.equal(made.pending()[0]!.action, "run a command on the person's own machine", "the card carries the host's phrase");
    } finally { cleanup(); }
  }
});

test("enforce asks for reach and credential, not for self; and the phrase is outside the fingerprinted description", () => {
  const { gate: enforce, cleanup } = gate("enforce");
  try {
    assert.deepEqual(enforce.check(call("write_file", { path: "/home/box/work/a.md", content: "x" })), { allow: true });
    const asked = enforce.check(call("linear__create_issue", { title: "t" }));
    assert.equal(asked.allow, false);
    const pending = enforce.pending()[0]!;
    assert.equal(pending.action, "call create_issue on linear, a service outside the box");
    assert.doesNotMatch(pending.description, /a service outside the box/, "the description stays the verbatim action");
  } finally { cleanup(); }
});

test("off records no tier asks at all", () => {
  const { gate: off, cleanup } = gate("off");
  try {
    assert.deepEqual(off.check(call("linear__create_issue", {})), { allow: true });
    assert.equal(off.tierShadow().total, 0);
  } finally { cleanup(); }
});

test("a delegated engine's own tools are tiered by what they are here, so reading is not reaching", () => {
  assert.equal(sideEffectOf("engine:Read").tier, "observe");
  assert.equal(sideEffectOf("engine:Grep").tier, "observe", "Grep is reading and listing");
  assert.equal(sideEffectOf("engine:Glob").tier, "observe");
  assert.equal(sideEffectOf("engine:Bash").tier, "self");
  const unknown = sideEffectOf("engine:Frobnicate");
  assert.equal(unknown.tier, "reach", "an engine tool we cannot see into leaves the box");
  assert.match(unknown.action!, /delegated engine run its Frobnicate tool/);
});
