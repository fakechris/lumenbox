import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { TASK_BOARD_JS } from "./task-board-ui.ts";

const tick = () => new Promise<void>(resolve=>setImmediate(resolve));
class Element {
  children: Element[] = []; parent?: Element; id=""; hidden=false; open=false; scrollTop=0; disabled=false;
  style={display:"flex"}; className=""; html=""; attrs=new Map<string,string>(); handlers=new Map<string,()=>void>();
  classList={toggle:()=>{}};
  set textContent(_value:string){this.children=[];} get textContent(){return "";}
  set innerHTML(value:string){this.html=value;} get innerHTML(){return this.html;}
  get firstElementChild(){return this.children[0]??null;}
  get nextElementSibling(){const list=this.parent?.children??[];return list[list.indexOf(this)+1]??null;}
  setAttribute(key:string,value:string){this.attrs.set(key,value);}
  contains(){return false;} before(){} querySelector(){return new Element();} querySelectorAll(){return [];}
  appendChild(child:Element){this.insertBefore(child,null);}
  insertBefore(child:Element,before:Element|null){child.remove();child.parent=this;const n=before?this.children.indexOf(before):-1;this.children.splice(n<0?this.children.length:n,0,child);}
  remove(){if(this.parent){this.parent.children=this.parent.children.filter(child=>child!==this);this.parent=undefined;}}
  addEventListener(key:string,handler:()=>void){this.handlers.set(key,handler.bind(this));}
}

test("task reading follows agent and conversation, fences late responses, and only reads other conversations on expansion",async()=>{
  const nodes=new Map<string,Element>();const node=(id:string)=>{if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id)!;};
  const reads:{query:URLSearchParams;resolve:(response:unknown)=>void}[]=[];
  const scope:any={current:"a",currentConversation:"main",openTask:"",MSG_LOCALE:"en",Map,Set,URLSearchParams,Promise,Date,
    $:node,window:{lastAttention:{mine:[]}},document:{activeElement:null,body:{classList:{toggle:()=>{}}},createElement:()=>new Element(),addEventListener:()=>{}},
    t:(key:string)=>key,esc:(s:unknown)=>String(s),nameOf:(id:string)=>id,renderAttention:()=>Promise.resolve(),setTimeout:()=>{},
    showTab:()=>{},fetch:(path:string,options?:{method?:string})=>{assert.equal(options?.method,undefined,"navigation cannot write to a task");return new Promise(resolve=>reads.push({query:new URL(path,"http://fixture").searchParams,resolve}));}};
  runInNewContext(TASK_BOARD_JS,scope);
  scope.showTab=()=>{node("tasksview").style.display="flex";runInNewContext("refreshTasks()",scope);};
  scope.window.taskBoardContextChanged();await tick();assert.equal(reads[0]!.query.get("agent"),"a");assert.equal(reads[0]!.query.get("conversation"),"main");
  runInNewContext('current="b";currentConversation="second";window.taskBoardContextChanged()',scope);await tick();
  const answer=(title:string)=>({ok:true,json:async()=>({tasks:[{id:title,title,assigneeId:title,status:"review",updatedAt:"2026-11-10"}],total:1,nextCursor:null})});
  reads[1]!.resolve(answer("B CURRENT"));await tick();reads[0]!.resolve(answer("STALE A"));await tick();
  assert.equal(runInNewContext('taskBoardState.ids.join(",")',scope),"B CURRENT");
  const markup=node("tasklist").children[0]!.innerHTML;assert.match(markup,/B CURRENT/);assert.doesNotMatch(markup,/<select|data-level|data-task=|STALE A/);
  assert.equal(reads.length,2,"collapsed other conversations make no list request");
  node("taskothers").open=true;node("taskothers").handlers.get("toggle")!();await tick();
  assert.equal(reads[2]!.query.get("other"),"1");assert.equal(reads[2]!.query.get("agent"),"b");assert.equal(reads[2]!.query.get("conversation"),"second");
  reads[2]!.resolve(answer("B OTHER"));await tick();assert.match(node("taskotherlist").children[0]!.innerHTML,/B OTHER/);
  scope.window.openTeamTasks();await tick();assert.equal(reads[3]!.query.get("agent"),null);assert.equal(reads[3]!.query.get("conversation"),null);
});
