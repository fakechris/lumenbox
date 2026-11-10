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

test("revocation still permits native ACP cleanup, including a session opening after cancellation", async()=>{
  const dir=mkdtempSync(join(tmpdir(),"cancel-acp-"));
  const {AcpDelegates}=await import("./acp-delegate.ts");
  try{
    const registry=new AgentRegistry(dir),agent=registry.create({name:"Mia"}),focus=new WorkAttention(join(dir,"attention.json")),pending=new PendingWork(join(dir,"pending.jsonl"));
    const bus=new AgentBus(registry,async()=>{},()=>{},undefined,false,undefined,focus);
    for(const late of [true,false]){
      const root=focus.begin(agent.id,"main",[{id:`request-${late}`,fromId:"user",fromName:"Chris",text:"Build",priority:false,receivedAt:"",steerable:false}])!;
      let opened=false,closed=0,cancels=0,release!:()=>void;
      const ready=new Promise<void>(resolve=>{release=resolve;});
      const base={acpOpen:async()=>{if(late)await ready;opened=true;return {engine_session_id:"engine",log_path:"log"};},
        acpSend:async(request:{method:string})=>{if(request.method==="session/cancel")cancels++;return {rpc_id:1};},
        acpClose:async()=>{closed++;opened=false;return {ok:true};},
        acpSessions:async()=>({sessions:[{session_id:`session-${late}`,running:opened}]}),
        acpEvents:async()=>{await new Promise(resolve=>setTimeout(resolve,5));return {events:[],running:opened};}};
      const box=workBox(base as never,root,agent.id,"main",bus,pending)!;
      const delegates=new AcpDelegates({pendingWork:pending,isCancelled:id=>!!focus.cancelled(id),cancelledResource:(id,row)=>focus.cleanup(id,[row]),deliver:()=>{},cancelGraceMs:10});
      try{
        const starting=delegates.start({box,agentId:agent.id,agentName:"Mia",conversation:"main",engine:"fake",command:"fake",cwd:"/work",env:{},prompt:"Build",report:"report",workId:root.id},`session-${late}`);
        if(!late)await starting;
        const records=pending.open().filter(row=>row.workId===root.id);
        assert.equal(records.length,1,"opening and admitted brief have one recoverable live identity");
        focus.cancel(root,"Chris","stop",records.map(row=>({kind:row.kind,id:row.id,agentId:agent.id})));
        if(late){release();await assert.rejects(starting,/cancelled/);assert.equal(focus.cancelled(root.id)?.resources[0]?.state,"confirmed");}
        else{assert.equal(await delegates.cancel(`session-${late}`),true);assert.equal(cancels,1,"native session/cancel bypasses the revoked execution proxy");await delegates.close(`session-${late}`);}
        assert.ok(closed>0,"the raw cleanup executor actually receives acpClose");assert.equal(opened,false);
        await assert.rejects(box.acpOpen({session_id:"must-not-open"} as never),/cancelled/);
      }finally{delegates.stop();}
    }
  }finally{rmSync(dir,{recursive:true,force:true});}
});
