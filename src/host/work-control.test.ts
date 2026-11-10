import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {AgentRegistry} from "../agents/registry.ts";
import {Orchestrator} from "./orchestrator.ts";
import {TaskStore} from "./tasks.ts";
import {PendingWork} from "./pending-work.ts";
import {QuestionWatch} from "./question-expiry.ts";
import {AgentPauses} from "./agent-pause.ts";
import {workControlFor,workControlRoute} from "../web/work-control-routes.ts";
import {workBox} from "./work-executor.ts";
import {fakeModel} from "./testing/fake-model.ts";
const user=(id:string)=>({id,fromId:"user",fromName:"Chris",principalId:"chris",text:"Install the package",priority:false,receivedAt:new Date().toISOString()});

test("the real host revokes a task and its native waits before callbacks, retains other work, and rejects stale previews", async()=>{
  const dir=mkdtempSync(join(tmpdir(),"work-control-host-")), previous=process.env.AGENTBOX_HOME;process.env.AGENTBOX_HOME=dir;
  try {
    const registry=new AgentRegistry(join(dir,"agents")), mia=registry.create({name:"Mia"}), zed=registry.create({name:"Zed"}), pendingWork=new PendingWork(join(dir,"pending-work.jsonl"));
    let calls=0;const tasks=new TaskStore(null), child=tasks.create({title:"Package subtask",requester:"chris",assigneeId:mia.id})!, rootTask=tasks.create({title:"Install package",requester:"chris",assigneeId:mia.id,blockedBy:[child.id]})!;
    const host=new Orchestrator({registry,useBox:false,inbox:null,mcp:null,hooks:null,tasks,extensions:null,pendingWork,
      client:fakeModel(()=>{calls++;return {id:"r",type:"message",role:"assistant",model:"test",content:[{type:"text",text:"Independent work continues"}],stop_reason:"end_turn",stop_sequence:null,usage:{input_tokens:1,output_tokens:1}} as never;})});
    const focus=host.bus.workAttention!, root=focus.begin(mia.id,"main",[{...user("request"),taskBinding:{taskId:rootTask.id,role:"executor" as const}}])!;focus.link(root,mia.id,zed.id);focus.settle(root,"waiting");
    const other=focus.begin(zed.id,"main",[user("independent")])!;
    const questions=new QuestionWatch(), q=questions.ask({agentId:mia.id,agentName:"Mia",conversation:"main",question:"Continue?",work:root}).question;
    const secrets=new Map([["credential",{agentId:mia.id,work:root}]]), desktops=new Map([[mia.id,{agentId:mia.id,work:root}]]);
    const pauses=new AgentPauses({dirFor:id=>registry.dirFor(id),interrupt:ids=>host.bus.interruptAgents(ids,"paused"),wake:()=>{},tell:async()=>{},receipt:()=>{},log:()=>{},box:()=>undefined});
    const control=workControlFor(host,pauses,questions,secrets,desktops), target={agentId:mia.id,conversation:"main"};
    const first=control.preview(target);
    const denied={host,pauses,refusedAdmin:()=>false,mayReadAgent:(id:string)=>id===mia.id,by:()=>"outside-admin",readJson:async()=>({agentId:mia.id,conversation:"main",token:control.preview(target).token})};
    const hidden=await workControlRoute("GET /api/work-control/preview",new URL(`http://localhost/?agentId=${mia.id}`),control,denied);
    assert.equal(hidden?.status,403,"even an admin cannot read an inaccessible collaborating box");
    const rejected=await workControlRoute("POST /api/work-control/cancel",new URL("http://localhost/"),control,denied);
    assert.equal(rejected?.status,403);assert.equal(focus.valid(root,mia.id),true);
    const batch=await workControlRoute("POST /api/work-control/pause-members",new URL("http://localhost/"),control,{...denied,readJson:async()=>({agents:[mia.id,zed.id]})});
    assert.equal(batch?.status,403);assert.equal(pauses.pauseOf(mia.id),undefined,"check every member before the durable pause barrier");
    const killed:string[]=[];
    const rawBox={startJob:async()=>{throw new Error("response lost after creating remote job");},killJob:async(id:string)=>{killed.push(id);},waitForJob:async()=>({running:false})};
    host.boxFor=()=>rawBox as never;
    await assert.rejects(workBox(rawBox as never,root,mia.id,"main",host.bus,pendingWork)!.startJob("build",{jobId:"created-with-lost-response"}),/response lost/);
    assert.ok(new PendingWork(join(dir,"pending-work.jsonl")).open().some(row=>row.child==="created-with-lost-response"),"unknown dispatch retains its known cleanup id across restart");

    const item=pendingWork.prepare({kind:"ext-job",agentId:zed.id,workId:root.id,parent:"peer-conversation",child:"external-operation",brief:"building the package"});
    await assert.rejects(control.cancel(target,first.token!,"Chris","stop"),/refresh/);
    const approval=host.policy.requestConfirmation({agentId:mia.id,agentName:"Mia",description:"Approve extension"});
    pendingWork.prepare({kind:"pause",agentId:mia.id,workId:root.id,parent:"main",child:"resume-tool",brief:"continue",data:{approvalId:approval.id}});
    pendingWork.prepare({kind:"orchestrate",agentId:mia.id,workId:root.id,parent:"main",child:"plan",brief:"subtask",data:{cards:[child.id]}});
    const preview=control.preview(target), ended=await control.cancel(target,preview.token!,"Chris","Task went off track");
    assert.deepEqual(killed,["created-with-lost-response"]);
    assert.equal(focus.valid(root,mia.id),false);assert.equal(focus.valid(other,zed.id),true);
    assert.equal(questions.list().some(row=>row.id===q.id),false);assert.equal(secrets.size,0);assert.equal(desktops.size,0);assert.equal(host.policy.pending().length,0);assert.equal(tasks.get(rootTask.id)!.status,"dropped");assert.equal(tasks.get(child.id)!.status,"dropped");
    assert.equal(pendingWork.open().some(row=>row.id===item),false);
    assert.ok(ended.resources.some(row=>row.kind==="ext-job" && row.state==="unconfirmed"),"unknown external work is not called stopped");
    host.bus.deliverSystem(mia.id,"LATE_CANCELLED_RESULT","main",root.id);await host.bus.idle();assert.equal(calls,0);
    await host.prompt(zed.id,"Continue independent work",undefined,{work:other,synthetic:true,origin:"host:jobs"});assert.equal(calls,1);
    let read=false;
    const response=await workControlRoute("POST /api/work-control/cancel",new URL("http://localhost/"),control,{host,pauses,refusedAdmin:()=>true,mayReadAgent:()=>false,by:()=>"stranger",readJson:async()=>{read=true;return {};}});
    assert.equal(response!.status,0);assert.equal(read,false);
  } finally {if(previous===undefined)delete process.env.AGENTBOX_HOME;else process.env.AGENTBOX_HOME=previous;rmSync(dir,{recursive:true,force:true});}
});
