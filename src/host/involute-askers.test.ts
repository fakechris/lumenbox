import { test } from "node:test";
import assert from "node:assert/strict";
import { involuteIdentity, mayAnswerFrom } from "./involute-askers.ts";
import type { Principal } from "./principals.ts";

const roster: Principal[] = [
  { id: "dana", name: "Dana", role: "driver", identities: ["involute:actor-dana", "feishu:ou_dana"] },
  { id: "vic", name: "Vic", role: "viewer", identities: ["involute:actor-vic"] },
  { id: "ada", name: "Ada", role: "admin", identities: ["involute:actor-ada"] },
];

function deps(options: { members?: "everyone" | string[]; askers?: string[] } = {}) {
  return {
    resolve: (identity: string) =>
      roster.find(person => person.identities.includes(identity)) ?? { id: identity, name: identity, role: "viewer" as const, identities: [identity] },
    isKnown: (identity: string) => roster.some(person => person.identities.includes(identity)),
    boxOf: () => ({ name: "workshop", members: options.members ?? ("everyone" as const) }),
    ...(options.askers !== undefined ? { askers: options.askers } : {}),
  };
}

test("an Involute actor is one more identity, spelled like the channel ones", () => {
  assert.equal(involuteIdentity(" actor-dana "), "involute:actor-dana");
});

test("A1: a linked driver in the agent's box is answered, by the roster", () => {
  assert.deepEqual(mayAnswerFrom(deps(), { agentId: "bob", requestedByActorId: "actor-dana" }), { ok: true, via: "principal", who: "Dana" });
});

test("A2: a linked driver who is not in this agent's box is refused by name", () => {
  const verdict = mayAnswerFrom(deps({ members: ["ada"] }), { agentId: "bob", requestedByActorId: "actor-dana" });
  assert.equal(verdict.ok, false);
  assert.match((verdict as { why: string }).why, /workshop is not a box Dana is in/);
});

test("A3: a viewer is refused and told what role it takes", () => {
  const verdict = mayAnswerFrom(deps(), { agentId: "bob", requestedByActorId: "actor-vic" });
  assert.equal(verdict.ok, false);
  assert.match((verdict as { why: string }).why, /Vic is a viewer/);
  assert.match((verdict as { why: string }).why, /driver or admin/);
});

test("A4: an unlinked person is told how to get linked, not shown a UUID as a verdict", () => {
  const verdict = mayAnswerFrom(deps(), { agentId: "bob", requestedByActorId: "actor-stranger" });
  assert.equal(verdict.ok, false);
  const why = (verdict as { why: string }).why;
  assert.match(why, /Ask an admin to link/);
  assert.match(why, /involute:actor-stranger/, "the exact identity to paste is in the message");
  assert.match(why, /Settings → People/);
});

test("a request that does not say who asked is refused, not guessed", () => {
  for (const actor of [undefined, "", "  "]) {
    const verdict = mayAnswerFrom(deps({ askers: ["anyone"] }), { agentId: "bob", requestedByActorId: actor });
    assert.equal(verdict.ok, false);
    assert.match((verdict as { why: string }).why, /does not say who asked/);
  }
});

test("the old askers list still admits an actor nobody has linked, and says so", () => {
  assert.deepEqual(mayAnswerFrom(deps({ askers: ["actor-legacy"] }), { agentId: "bob", requestedByActorId: "actor-legacy" }), {
    ok: true,
    via: "askers",
    who: "actor-legacy",
  });
});

test("a principal link outranks the list: an unlinked-then-viewer person is not let back in by the list", () => {
  const verdict = mayAnswerFrom(deps({ askers: ["actor-vic"] }), { agentId: "bob", requestedByActorId: "actor-vic" });
  assert.equal(verdict.ok, false, "Vic is on the list but the roster says viewer, and the roster decides");
});

test("an admin counts as at least a driver", () => {
  assert.equal(mayAnswerFrom(deps({ members: ["ada"] }), { agentId: "bob", requestedByActorId: "actor-ada" }).ok, true);
});
