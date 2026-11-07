/**
 * One person, many channel identities, one Owner (INV-1698): the Owner's own code links any door to
 * them, and a roster of six people who are one person is previewed, confirmed and merged — every
 * store moved through one mapping, the old ids kept as aliases, nothing touched without the yes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureOwner, OWNER_ID, PersonalInstallationOnly } from "./installation.ts";
import { Principals } from "./principals.ts";
import { redeemInvite } from "./invite-redeem.ts";
import { applyPendingMerge, confirmMerge, MERGE_JOURNAL, MergeRefused, mergePreview, type MergeJournal } from "./self-merge.ts";
import { SIX, SIX_IDS, sixPaths, writeSixIdentities } from "./testing/six-identities.ts";

function withHome(run: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), "self-merge-"));
  try { run(home); } finally { rmSync(home, { recursive: true, force: true }); }
}

/** Every file under `dir` and its bytes, the journal and lock files aside: what "changed nothing" is checked against. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name !== MERGE_JOURNAL && !name.endsWith(".lock.sqlite")) out[path.slice(dir.length)] = readFileSync(path, "utf8");
    }
  };
  walk(dir);
  return out;
}

const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const lines = (path: string) => readFileSync(path, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
const doorType = (door: string) => ({ feishu: "feishu", "feishu-work": "feishu", dingtalk: "dingtalk" } as Record<string, string>)[door];

test("the Owner's own code links a second Feishu app, DingTalk or a browser to the Owner; a code for a new person is refused", () => {
  withHome(home => {
    const path = join(home, "principals.json");
    assert.equal(ensureOwner(path, join(home, "bootstrap-code"), { desktop: true, name: "Sam" }), "created");
    const principals = new Principals(path, { incarnationOf: identity => (identity.startsWith("feishu-work:") ? 2 : 1), warn: () => {} });
    for (const identity of ["feishu-work:ou_fake_second_app", "dingtalk:fake_staff_09", "web:fake_browser_09"]) {
      const redeemed = redeemInvite(principals, { role: "driver", principalId: OWNER_ID, expiresAt: Date.now() + 60_000 }, identity, "whoever");
      assert.equal(redeemed.kind, "linked");
      assert.equal(principals.resolve(identity).id, OWNER_ID, `${identity} is the Owner`);
    }
    assert.equal(principals.list().length, 1, "nobody was added");
    const stored = json(path).principals[0].identities as { identity: string; incarnation: number }[];
    assert.deepEqual(stored.find(link => link.identity === "feishu-work:ou_fake_second_app"), { identity: "feishu-work:ou_fake_second_app", incarnation: 2 }, "the link carries the door's incarnation (docs/22 §4)");
    assert.throws(() => redeemInvite(principals, { role: "driver", expiresAt: Date.now() + 60_000 }, "feishu:ou_fake_stranger", "Ann"), PersonalInstallationOnly);
    assert.deepEqual(redeemInvite(principals, { role: "driver", principalId: "feishu:ou_gone", expiresAt: Date.now() + 60_000 }, "feishu:ou_fake_stranger", "Ann"), { kind: "gone" }, "a code for an id nobody holds mints nobody");
    assert.equal(principals.list().length, 1);
  });
});

test("the preview of six identities says where each came from and what a merge would change, and changes nothing", () => {
  withHome(home => {
    writeSixIdentities(home);
    const before = snapshot(home);
    const preview = mergePreview(sixPaths(home), { desktop: true, doorType });
    assert.equal(preview.offered, true);
    assert.equal(preview.ownerName, "Sam", "the admin's name");
    assert.deepEqual(preview.people.map(person => [person.id, person.role]), SIX_IDS.map(id => [id, id === SIX.admin ? "admin" : "driver"]));
    const admin = preview.people[0]!;
    assert.deepEqual(admin.identities, [{ identity: SIX.admin, door: "feishu", doorType: "feishu", lastSeen: "2026-10-09T08:00:00.000Z" }]);
    assert.equal(admin.lastActive, "2026-10-09T08:00:00.000Z", "the newer of its last message and its last spend");
    assert.equal(preview.people[4]!.lastActive, "2026-10-06T09:00:00.000Z", "DingTalk: spend only");
    assert.equal(preview.people[5]!.identities[0]!.doorType, undefined, "a browser is no configured door");
    assert.deepEqual(preview.hints, [{ kind: "same-name", name: "Sam", count: 3 }, { kind: "same-door", door: "feishu-work", count: 3 }]);
    assert.deepEqual(Object.fromEntries(preview.changes.map(change => [change.store, change.records])), {
      "mcp-tokens": 2, watchdog: 1, tasks: 2, spend: 2, memory: 2, "person-notes": 1, "box-members": 1, "vault-grants": 1, rules: 1, "box-quotas": 2, sessions: 1, turns: 1, inbox: 1,
    });
    assert.ok(preview.kept.includes("messages.jsonl"));
    assert.deepEqual(snapshot(home), before, "a preview writes nothing");
    assert.equal(existsSync(join(home, MERGE_JOURNAL)), false);

    assert.equal(mergePreview(sixPaths(home), { desktop: false }).reason, "server", "a server is an organisation: no offer");
    const roster = json(join(home, "principals.json"));
    writeFileSync(join(home, "principals.json"), JSON.stringify({ ...roster, installation: { mode: "organisation" } }));
    assert.equal(mergePreview(sixPaths(home), { desktop: true }).reason, "decided", "an installation field is a decision already made");
  });
});

test("confirmed, the next start leaves one Owner with all six identities, every store moved, the old ids as aliases, and the record", () => {
  withHome(home => {
    writeSixIdentities(home);
    const paths = sixPaths(home);
    const preview = mergePreview(paths, { desktop: true, doorType });
    const before = snapshot(home);
    const journal = confirmMerge(paths, { digest: preview.digest, by: "the operator", desktop: true, now: 1_800_000_000_000 });
    assert.equal(journal.state, "pending");
    assert.deepEqual(snapshot(home), before, "a confirmation writes the journal and nothing else");
    assert.equal(mergePreview(paths, { desktop: true }).reason, "pending");

    const logs: string[] = [];
    const done = applyPendingMerge(paths, line => logs.push(line), () => 1_800_000_000_500)!;
    assert.equal(done.state, "done");
    assert.match(logs[0]!, /^upgrade: 6 people .* merged into its Owner "Sam"/);

    const roster = json(paths.roster);
    assert.deepEqual(roster.installation, { mode: "single-machine", ownerId: OWNER_ID, createdAt: 1_800_000_000_000, merged: { at: 1_800_000_000_000, from: [...SIX_IDS] } });
    assert.equal(roster.principals.length, 1);
    assert.deepEqual(roster.principals[0].identities.map((link: { identity: string }) => link.identity), [...SIX_IDS]);
    const principals = new Principals(paths.roster, { warn: () => {} });
    assert.equal(principals.installation().mode, "single-machine");
    for (const id of SIX_IDS) {
      assert.equal(principals.resolve(id).id, OWNER_ID, `${id} speaks as the Owner`);
      assert.equal(principals.byId(id)?.id, OWNER_ID, `${id} as an old id finds the Owner`);
    }
    assert.deepEqual(principals.byId(OWNER_ID)?.aliases, [...SIX_IDS]);
    assert.equal(principals.list()[0]!.role, "admin");

    assert.deepEqual(json(join(home, "mcp-tokens.json")).tokens.map((t: { principalId: string }) => t.principalId), [OWNER_ID, OWNER_ID]);
    assert.equal(json(join(home, "watchdog", "install.json")).principalId, OWNER_ID);
    const tasks = lines(paths.tasks).filter(line => line.kind === "task").map(line => [line.task.id, line.task.requester, line.task.history[0].by]);
    assert.deepEqual(tasks, [["t1", OWNER_ID, OWNER_ID], ["t1", OWNER_ID, OWNER_ID], ["t2", OWNER_ID, "ada"], ["t3", "web", "ada"]], "an agent's id and the operator's placeholder are not people");
    assert.deepEqual(lines(paths.usage).map(row => row.principal), [OWNER_ID, OWNER_ID, undefined]);
    assert.equal(lines(join(home, "agents", "ada", "memory.jsonl"))[0].about, OWNER_ID);
    assert.equal(lines(join(home, "agents", "shared-memory", "ada.jsonl"))[0].about, OWNER_ID);
    assert.equal(lines(join(home, "people.jsonl"))[0].principal, OWNER_ID);
    assert.deepEqual(json(join(home, "agents", "boxes.json"))[0].members, [OWNER_ID, "someone-else"]);
    assert.deepEqual(json(paths.vault).secrets[0].grants.map((g: { holder: string }) => g.holder), [`principal:${OWNER_ID}`, "agent:ada"]);
    assert.deepEqual(json(join(home, "session-epochs.json")), { [OWNER_ID]: 2 }, "a browser signed out before stays signed out");
    assert.deepEqual(json(paths.config).personBoxQuotas, { [OWNER_ID]: 3 });
    assert.match(readFileSync(join(home, "rules", "sams-deploys.md"), "utf8"), /^principal: local:owner$/m);
    assert.equal(lines(paths.turns)[0].principalId, OWNER_ID);
    assert.equal(lines(paths.inbox)[0].message.principalId, OWNER_ID);
    assert.equal(readFileSync(join(home, "messages.jsonl"), "utf8"), before["/messages.jsonl"], "the message log is kept as written");

    const record = json(join(home, MERGE_JOURNAL)) as MergeJournal;
    assert.equal(record.by, "the operator");
    assert.deepEqual(record.from.map(person => person.id), [...SIX_IDS], "the people as they were");
    assert.deepEqual(record.changes, Object.fromEntries(preview.changes.map(change => [change.store, change.records])), "the merge did what the preview said");

    const after = snapshot(home);
    assert.equal(applyPendingMerge(paths, () => {}), undefined, "nothing pending: a later start does nothing");
    assert.deepEqual(snapshot(home), after);
    assert.equal(mergePreview(paths, { desktop: true }).reason, "decided");
  });
});

test("a roster changed after the preview is refused, one changed after the confirmation is abandoned, and a merge cut short finishes", () => {
  withHome(home => {
    writeSixIdentities(home);
    const paths = sixPaths(home);
    const preview = mergePreview(paths, { desktop: true });
    assert.throws(() => confirmMerge(paths, { digest: "not-the-preview", by: "x", desktop: true }), (error: unknown) => error instanceof MergeRefused && error.why === "stale");
    assert.throws(() => confirmMerge(paths, { digest: preview.digest, by: "x", desktop: false }), (error: unknown) => error instanceof MergeRefused && error.why === "server");

    confirmMerge(paths, { digest: preview.digest, by: "x", desktop: true });
    const roster = json(paths.roster);
    roster.principals[3].name = "Someone Else";
    writeFileSync(paths.roster, JSON.stringify(roster));
    const untouched = snapshot(home);
    const logs: string[] = [];
    assert.equal(applyPendingMerge(paths, line => logs.push(line))?.state, "abandoned");
    assert.match(logs[0]!, /not applied — the roster changed/);
    assert.deepEqual(snapshot(home), untouched, "an abandoned merge moves nothing");
  });
  withHome(home => {
    writeSixIdentities(home);
    const paths = sixPaths(home);
    const journal = confirmMerge(paths, { digest: mergePreview(paths, { desktop: true }).digest, by: "x", desktop: true });
    applyPendingMerge(paths, () => {});
    const merged = snapshot(home);
    // The process died after the roster was written and before the journal said done.
    writeFileSync(join(home, MERGE_JOURNAL), JSON.stringify(journal));
    assert.equal(applyPendingMerge(paths, () => {})?.state, "done");
    assert.deepEqual(snapshot(home), merged, "resuming is idempotent");
  });
});
