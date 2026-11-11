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

test("a participant's host callback resolves the admitted root and its private execution conversation", async () => {
  const {peerWorkConversation} = await import("./work-attention.ts");
  const focus = new WorkAttention(), root = focus.begin("Mia","main",[user("install")])!;
  const child = focus.link(root,"Mia","Zed")!;
  const conversation = peerWorkConversation([{...user("child"),fromId:"Mia",work:child}],"main");
  assert.equal(focus.forId("Zed",conversation,root.id)!.owner,"Mia");
  assert.equal(focus.forId("Zed","main",root.id),undefined);
  assert.equal(focus.forId("Stranger",conversation,root.id),undefined);
});

test("informational messages do not acquire dependencies, and mutual waits are refused", async () => {
  const {AgentBus}=await import("./bus.ts");
  const dir=mkdtempSync(join(tmpdir(),"attention-dependencies-"));
  try {
    const registry=new AgentRegistry(dir), mia=registry.create({name:"Mia"}), zed=registry.create({name:"Zed"}), focus=new WorkAttention();
    const miaWork=focus.begin(mia.id,"main",[user("mia-work")])!, zedWork=focus.begin(zed.id,"main",[user("zed-work")])!;
    const bus=new AgentBus(registry,async()=>{},()=>{},undefined,false,undefined,focus);
    assert.match(bus.send({fromId:mia.id,toId:zed.id,text:"Need a result",work:miaWork}),/Held/);
    assert.match(bus.send({fromId:zed.id,toId:mia.id,text:"Need your result first",work:zedWork}),/deadlock/);
    assert.equal(focus.get(zed.id,"main")!.awaiting.length,0);
    bus.send({fromId:zed.id,toId:mia.id,text:"Information only",work:zedWork,expectResult:false});
    assert.equal(focus.get(zed.id,"main")!.awaiting.length,0);
    assert.equal(focus.get(zed.id,"main")!.peers.includes(mia.id),true,"causal association is retained even without a reply dependency");
    await bus.idle();
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test("a no-reply final result retains lineage and releases its sender's dependency", async () => {
  const {AgentBus}=await import("./bus.ts");const dir=mkdtempSync(join(tmpdir(),"attention-no-reply-"));
  try {
    const registry=new AgentRegistry(dir), mia=registry.create({name:"Mia"}), zed=registry.create({name:"Zed"}), focus=new WorkAttention();
    const root=focus.begin(mia.id,"main",[user("install")])!, child=focus.link(root,mia.id,zed.id)!;focus.settle(root,"waiting");
    let consumed=0;const bus=new AgentBus(registry,async()=>{consumed++;},()=>{},undefined,false,undefined,focus);
    bus.send({fromId:zed.id,toId:mia.id,text:"Verified final result; no acknowledgement needed",work:child,expectResult:false});await bus.idle();
    assert.equal(consumed,1);assert.equal(bus.heldCount(mia.id),0);assert.equal(focus.get(mia.id,"main")!.awaiting.length,0);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test("status questions preserve each participant's capability blocker until its own successful observation", () => {
  const focus=new WorkAttention(), stamp=focus.begin("Mia","main",[user("install")])!;focus.link(stamp,"Mia","Zed");
  focus.capability(stamp,"Mia","bash",false);focus.capability(stamp,"Zed","read_file",false);focus.settle(stamp,"waiting");
  focus.begin("Mia","main",[{...user("status"),text:"What is blocking the installation?"}]);
  assert.equal(focus.get("Mia","main")!.unavailable!.length,2);
  focus.capability(stamp,"Zed","read_file",true);
  assert.deepEqual(focus.get("Mia","main")!.unavailable,[{participant:"Mia",tool:"bash"}]);
});

test("work validity consults the durable context version even inside a captured old execution", async () => {
  const dir=mkdtempSync(join(tmpdir(),"attention-epoch-fence-"));
  try {
    const registry=new AgentRegistry(dir), agent=registry.create({name:"Mia"});
    const focus=new WorkAttention(undefined,(id,conversation)=>registry.contextStore(id,conversation).current().epoch);
    await registry.withContext(agent.id,"private",async()=>{
      const work=focus.begin(agent.id,"private",[user("install")])!;
      registry.contextStore(agent.id,"private").advance("new-context",0,"normal");
      assert.equal(registry.contextVersion(agent.id,"private"),0,"the old execution still carries its captured context");
      assert.equal(focus.valid(work,agent.id),false,"captured context is not current authority");
    });
  } finally {rmSync(dir,{recursive:true,force:true});}
});


test("an approved goal may continue its admitted task, while an unrelated goal remains held", () => {
  const focus = new WorkAttention();
  const root = focus.begin("Mia","main",[{...user("draft-request"),taskBinding:{taskId:"t1"} as never}])!;
  focus.settle(root,"waiting");
  assert.equal(focus.eligible("Mia","main",{...user("goal"),synthetic:true,goal:{workId:"approved-work",taskId:"t1"} as never}),true);
  assert.equal(focus.eligible("Mia","main",{...user("other-goal"),synthetic:true,goal:{workId:"other-work",taskId:"t2"} as never}),false);
});

test("cancellation is durable, blocks old continuations, and leaves a colleague's other work alone", async () => {
  const dir=mkdtempSync(join(tmpdir(),"work-cancel-"));
  try {
    const path=join(dir,"work.json");let focus=new WorkAttention(path);
    const root=focus.begin("Mia","main",[user("install")])!, peer=focus.link(root,"Mia","Zed")!;
    const independent=focus.begin("Zed","main",[user("other-request")])!;
    focus.hold(root,"active-command");
    const ended=focus.cancel(root,"Chris","This task went off track");
    assert.deepEqual(ended.participants,["Mia","Zed"]);
    assert.equal(focus.valid(root,"Mia"),false);assert.equal(focus.valid(peer,"Zed"),false);
    assert.equal(focus.valid(independent,"Zed"),true);
    focus=new WorkAttention(path);
    assert.equal(focus.cancelled(root.id)?.by,"Chris");
    assert.equal(focus.eligible("Mia","main",{...user("continuation"),synthetic:true,goal:{workId:root.id,taskId:"t1"} as never}),false);
    assert.equal(focus.get("Mia","main")?.status,"cancelled","a cancelled work with volatile waits stays terminal after restart");
    assert.throws(()=>focus.existing("Mia","main",root.id),/cancelled/);
    const next=focus.begin("Mia","main",[user("new-request")])!;
    assert.notEqual(next.id,root.id);assert.equal(focus.valid(next,"Mia"),true);
    assert.equal(focus.cancel(root,"Chris","repeated").at,ended.at,"retries preserve the original cancellation");
  } finally {rmSync(dir,{recursive:true,force:true});}
});
