import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { taskBoardRecord } from "./task-board-record.ts";
import { TaskStore } from "../host/tasks.ts";
import { TaskListPages, taskListRoute } from "./task-list-routes.ts";

test("1600-task board reads bounded pages across updates, scopes and authorization changes", async () => {
  const tasks = new TaskStore(null), pages = new TaskListPages();
  for (let n = 0; n < 1600; n++) tasks.create({ title: "Task " + n, requester: "p", assigneeId: "a", conversation: n % 2 ? "other" : "chat" });
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
    assert.equal(first.body.total,1600); assert.equal(first.body.tasks.length,50); assert.equal(first.body.tasks[0]!.id,"t1");
    const ids = first.body.tasks.map(task=>task.id);
    tasks.update("t1",{note:"A live update must not invalidate the retained list of ids"},"a");
    let cursor=first.body.nextCursor;
    while(cursor){const next=await read("/api/tasks/list?limit=100&priority=t1&cursor="+encodeURIComponent(cursor));assert.equal(next.status,200);assert.ok(next.body.tasks.length<=100);ids.push(...next.body.tasks.map(task=>task.id));cursor=next.body.nextCursor;}
    assert.equal(new Set(ids).size,1600);assert.equal(ids.length,1600);
    assert.equal((await read("/api/tasks/item?task=t1")).body.task!.id,"t1");
    assert.equal((await read("/api/tasks/list?agent=a&conversation=chat")).body.total,800);
    assert.equal((await read("/api/tasks/list?cursor="+encodeURIComponent(first.body.nextCursor!))).status,409,"query changes cannot reuse a cursor");
    allowed=false;
    assert.equal((await read("/api/tasks/item?task=t1")).status,404);
    assert.equal((await read("/api/tasks/list?ids="+ids.slice(0,50).join(","))).body.tasks.length,0);
    assert.equal((await read("/api/tasks/list?priority=t1&cursor="+encodeURIComponent(first.body.nextCursor!))).status,409);
  } finally {server.closeIdleConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
