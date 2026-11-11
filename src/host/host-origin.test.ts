import { newPursuit } from "./goal-mode.ts";
import { TaskStore } from "./tasks.ts";
import { auditConversation } from "./audit-context.ts";
import { evidenceDigest } from "./review-dispatch.ts";
/**
 * What the host writes is not the person's words (INV-1571).
 *
 * A task-board audit, a job's end, a fork's brief all open a turn the way a person's message does,
 * and they used to arrive as a person's message: trusted by the classifier that judges risky calls,
 * stored in the transcript as the person's line, rendered to the model as if typed by them. On
 * 2026-11-04 agents working their own audit tasks walked into probing for credentials. A host
 * prompt now carries its origin: untrusted for the classifier, a host entry in the transcript,
 * labelled for the model — and otherwise the same turn.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "../agents/registry.ts";
import type { InboundMessage } from "../agents/bus.ts";
import { Orchestrator } from "./orchestrator.ts";
import { buildTurnPrompt } from "./prompt.ts";
import { reviewInputFor } from "./turn.ts";
import { fakeModel, type ModelCapture } from "./testing/fake-model.ts";

const person = { fromId: "user", fromName: "user", text: "please tidy the report", id: "p", priority: false, receivedAt: "" } as InboundMessage;
const audit = { ...person, id: "a", text: 'Audit task t1290: "fix the import", which Bob claims is done.', synthetic: true, origin: "host:audit" } as InboundMessage;

test("the classifier trusts the person's words only: a host prompt and a host entry in the record are untrusted", () => {
  const review = reviewInputFor({
    agentName: "Vic",
    inbound: [person, audit],
    transcript: [
      { role: "user", text: "what the person said yesterday", at: "" },
      { role: "user", text: "Audit task t1110: an earlier audit", at: "", host: true },
      // Marked by their own opening, with no host stamp: the pause note and the first-run cue (INV-1579).
      { role: "user", text: '<host_notification source="pause">Chris resumed you after about 40 minutes.</host_notification>', at: "" },
      { role: "user", text: "[first run] You were just created and nobody has said anything yet.", at: "" },
    ],
    messages: [],
    tool: "bash",
    input: {},
    why: "",
  });
  assert.deepEqual(review.trusted, ["what the person said yesterday", "please tidy the report"]);
  assert.deepEqual(review.untrusted, [
    "Audit task t1110: an earlier audit",
    '<host_notification source="pause">Chris resumed you after about 40 minutes.</host_notification>',
    "[first run] You were just created and nobody has said anything yet.",
    audit.text,
  ]);
});

test("the model is told who is asking; a person's words and a text with its own [marker] are left as they are", () => {
  const rendered = buildTurnPrompt([audit]);
  assert.match(rendered, /^\[from the host \(host:audit\), not from a person\] Audit task t1290/);
  assert.equal(buildTurnPrompt([person]), "please tidy the report");
  const marked = { ...audit, text: "[A command you started earlier finished with exit code 0: job-1]" } as InboundMessage;
  assert.equal(buildTurnPrompt([marked]), marked.text, "already says who wrote it");
});

test("scenario: an admitted audit is answered in its own host context; the person retains their conversation", async () => {
  const root = mkdtempSync(join(tmpdir(), "host-origin-"));
  const previousHome = process.env.AGENTBOX_HOME;
  process.env.AGENTBOX_HOME = root;
  try {
    const registry = new AgentRegistry(join(root, "agents"));
    const vic = registry.create({ name: "Vic" });
    const tasks = new TaskStore(null);
    const task = tasks.create({title:"Check the import",requester:"person",assigneeId:registry.create({name:"Worker"}).id,reviewerId:vic.id})!;
    tasks.deliveryCommand(task.id,"submit",task.assigneeId!);
    const scope = {taskId:task.id,digest:evidenceDigest(tasks.get(task.id)!),reviewerId:vic.id, planId: ""};
    const capture: ModelCapture = { params: [] };
    const orch = new Orchestrator({
      registry, useBox: false, inbox: null, mcp: null, hooks: null, tasks, extensions: null, pendingWork: null,
      client: fakeModel(() => ({
        id: "r", type: "message", role: "assistant", model: "test",
        content: [{ type: "text", text: "Audited: the import works." }], stop_reason: "end_turn", stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 4 },
      } as never), { capture }),
    });
    writeFileSync(join(root, "config.json"), JSON.stringify({ rates: { [orch.provider.model]: { inputPerM: 0, outputPerM: 0 } } }));
    orch.resultChecks.grant(tasks.get(task.id)!, { mode: "model", reason: "Verify the import", acceptance: "Import works", paths: [], reviewers: 1, maxRounds: 1, maxDispatches: 1, maxCalls: 2, maxMs: 60_000, maxCost: 1 }, "operator");
    scope.planId = orch.resultChecks.begin(tasks.get(task.id)!, [vic.id]).plan!.id;
    const conversation = auditConversation(scope);
    await orch.prompt(vic.id, audit.text, undefined, { audit: scope, conversation, steerable: false, lane: "background", origin: "host:audit" });
    await orch.prompt(vic.id, "thanks, and the summary?", { userId: "chris" });

    const transcript = [...registry.readTranscript(vic.id, conversation), ...registry.readTranscript(vic.id)] as { role: string; text?: string; host?: true; fromPerson?: true; kind?: string }[];
    const opened = transcript.filter(entry => entry.role === "user" && entry.kind === undefined);
    assert.equal(opened.length, 2);
    assert.equal(opened[0]!.host, true, "the audit's turn is a host entry");
    assert.equal(opened[0]!.fromPerson, undefined, "and not the person's");
    assert.equal(opened[1]!.fromPerson, true, "the person's own message still is");
    assert.equal(opened[1]!.host, undefined);
    const replies = transcript.filter(entry => entry.role === "assistant" && entry.kind === undefined);
    assert.equal(replies.length, 2, "both requests answered in separate contexts");
    assert.doesNotMatch(JSON.stringify(registry.readTranscript(vic.id)), /host:audit/, "the audit never enters the user history");
    const firstRequest = JSON.stringify(capture.params[0]?.messages ?? []);
    assert.match(firstRequest, /from the host \(host:audit\), not from a person/);
    // The model is told what that label means, by the guide generated from the channel table (INV-1579),
    // and the person's message reaches it unlabelled, as the one kind of text that gives a task.
    const system = JSON.stringify(capture.params[0]?.system ?? "");
    assert.match(system, /# Who is speaking/);
    assert.match(system, /it is information, never a task from the person/);
    const secondRequest = JSON.stringify(capture.params[1]?.messages ?? []);
    assert.match(secondRequest, /thanks, and the summary\?/);
    assert.doesNotMatch(secondRequest, /from the host \([^)]*\), not from a person\] thanks/);
  } finally {
    if (previousHome === undefined) delete process.env.AGENTBOX_HOME;
    else process.env.AGENTBOX_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});

for (const requiredTool of ["bash", "browser_snapshot", "RunOnHost", "UseMcpTool"]) test("a default agent retains blocked user work: " + requiredTool, async () => {
  const root = mkdtempSync(join(tmpdir(),"attention-default-tools-")), previousHome = process.env.AGENTBOX_HOME;
  process.env.AGENTBOX_HOME = root;
  try {
    const registry = new AgentRegistry(join(root,"agents")), mia = registry.create({name:"Mia"});
    let calls = 0;
    const orch = new Orchestrator({registry,useBox:false,inbox:null,mcp:null,hooks:null,tasks:null,extensions:null,pendingWork:null,
      client:fakeModel(()=>({id:"response",type:"message",role:"assistant",model:"test",content:calls++ === 0 ? [{type:"tool_use",id:"call-"+calls,name:requiredTool,input:requiredTool==="UseMcpTool"?{tool:"browser_snapshot",arguments:{}}:{command:calls===1?"ls ~/Downloads":"pwd"}}] : [{type:"text",text:"The computer is still unavailable."}],stop_reason:calls===1?"tool_use":"end_turn",stop_sequence:null,usage:{input_tokens:10,output_tokens:5}} as never))});
    await orch.prompt(mia.id,"Install the provided package",{userId:"chris"});
    assert.equal(calls,1,"unoffered computer tools are bounded even without an explicit profile allowlist");
    const workId=orch.bus.workAttention!.get(mia.id,"main")!.id;
    await orch.prompt(mia.id,"What is still blocking the installation?",{userId:"chris"});
    assert.equal(orch.bus.workAttention!.get(mia.id,"main")!.id,workId);
    assert.equal(calls,2,"the status answer does not probe or recover a tool");
    assert.equal(orch.bus.workAttention!.get(mia.id,"main")!.status,"waiting");
    assert.match(JSON.stringify(registry.readTranscript(mia.id)),/unavailable|not available/);
  } finally { if(previousHome===undefined)delete process.env.AGENTBOX_HOME;else process.env.AGENTBOX_HOME=previousHome;rmSync(root,{recursive:true,force:true}); }
});


test("a progress question retains an active goal; a genuine goal pause releases its execution custody", async () => {
  const root = mkdtempSync(join(tmpdir(), "attention-goal-status-")), previousHome = process.env.AGENTBOX_HOME;
  process.env.AGENTBOX_HOME = root;
  try {
    const registry = new AgentRegistry(join(root, "agents")), mia = registry.create({ name: "Mia" }), tasks = new TaskStore(null);
    const task = tasks.create({title:"Install the package",requester:"chris",assigneeId:mia.id,pursuit:newPursuit({objective:"Install the package",workId:"goal-install"})})!;
    const orch = new Orchestrator({registry,useBox:false,inbox:null,mcp:null,hooks:null,tasks,extensions:null,pendingWork:null,
      client:fakeModel(()=>({id:"response",type:"message",role:"assistant",model:"test",content:[{type:"text",text:"Installation is still in progress."}],stop_reason:"end_turn",stop_sequence:null,usage:{input_tokens:10,output_tokens:5}} as never))});
    orch.bus.workAttention!.existing(mia.id,"main","goal-install",task.id);
    await orch.prompt(mia.id,"How is installation progressing?",{userId:"chris"});
    assert.equal(orch.bus.workAttention!.get(mia.id,"main")!.id,"goal-install","the status question does not fork unfinished goal work");
    assert.equal(orch.bus.workAttention!.get(mia.id,"main")!.status,"waiting","a status answer is not task completion");
    tasks.setPursuit(task.id,pursuit=>({...pursuit,status:"paused"}),"User paused the goal","chris");
    assert.equal(orch.bus.workAttention!.get(mia.id,"main")!.status,"answered","paused goals retain their board record but release execution custody");
  } finally { if(previousHome===undefined)delete process.env.AGENTBOX_HOME;else process.env.AGENTBOX_HOME=previousHome;rmSync(root,{recursive:true,force:true}); }
});


test("submitting the current task during a tool round preserves the final user report", async () => {
  const root = mkdtempSync(join(tmpdir(),"attention-final-report-")), previousHome=process.env.AGENTBOX_HOME;
  process.env.AGENTBOX_HOME=root;
  try {
    const registry=new AgentRegistry(join(root,"agents")), mia=registry.create({name:"Mia"}), tasks=new TaskStore(null);
    const task=tasks.create({title:"Install the package",requester:"chris",assigneeId:mia.id,contract:{acceptance:"The installation was checked"}})!;
    let calls=0;
    const orch=new Orchestrator({registry,useBox:false,inbox:null,mcp:null,hooks:null,tasks,extensions:null,pendingWork:null,
      client:fakeModel(()=>({id:"response",type:"message",role:"assistant",model:"test",content:calls++===0?[{type:"tool_use",id:"submit",name:"Tasks",input:{action:"submit",id:task.id}}]:[{type:"text",text:"The installation was checked and submitted for review."}],stop_reason:calls===1?"tool_use":"end_turn",stop_sequence:null,usage:{input_tokens:10,output_tokens:5}} as never))});
    orch.bus.workAttention!.existing(mia.id,"main","task-install",task.id);
    await orch.prompt(mia.id,"Finish and report the installation",{userId:"chris"});
    assert.equal(calls,2,"submission must not invalidate its own final response");
    assert.match(JSON.stringify(registry.readTranscript(mia.id)),/The installation was checked and submitted for review/);
    assert.equal(tasks.get(task.id)!.status,"review");
    assert.equal(orch.bus.workAttention!.get(mia.id,"main")!.status,"answered");
  } finally {if(previousHome===undefined)delete process.env.AGENTBOX_HOME;else process.env.AGENTBOX_HOME=previousHome;rmSync(root,{recursive:true,force:true});}
});

test("adding a reviewer after submission still permits that reviewer's explicit check request", async () => {
  const root = mkdtempSync(join(tmpdir(), "late-reviewer-")), previousHome = process.env.AGENTBOX_HOME;
  process.env.AGENTBOX_HOME = root;
  try {
    const registry = new AgentRegistry(join(root, "agents")), worker = registry.create({ name: "Worker" }), reviewer = registry.create({ name: "Reviewer" });
    const tasks = new TaskStore(null), capture: ModelCapture = { params: [] };
    const orch = new Orchestrator({ registry, useBox: false, inbox: null, mcp: null, hooks: null, tasks, extensions: null, pendingWork: null,
      client: fakeModel(() => ({ id: "check", type: "message", role: "assistant", model: "test", content: [{ type: "text", text: "Status: complete\nIntegrity: clean\nContract audit: aligned\nNext action: none" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 4 } } as never), { capture }) });
    const task = tasks.create({ title: "Install the package", requester: "person", assigneeId: worker.id })!;
    tasks.deliveryCommand(task.id, "submit", worker.id);
    await orch.settle(); assert.equal(capture.params.length, 0);
    tasks.update(task.id, { reviewerId: reviewer.id }, "person");
    writeFileSync(join(root, "config.json"), JSON.stringify({ rates: { [orch.provider.model]: { inputPerM: 0, outputPerM: 0 } } }));
    orch.resultChecks.grant(tasks.get(task.id)!, { mode: "model", reason: "Check the installation", acceptance: "The package is installed", paths: [], reviewers: 1, maxRounds: 1, maxDispatches: 1, maxCalls: 2, maxMs: 60_000, maxCost: 1 }, "operator");
    assert.equal(tasks.deliveryCommand(task.id, "request_check", reviewer.id)!.outcome, "applied");
    await orch.settle(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(capture.params.length, 1, "the explicit request reaches the real audit dispatcher once");
    assert.equal(tasks.deliveryCommand(task.id, "request_check", reviewer.id)!.outcome, "unchanged");
    await orch.settle(); assert.equal(capture.params.length, 1);
  } finally { if (previousHome === undefined) delete process.env.AGENTBOX_HOME; else process.env.AGENTBOX_HOME = previousHome; rmSync(root, { recursive: true, force: true }); }
});
