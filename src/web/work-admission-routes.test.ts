/** Admission receipts are tested through the real HTTP door, with every member paused. */
import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtempSync,mkdirSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createServer} from "node:net";
import {AgentRegistry} from "../agents/registry.ts";
import {TaskStore} from "../host/tasks.ts";
import {startWebServer} from "./server.ts";

test("202 means the user request is durably visible; an unwritable root is refused before acknowledgement",async()=>{
 const home=mkdtempSync(join(tmpdir(),"work-http-")),previous=process.env.AGENTBOX_HOME;
 process.env.AGENTBOX_HOME=home;let stop:(()=>void)|undefined;
 try {
  const registry=new AgentRegistry(join(home,"agents")),agent=registry.create({name:"Mia"});
  const port=await new Promise<number>(resolve=>{const probe=createServer().listen(0,"127.0.0.1",()=>{const p=(probe.address() as import("node:net").AddressInfo).port;probe.close(()=>resolve(p));});});
  stop=await startWebServer({port,host:"127.0.0.1",token:"test-token",useBox:false,onLog:()=>{}});
  const base="http://127.0.0.1:"+port,headers={"content-type":"application/json",authorization:"Bearer test-token"};
  const post=(path:string,body:unknown)=>fetch(base+path,{method:"POST",headers,body:JSON.stringify(body)});
  assert.equal((await post("/api/work-control/pause-members",{agents:[agent.id]})).status,200);
  const body={agent:agent.id,text:"Install the skill",messageId:"request-install"};
  assert.equal((await post("/api/prompt",body)).status,202);
  const saved=new TaskStore(join(home,"tasks.jsonl")).list();assert.equal(saved.length,1);
  assert.equal(saved[0]!.sourceMessageId,body.messageId);assert.equal(saved[0]!.workRoot?.state.id,body.messageId);
  const response=await fetch(base+"/api/tasks/list?agent="+agent.id+"&conversation=main&records=user",{headers});
  const page=await response.json() as {total:number;tasks:{work:{phase:string}}[]};
  assert.equal(page.total,1);assert.equal(page.tasks[0]!.work.phase,"queued");
  assert.equal((await post("/api/prompt",body)).status,202);
  assert.equal(new TaskStore(join(home,"tasks.jsonl")).list().length,1);
  const preview=await (await fetch(base+"/api/work-control/preview?taskId="+saved[0]!.id,{headers})).json() as {token:string;work:{id:string}};
  assert.equal(preview.work.id,body.messageId);
  assert.equal((await post("/api/work-control/cancel",{taskId:saved[0]!.id,token:preview.token})).status,200);
  assert.ok(new TaskStore(join(home,"tasks.jsonl")).get(saved[0]!.id)!.workRoot?.cancellation);
  rmSync(join(home,"tasks.jsonl"));mkdirSync(join(home,"tasks.jsonl"));
  assert.equal((await post("/api/prompt",{...body,messageId:"cannot-save",workRelation:"new"})).status,500);
 } finally {stop?.();if(previous===undefined)delete process.env.AGENTBOX_HOME;else process.env.AGENTBOX_HOME=previous;rmSync(home,{recursive:true,force:true});}
});
