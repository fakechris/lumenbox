import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {AgentRegistry} from "../agents/registry.ts";
import {AgentBus} from "../agents/bus.ts";
import {WorkAttention} from "../agents/work-attention.ts";
import {PendingWork} from "./pending-work.ts";
import {workBox} from "./work-executor.ts";

test("a command returning after cancellation is stopped and recorded without reviving the work", async()=>{
  const dir=mkdtempSync(join(tmpdir(),"late-command-"));
  try{
    const registry=new AgentRegistry(dir),agent=registry.create({name:"Mia"}),focus=new WorkAttention(join(dir,"attention.json")),pending=new PendingWork(join(dir,"pending.jsonl"));
    const root=focus.begin(agent.id,"main",[{id:"request",fromId:"user",fromName:"Chris",text:"Build the package",priority:false,receivedAt:""}])!;
    const bus=new AgentBus(registry,async()=>{},()=>{},undefined,false,undefined,focus);let finish!:()=>void,started=false;const done=new Promise<void>(r=>{finish=r;}),killed:string[]=[];
    const base={startJob:async()=>{await done;started=true;return {job_id:"late-job"};},killJob:async(id:string)=>{assert.equal(started,true);killed.push(id);},waitForJob:async()=>({running:false})};
    const box=workBox(base as never,root,agent.id,"main",bus,pending)!;
    const result=box.startJob("build",{jobId:"late-job"});
    const ledger=pending.open()[0]!;assert.equal(ledger.workId,root.id);
    focus.cancel(root,"Chris","cancel",[{kind:"command",id:ledger.id,agentId:agent.id}]);finish();await result;
    assert.deepEqual(killed,["late-job"]);assert.equal(pending.open().length,0);
    assert.equal(focus.cancelled(root.id)!.resources[0]!.state,"confirmed");
    focus.cleanup(root.id,[{kind:"command",id:ledger.id,state:"unconfirmed"}]);
    assert.equal(focus.cancelled(root.id)!.resources[0]!.state,"confirmed","a stale cleanup response cannot undo a later observation");
    await assert.rejects(box.startJob("must not run",{jobId:"second"}),/cancelled/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
