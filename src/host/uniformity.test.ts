/**
 * The uniformity matrix (docs/22 §7 item 6): every agent of a box yields
 * identical secret and policy decisions for the same caller and the same
 * deed. One file ties the three migrations together — vault subjects, scope
 * subjects, approval fingerprints — because the claim is one claim, and
 * testing it in three places would let the pieces pass while the matrix
 * fails.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { PolicyGate, type PolicyRequest } from "./policy.ts";
import { Vault } from "./vault.ts";

function temp(): string {
  return join(mkdtempSync(join(tmpdir(), "agentbox-uniform-")), "file");
}

// ------------------------------------------------------------------- Secrets

test("secrets: two workers of one box reach identically; another box reaches differently", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-uniform-vault-"));
  try {
    const vaultPath = join(dir, "vault.json");
    writeFileSync(
      vaultPath,
      JSON.stringify({
        secrets: [
          {
            id: "deploy-key",
            value: "v1",
            grants: [{ holder: "box:bx-1" }],
          },
          {
            id: "legacy-key",
            value: "v2",
            // Written when grants named agents; read as that agent's box now.
            grants: [{ holder: "agent:ada" }],
          },
          {
            id: "ghost-key",
            value: "v3",
            // A holder whose agent nobody remembers covers nothing.
            grants: [{ holder: "agent:deleted" }],
          },
          {
            id: "star-key",
            value: "v4",
            grants: [{ holder: "*" }],
          },
        ],
      }),
      "utf8",
    );
    const boxes = new Map([
      ["ada", "bx-1"],
      ["bob", "bx-1"],
      ["carol", "bx-2"],
    ]);
    const vault = new Vault(vaultPath, join(dir, "audit.jsonl"), {
      boxOfAgent: agentId => boxes.get(agentId),
    });

    // The matrix: every agent of bx-1, same answers.
    for (const agentId of ["ada", "bob"]) {
      assert.equal(vault.resolve("deploy-key", { agentId, boxId: "bx-1" }), "v1", `${agentId}: box grant`);
      assert.equal(vault.resolve("legacy-key", { agentId, boxId: "bx-1" }), "v2", `${agentId}: legacy agent grant read as its box`);
      assert.equal(vault.resolve("ghost-key", { agentId, boxId: "bx-1" }), undefined, `${agentId}: an unresolvable holder covers nobody`);
      assert.equal(vault.resolve("star-key", { agentId, boxId: "bx-1" }), "v4", `${agentId}: everyone grant`);
    }
    // Another box reaches differently — that is the boundary, not a bug.
    assert.equal(vault.resolve("deploy-key", { agentId: "carol", boxId: "bx-2" }), undefined);
    assert.equal(vault.resolve("legacy-key", { agentId: "carol", boxId: "bx-2" }), undefined);
    // A caller with no box named (older paths) is covered only by `*` — fail
    // closed on everything that needs a subject.
    assert.equal(vault.resolve("deploy-key", { agentId: "ada" }), undefined);
    assert.equal(vault.resolve("star-key", { agentId: "ada" }), "v4");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ Approvals

const toolRequest = (agentId: string, agentName: string): PolicyRequest => ({
  kind: "tool",
  agentId,
  agentName,
  tool: "bash",
  input: { command: "rm README.md" },
});

test("approvals: a session grant holds for every worker of the box, and the same deed by name is the same deed", () => {
  const path = temp();
  try {
    const gate = new PolicyGate({
      path,
      limits: {
        budgetWindowHours: 24,
        wakesPerWindow: 30,
        wakeWindowMinutes: 10,
        approvalRequiredCommands: ["rm "],
        approvalRequiredTools: [],
      },
      boxOfAgent: agentId =>
        agentId === "ada" || agentId === "bob" ? "bx-1" : agentId === "carol" ? "bx-2" : undefined,
    });

    // Ada asks; a person answers "for this session".
    const first = gate.check(toolRequest("ada", "Ada"));
    assert.ok(!first.allow && first.approval !== undefined, "Ada's request waits for a person");
    assert.equal(gate.grant((first as { approval: { id: string } }).approval.id, "alice", "session"), true);

    // Bob, same box, the same deed — covered by Ada's session grant, because
    // the grant's subject is the box and the deed is name-less.
    assert.equal(gate.check(toolRequest("bob", "Bob")).allow, true, "same box, same deed: covered");

    // Carol, another box — her own approval, not Ada's box's.
    const other = gate.check(toolRequest("carol", "Carol"));
    assert.ok(!other.allow && other.approval !== undefined, "another box asks its own person");

    // A different deed in the same box is not covered: the name was never the
    // only thing separating grants.
    const escalated = gate.check({
      kind: "tool",
      agentId: "bob",
      agentName: "Bob",
      tool: "bash",
      input: { command: "rm -rf /home/box/work" },
    });
    assert.ok(!escalated.allow, "a worse command is a different deed, box or no box");
  } finally {
    rmSync(dirname(path), { recursive: true, force: true });
  }
});

test("approvals: a once grant stays one occurrence, whoever consumes it", () => {
  const path = temp();
  try {
    const gate = new PolicyGate({
      path,
      limits: {
        budgetWindowHours: 24,
        wakesPerWindow: 30,
        wakeWindowMinutes: 10,
        approvalRequiredCommands: ["rm "],
        approvalRequiredTools: [],
      },
      boxOfAgent: agentId => (agentId === "ada" || agentId === "bob" ? "bx-1" : undefined),
    });
    const first = gate.check(toolRequest("ada", "Ada"));
    const id = (first as { approval: { id: string } }).approval.id;
    assert.equal(gate.grant(id, "alice"), true); // once, the default
    assert.equal(gate.check(toolRequest("bob", "Bob")).allow, true, "consumed by the box's next worker");
    assert.equal(gate.check(toolRequest("ada", "Ada")).allow, false, "and by exactly one");
  } finally {
    rmSync(dirname(path), { recursive: true, force: true });
  }
});
