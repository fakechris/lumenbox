import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkAttention, workRegistry, workStateConversation } from "./work-attention.ts";
import { AgentRegistry } from "./registry.ts";
import type { InboundMessage } from "./admitted-message.ts";

const user = (id: string): InboundMessage => ({ id, fromId: "user", fromName: "Chris", principalId: "p", text: "Install the package", priority: false, receivedAt: new Date().toISOString() });
test("waiting user work survives restart; unrelated priority cannot enter, a granted worker can return, and late generations cannot publish", () => {
  const directory = mkdtempSync(join(tmpdir(), "work-attention-"));
  try {
    const path = join(directory, "work.json"); let focus = new WorkAttention(path);
    const stamp = focus.begin("Mia", "main", [user("request-1")])!;
    const child = focus.link(stamp, "Mia", "Enzo")!;
    focus.settle(stamp, "waiting", "computer offline"); focus = new WorkAttention(path);
    const peer = { ...user("peer-1"), fromId: "Enzo", work: child };
    assert.equal(focus.get("Mia", "main")!.status, "waiting");
    assert.equal(focus.eligible("Mia", "main", { ...peer, work: undefined, priority: true }), false);
    assert.equal(focus.eligible("Mia", "main", peer), true);
    assert.equal(focus.link(stamp, "Stranger", "Mia"), undefined);
    const changed = focus.begin("Mia", "main", [{ ...user("request-2"), steerable: false }])!;
    assert.notEqual(changed.id, stamp.id); assert.equal(focus.valid(stamp, "Enzo"), false);
    focus.settle(stamp, "answered"); assert.equal(focus.get("Mia", "main")!.id, changed.id);
    focus.settle(changed, "answered"); assert.equal(focus.eligible("Mia", "main", { ...peer, work: undefined }), true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("a new context invalidates old work and collaborator authority, even after restart", () => {
  let epoch = 0; const focus = new WorkAttention(undefined, () => epoch);
  const old = focus.begin("Mia", "private", [user("old")])!;
  focus.link(old, "Mia", "Enzo"); epoch++;
  assert.equal(focus.get("Mia", "private"), undefined);
  assert.equal(focus.valid(old, "Enzo"), false);
  const next = focus.begin("Mia", "private", [user("new")])!;
  assert.equal(next.epoch, 1); assert.notEqual(next.id, old.id);
  focus.settle(old, "answered"); assert.equal(focus.get("Mia", "private")!.status, "running");
});

test("a crash between the canonical result and its work projection repairs the projection once without replaying the effect", () => {
  const dir = mkdtempSync(join(tmpdir(), "work-projection-"));
  try {
    const base = new AgentRegistry(dir), agent = base.create({name:"Mia"});
    const focus = new WorkAttention(), stamp = focus.begin(agent.id,"main",[user("root")])!;
    const scoped = workStateConversation(stamp,"main");
    const execution = workRegistry(base,agent.id,"main",scoped,stamp), append = base.appendTranscript.bind(base);
    base.appendTranscript = (id,entry,conversation) => { if (conversation === scoped) throw new Error("projection write interrupted"); append(id,entry,conversation); };
    assert.throws(() => execution.appendTranscript(agent.id,{role:"user",kind:"results",text:"side effect committed"}), /interrupted/);
    base.appendTranscript = append;
    assert.equal(base.readTranscript(agent.id).length,1,"the recovery ledger can see the actual result");
    const recovered = workRegistry(base,agent.id,"main",scoped,stamp);
    assert.equal(recovered.readTranscript(agent.id).length,1);
    workRegistry(base,agent.id,"main",scoped,stamp);
    assert.equal(base.readTranscript(agent.id,scoped).length,1,"projection repair is idempotent");
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test("unfinished user work holds an older goal and drops only volatile waits on restart", () => {
  const dir = mkdtempSync(join(tmpdir(),"attention-restart-"));
  try {
    const path = join(dir,"work.json"); let focus = new WorkAttention(path);
    const stamp = focus.begin("Mia","main",[user("install")])!;
    focus.hold(stamp,"job-1"); focus.settle(stamp,"waiting","waiting for related work");
    assert.equal(focus.eligible("Mia","main",{...user("old-goal"),synthetic:true,goal:{workId:"old-goal"} as never}),false);
    assert.equal(focus.eligible("Mia","main",{...user("resume"),synthetic:true,resumeOf:{id:"turn",attempt:2,workId:stamp.id}}),true);
    focus = new WorkAttention(path);
    assert.equal(focus.get("Mia","main")!.status,"waiting");
    assert.equal(focus.get("Mia","main")!.reason,"execution interrupted");
    assert.equal(focus.get("Mia","main")!.awaiting.length,0,"a dead in-memory watcher cannot hold the request forever");
  } finally {rmSync(dir,{recursive:true,force:true});}
});
