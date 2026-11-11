import { test } from "node:test";
import assert from "node:assert/strict";
import { TaskStore } from "./tasks.ts";
import { taskAudience } from "./task-audience.ts";
test("user roots, host-linked pieces and unlinked agent history have separate audiences independent of title or status", () => {
 const store=new TaskStore(null), agents=new Set(["mia"]);
 const user=store.create({title:"Temporary probe is what the person requested",requester:"chris"})!;
 const legacyWeb=store.create({title:"Existing local user request",requester:"web"})!;
 assert.equal(taskAudience(legacyWeb,agents,new Set(["chris"])),"user");
 const internal=store.create({title:"Important user-looking task",requester:"mia"})!;
 assert.equal(taskAudience(user,agents),"user");assert.equal(taskAudience(internal,agents),"internal");
 const root=store.create({title:"Install",requester:"mia",origin:{kind:"user",workId:"admitted-user-message"}})!;
 const child=store.create({title:"Verify",requester:"mia",origin:{kind:"user",workId:"admitted-user-message",parentId:root.id}})!;
 assert.equal(taskAudience(root,agents),"user");assert.equal(taskAudience(child,agents),"subtask");
 assert.equal(store.get(child.id)!.origin!.parentId,root.id);
});
