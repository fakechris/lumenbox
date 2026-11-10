import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { TASK_FOCUS_JS } from "./task-focus-ui.ts";
import { APP_PAGE } from "./page-locale.ts";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() { let resolve!: (body: unknown) => void; const promise = new Promise<unknown>(done => { resolve = done; }); return { promise, resolve }; }
class Element {
  classList = { add: () => {}, remove: () => {}, toggle: () => {} };
  id = ""; hidden = false; isConnected = true; disabled = false; tabIndex = 0; scrollTop = 0;
  attrs = new Map<string,string>(); handlers = new Map<string,(event: unknown)=>void>();
  private html = ""; private text = "";
  get innerHTML() { return this.html; } set innerHTML(value: string) { this.html = value; this.text = ""; }
  get textContent() { return this.text; } set textContent(value: string) { this.text = value; this.html = ""; }
  setAttribute(key:string,value:string) { this.attrs.set(key,value); }
  getAttribute(key:string) { return this.attrs.get(key) ?? null; }
  hasAttribute(key:string) { return this.attrs.has(key); }
  addEventListener(key:string,handler:(event:unknown)=>void) { this.handlers.set(key,handler); }
  querySelector() { return new Element(); } querySelectorAll() { return []; }
  closest() { return this; } focus() {} appendChild() {} remove() {}
  getBoundingClientRect() { return { top:0,bottom:100 }; }
}

/** Execute the actual workspace with controlled network completion order; no product state is mocked inside it. */
function workspace(me: {role:string;identity?:string|null} = {role:"admin",identity:null}) {
  const nodes = new Map<string,Element>(), storage = new Map<string,string>();
  const mutations: {body:Record<string,unknown>;read:ReturnType<typeof deferred>}[] = [];
  const itemReads: ReturnType<typeof deferred>[] = [], costReads: ReturnType<typeof deferred>[] = [], exportReads: ReturnType<typeof deferred>[] = [];
  let root: Element;
  const document = {
    activeElement: null, visibilityState:"visible", documentElement:{dataset:{connection:"connected"}},
    createElement:()=>new Element(), body:{appendChild:(node:Element)=>{root=node;nodes.set(node.id,node);}},
    getElementById:(id:string)=>{if(!nodes.has(id)){const node=new Element();node.id=id;nodes.set(id,node);}return nodes.get(id)!;},
  };
  const location = { href:"http://fixture/?task=t1&tasktab=artifacts" };
  const window = { addEventListener:()=>{}, deliverablesHtml:(task:{deliverables?:{name:string}[]})=>task.deliverables?.[0]?.name ?? "" } as Record<string,any>;
  const scope = { window,document,location,URL,URLSearchParams,AbortController,Map,Set,Promise,Date,
    setInterval:()=>0, setTimeout:()=>0, clearTimeout:()=>{}, requestAnimationFrame:(fn:()=>void)=>fn(),
    sessionStorage:{getItem:(key:string)=>storage.get(key)??null,setItem:(key:string,value:string)=>storage.set(key,value)},
    history:{replaceState:(_:unknown,_title:string,url:URL)=>{location.href=String(url);},pushState:(_:unknown,_title:string,url:URL)=>{location.href=String(url);}},
    openTask:"t1",current:"a",currentConversation:"main",t:(key:string)=>key,esc:(text:unknown)=>String(text),nameOf:(id:string)=>id,
    renderMarkdown:(text:string)=>"<p>"+text+"</p>",attentionRow:()=>"",refreshTasks:()=>Promise.resolve(),refresh:()=>Promise.resolve(),toolDetail:()=>"",feed:()=>{},showTab:()=>{},select:()=>Promise.resolve(),
    fetch:(path:string,options?:{body?:string})=>{
      if(path==="/api/tasks/update"){const read=deferred();mutations.push({body:JSON.parse(options?.body??"{}"),read});return read.promise;}
      if(path==="/api/me")return Promise.resolve({ok:true,json:async()=>me});
      if(path.startsWith("/api/tasks/item")){const read=deferred();itemReads.push(read);return read.promise;}
      if(path.startsWith("/api/tasks/export?")){const read=deferred();exportReads.push(read);return read.promise;}
      if(path.startsWith("/api/tasks/execution/costs")){const read=deferred();costReads.push(read);return read.promise;}
      return Promise.resolve({ok:true,json:async()=>({snapshot:"snapshot",steps:[],from:0,to:0,total:0,activity:{groups:[]}})});
    },
  };
  runInNewContext(TASK_FOCUS_JS,scope);
  const reply=(body:unknown,status=200)=>({ok:status===200,status,json:async()=>body});
  return {window,location,mutations,itemReads,costReads,exportReads,nodes,reply,
    accept:()=>{const button=new Element();button.setAttribute("data-tf-accept","");root!.handlers.get("click")!({target:button});},
    export:()=>{const button=new Element();button.setAttribute("data-tf-export","");root!.handlers.get("click")!({target:button});},
    close:()=>{const button=new Element();button.setAttribute("data-tf-close","");root!.handlers.get("click")!({target:button});}};
}

test("reopening requires current task and cost authorization before cached or late data can appear",async()=>{
  const ui=workspace();
  const task={id:"t1",title:"Task",status:"review",stage:"person/review",history:[],deliverables:[{name:"PRIVATE ARTIFACT"}]};
  ui.window.openTaskFocus("t1",false);await tick();
  ui.itemReads[0]!.resolve(ui.reply({task}));await tick();
  assert.match(ui.nodes.get("tf-body")!.innerHTML,/PRIVATE ARTIFACT/);
  ui.close();ui.window.openTaskFocus("t1",false);await tick();
  assert.doesNotMatch(ui.nodes.get("tf-body")!.innerHTML,/PRIVATE ARTIFACT/,"me can return before the new item permission check");
  ui.itemReads[1]!.resolve(ui.reply({error:"denied"},404));await tick();
  assert.doesNotMatch(ui.nodes.get("tf-body")!.innerHTML,/PRIVATE ARTIFACT/);

  ui.location.href="http://fixture/?task=t1&tasktab=costs";
  ui.window.openTaskFocus("t1",false);await tick();ui.itemReads[2]!.resolve(ui.reply({task}));await tick();
  const cost={report:{records:1,money:12.5,totals:{inputTokens:100,outputTokens:10},compacted:false},coverage:"retained"};
  ui.costReads[0]!.resolve(ui.reply(cost));await tick();
  assert.match(ui.nodes.get("tf-body")!.innerHTML,/12\.5000/);
  ui.window.refreshTaskExecution();await tick();ui.itemReads[3]!.resolve(ui.reply({task}));await tick(); // leaves an older cost read pending
  ui.close();ui.window.openTaskFocus("t1",false);await tick();
  assert.doesNotMatch(ui.nodes.get("tf-body")!.innerHTML,/12\.5000/);
  ui.itemReads[4]!.resolve(ui.reply({task}));await tick();
  ui.costReads[2]!.resolve(ui.reply({error:"denied"},403));await tick();
  ui.costReads[1]!.resolve(ui.reply({...cost,report:{...cost.report,money:99.99}}));await tick();
  assert.doesNotMatch(ui.nodes.get("tf-body")!.innerHTML,/99\.9900|12\.5000/,"an older allowed response cannot undo a current denial");
});

test("a Task focus neither starts nor completes a queued conversation viewed marker",async()=>{
  const html=APP_PAGE("en"), start=html.indexOf("var viewedTimer = null;"), end=html.indexOf("function inView(",start);
  const timers:(()=>void)[]=[], requests:unknown[]=[];
  const scope={window:{taskFocusVisible:false,addEventListener:()=>{}},document:{hasFocus:()=>true},current:"a",currentConversation:"main",
    setTimeout:(fn:()=>void)=>{timers.push(fn);return timers.length;},clearTimeout:()=>{},refresh:()=>{},
    fetch:(path:string,body:unknown)=>{requests.push({path,body});return Promise.resolve({});}};
  runInNewContext(html.slice(start,end),scope);
  runInNewContext('markViewed("a","main")',scope);assert.equal(timers.length,1);
  scope.window.taskFocusVisible=true;timers.shift()!();await tick();assert.equal(requests.length,0);
  runInNewContext('markViewed("a","main")',scope);assert.equal(timers.length,0);
  scope.window.taskFocusVisible=false;runInNewContext('markViewed("a","main")',scope);timers.shift()!();await tick();assert.equal(requests.length,1);
});


test("task export completion cannot repaint a switched task or restore a denied artifact link", async () => {
  const ui=workspace(), task={id:"t1",title:"Task A",status:"review",history:[]};
  ui.window.openTaskFocus("t1",false); await tick(); ui.itemReads[0]!.resolve(ui.reply({task})); await tick();
  ui.export(); await tick(); assert.equal(ui.exportReads.length,1);
  ui.export(); assert.equal(ui.exportReads.length,1,"one in-flight export per view");
  ui.window.openTaskFocus("t2",false); await tick(); ui.itemReads[1]!.resolve(ui.reply({task:{...task,id:"t2",title:"Task B"}})); await tick();
  ui.exportReads[0]!.resolve(ui.reply({id:"STALE-EXPORT-ID",expiresAt:new Date().toISOString(),files:[{name:"steps.jsonl",size:123}]})); await tick(); await tick();
  assert.doesNotMatch(ui.nodes.get("tf-export")!.innerHTML,/STALE-EXPORT-ID/);
  ui.export(); await tick();
  ui.window.refreshTaskExecution(); await tick(); ui.itemReads[2]!.resolve(ui.reply({error:"denied"},404)); await tick();
  ui.exportReads[1]!.resolve(ui.reply({id:"DENIED-EXPORT-ID",expiresAt:new Date().toISOString(),files:[{name:"steps.jsonl",size:123}]})); await tick(); await tick();
  assert.doesNotMatch(ui.nodes.get("tf-body")!.innerHTML,/DENIED-EXPORT-ID/);
});


test("review is an explicit authorized action and denied or coerced results never look accepted",async()=>{
  const task={id:"t1",title:"Review result",status:"review",requester:"owner",reviewerId:"reviewer",history:[]};
  const stranger=workspace({role:"driver",identity:"stranger"});stranger.window.openTaskFocus("t1",false);await tick();stranger.itemReads[0]!.resolve(stranger.reply({task}));await tick();
  assert.doesNotMatch(stranger.nodes.get("tf-body")!.innerHTML,/data-tf-accept/);
  const unidentified=workspace({role:"admin"});unidentified.window.openTaskFocus("t1",false);await tick();unidentified.itemReads[0]!.resolve(unidentified.reply({task}));await tick();
  assert.doesNotMatch(unidentified.nodes.get("tf-body")!.innerHTML,/data-tf-accept/);
  const viewer=workspace({role:"viewer",identity:"owner"});viewer.window.openTaskFocus("t1",false);await tick();viewer.itemReads[0]!.resolve(viewer.reply({task}));await tick();
  assert.doesNotMatch(viewer.nodes.get("tf-body")!.innerHTML,/data-tf-accept|data-tf-status|data-tf-level/);
  const owner=workspace({role:"driver",identity:"owner"});owner.window.openTaskFocus("t1",false);await tick();owner.itemReads[0]!.resolve(owner.reply({task}));await tick();
  assert.match(owner.nodes.get("tf-body")!.innerHTML,/data-tf-accept/);assert.equal(owner.mutations.length,0);
  owner.accept();assert.equal(owner.mutations[0]!.body.status,"done");owner.mutations[0]!.read.resolve(owner.reply({error:"Review permission changed"},403));await tick();await tick();
  assert.match(owner.nodes.get("tf-needs")!.innerHTML,/Review permission changed/);
  owner.accept();owner.mutations[1]!.read.resolve(owner.reply({task,note:"Still awaiting independent review"}));await tick();await tick();
  assert.match(owner.nodes.get("tf-needs")!.innerHTML,/Still awaiting independent review/);assert.match(owner.nodes.get("tf-body")!.innerHTML,/data-tf-accept/);
});
