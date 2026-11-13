import { taskAudience } from "../host/task-audience.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { lastReport, taskBoardRecord } from "./task-board-record.ts";
import { TaskStore } from "../host/tasks.ts";
import { TaskListPages, taskListRoute } from "./task-list-routes.ts";

test("1600-task board reads bounded pages across updates, scopes and authorization changes", async () => {
  const tasks = new TaskStore(null), pages = new TaskListPages();
  for (let n = 0; n < 1600; n++) tasks.create({ title: "Task " + n, requester: "p", assigneeId: "a", conversation: n % 2 ? "other" : "chat", ...(n===0?{workRoot:{state:{id:"root-0",owner:"a",conversation:"chat",generation:1,epoch:0,status:"waiting",messages:[],peers:[],awaiting:[]},requests:Array.from({length:1000},(_,i)=>({id:"request-"+i,hash:"h".repeat(64),relation:"continue",state:"started"}))}}:{}) });
  for (let id = 1; id <= 50; id++) for (let move = 0; move < 30; move++) tasks.update("t" + id, { note: "n".repeat(500) }, "a");
  let allowed = true;
  const server = createServer((req,res) => {
    const url = new URL(req.url!,"http://localhost");
    taskListRoute("GET " + url.pathname,url,res,{ pages,tasks:()=>tasks.list(),allowed:()=>allowed,detail:task=>task,summary:taskBoardRecord,
      send:(out,status,body)=>{out.writeHead(status,{"content-type":"application/json"});out.end(JSON.stringify(body));} });
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  const read = async (query:string) => { const response=await fetch(base+query); return {status:response.status,body:await response.json() as { tasks: {id:string}[]; task?:{id:string}; total:number; nextCursor:string|null }}; };
  try {
    const first = await read("/api/tasks/list?limit=50&priority=t1");
    assert.ok(JSON.stringify(first.body).length < 50000, "board previews exclude thirty-entry histories even for heavily updated tasks");
    const at = "2026-11-02T00:00:00.000Z";
    assert.equal(lastReport({ createdAt: "2026-11-01T00:00:00.000Z", history: [{ at: "2026-11-01T00:00:00.000Z", by: "p", note: "created" }, { at, by: "a", note: "Done: see report.md" }, { at, by: "aging", note: "nudge 1/2: idle" }] } as never)?.note, "Done: see report.md", "a preview carries what was said about the work, not the reminder filed after it");
    assert.equal(lastReport({ createdAt: at, history: [{ at, by: "p", note: "created" }] } as never), undefined, "the board's own line at creation is not a report");
    assert.equal(first.body.total,1600); assert.equal(first.body.tasks.length,50); assert.equal(first.body.tasks[0]!.id,"t1");
    const ids = first.body.tasks.map(task=>task.id);
    tasks.update("t1",{note:"A live update must not invalidate the retained list of ids"},"a");
    let cursor=first.body.nextCursor;
    while(cursor){const next=await read("/api/tasks/list?limit=100&priority=t1&cursor="+encodeURIComponent(cursor));assert.equal(next.status,200);assert.ok(next.body.tasks.length<=100);ids.push(...next.body.tasks.map(task=>task.id));cursor=next.body.nextCursor;}
    assert.equal(new Set(ids).size,1600);assert.equal(ids.length,1600);
    assert.equal((await read("/api/tasks/item?task=t1")).body.task!.id,"t1");
    assert.equal((await read("/api/tasks/list?agent=a&conversation=chat")).body.total,800);
    const unlinked=tasks.create({title:"Older unlinked task",requester:"p",assigneeId:"a"})!;
    assert.equal((await read("/api/tasks/list?agent=a&conversation=main")).body.total,0,"missing association is not main");
    const other = await read("/api/tasks/list?agent=a&conversation=chat&other=1");
    assert.equal(other.body.total,801);
    assert.ok(other.body.tasks.some(task=>task.id===unlinked.id),"unlinked work is discoverable among other records");
    assert.ok(other.body.tasks.every(task=>tasks.get(task.id)!.conversation!=="chat"),"other-conversation pages cannot include the active conversation");
    assert.equal((await read("/api/tasks/list?agent=a&conversation=chat&cursor="+encodeURIComponent(other.body.nextCursor!))).status,409,"opposite conversation scopes cannot reuse cursors");
    assert.equal((await read("/api/tasks/list?cursor="+encodeURIComponent(first.body.nextCursor!))).status,409,"query changes cannot reuse a cursor");
    const search = await read("/api/tasks/list?search=" + encodeURIComponent("Older unlinked")); assert.equal(search.body.total,1); assert.equal(search.body.tasks[0]!.id,unlinked.id);
    allowed=false;
    assert.equal((await read("/api/tasks/item?task=t1")).status,404);
    assert.equal((await read("/api/tasks/list?search=" + encodeURIComponent("Older unlinked"))).body.total,0,"search cannot disclose inaccessible work");
    assert.equal((await read("/api/tasks/list?ids="+ids.slice(0,50).join(","))).body.tasks.length,0);
    assert.equal((await read("/api/tasks/list?priority=t1&cursor="+encodeURIComponent(first.body.nextCursor!))).status,409);
  } finally {server.closeIdleConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test("audience filtering precedes pagination and never prevents authorized direct inspection", () => {
 const store=new TaskStore(null), pages=new TaskListPages();
 const human=store.create({title:"Human request",requester:"chris"})!;
 const probe=store.create({title:"Looks important",requester:"mia"})!;
 let status=0, body = {} as {total:number;tasks:{id:string}[];task:{id:string}};
 const read=(path:string)=>taskListRoute("GET "+path.split("?")[0],new URL("http://localhost"+path),{} as never,{pages,tasks:()=>store.list(),allowed:()=>true,detail:task=>task,audience:task=>taskAudience(task,new Set(["mia"])),send:(_r,s,b)=>{status=s;body=b as typeof body;}});
 read("/api/tasks/list?records=user&limit=1");assert.equal(status,200);assert.equal(body.total,1);assert.equal(body.tasks[0]!.id,human.id);
 read("/api/tasks/list?records=internal");assert.equal(body.total,1);assert.equal(body.tasks[0]!.id,probe.id);
 read("/api/tasks/item?task="+probe.id);assert.equal(body.task.id,probe.id,"internal history stays addressable");
});
