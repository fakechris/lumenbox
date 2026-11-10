/** Operator cancellation: persist revocation first, then request and verify resource cleanup. */
import { createHash } from "node:crypto";
import type { CancelledWork, StopResource, WorkStamp } from "../agents/work-attention.ts";
import type { Orchestrator } from "./orchestrator.ts";
import type { QuestionWatch } from "./question-expiry.ts";
import type { AgentPauses } from "./agent-pause.ts";

export interface WorkTarget { agentId: string; conversation: string; taskId?: string }
export interface WorkPreview {
  target: WorkTarget; work?: WorkStamp; title: string; legacy: boolean; token?: string;
  participants: { id: string; name: string }[]; resources: StopResource[]; cancelled?: CancelledWork;
  unknown: string[];
}
export interface WorkControlDeps {
  host: Pick<Orchestrator, "registry" | "bus" | "tasks" | "pendingWork" | "policy" | "jobWatch" | "acpDelegates" | "mcpFace" | "modelRelay" | "boxFor" | "receipts">;
  questions: QuestionWatch; pauses: AgentPauses; runner?: import("./host-runner.ts").HostRunner;
  native: { list(workId: string): StopResource[]; cancel(workId: string): void };
}
const key = (row: StopResource) => `${row.kind}:${row.id}`;
const byKey = (a: StopResource, b: StopResource) => key(a).localeCompare(key(b));
async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Stop confirmation timed out; external state is unknown")), 3000); })]); }
  finally { if (timer) clearTimeout(timer); }
}

export class WorkControl {
  constructor(private readonly deps: WorkControlDeps) {}
  preview(target: WorkTarget): WorkPreview {
    const {host} = this.deps;
    if (!host.registry.has(target.agentId) && !target.taskId) throw new Error("Unknown agent");
    const task = target.taskId ? host.tasks?.get(target.taskId) : undefined;
    const work = host.bus.workAttention?.get(target.agentId, target.conversation);
    const trusted = work && (!target.taskId || work.taskId === target.taskId) && work.status !== "answered" ? work : undefined;
    const legacy: WorkPreview = { target, title: task?.title ?? (host.registry.tryGet(target.agentId)?.profile.name ?? "Task"), legacy:true, participants:host.registry.has(target.agentId)?[{id:target.agentId,name:host.registry.get(target.agentId).profile.name}]:[], resources:[], unknown:["No reliable current work association. Select the members to pause; historical descendants cannot be inferred safely."] };
    if (!trusted) return legacy;
    const cancelled = host.bus.workAttention?.cancelled(trusted.id);
    const ids = cancelled?.participants ?? [trusted.owner,...trusted.peers];
    const resources: StopResource[] = cancelled?.resources ?? [];
    if (!cancelled) {
      for (const id of this.deps.runner?.activeWork(trusted.id) ?? []) resources.push({kind:"host-command",id,agentId:trusted.owner});
      for (const run of host.bus.workExecutions(trusted.id)) resources.push({kind:"turn",id:JSON.stringify([run.agentId,run.conversation]),agentId:run.agentId});
      for (const row of host.bus.workQueue(trusted.id)) resources.push({kind:"message",id:row.id,agentId:row.agentId});
      for (const job of host.jobWatch.workJobs(trusted.id)) resources.push({kind:"job",id:job.jobId,agentId:job.agentId});
      for (const row of host.pendingWork?.open().filter(item=>item.workId===trusted.id) ?? []) {
        resources.push({kind:row.kind,id:row.id,agentId:row.agentId});
        if(Array.isArray(row.data?.cards)) for(const id of row.data.cards) if(typeof id==="string" && host.tasks?.get(id))resources.push({kind:"task",id,agentId:row.agentId});
        if (typeof row.data?.approvalId==="string") resources.push({kind:"approval",id:row.data.approvalId,agentId:row.agentId});
      }
      for (const route of host.modelRelay.active().filter(item=>item.workId===trusted.id)) resources.push({kind:"model-route",id:route.key,agentId:route.agentId});
      for (const route of host.mcpFace.active().filter(item=>item.workId===trusted.id)) resources.push({kind:"route",id:route.key,agentId:route.agentId});
      for (const item of host.policy.pending().filter(item=>item.returnTo?.work.id===trusted.id)) resources.push({kind:"approval",id:item.id,agentId:item.agentId});
      for (const item of this.deps.questions.list().filter(item=>item.work?.id===trusted.id)) resources.push({kind:"question",id:item.id,agentId:item.agentId});
      resources.push(...this.deps.native.list(trusted.id));
      for(const task of host.tasks?.list().filter(item=>item.progress?.active?.workId===trusted.id || item.pursuit?.workId===trusted.id) ?? [])resources.push({kind:"task",id:task.id,agentId:task.assigneeId});
      if (trusted.taskId) resources.push({kind:"task",id:trusted.taskId,agentId:trusted.owner});
    }
    const rows=[...new Map(resources.map(row=>[key(row),row])).values()].sort(byKey);
    const token=createHash("sha256").update(JSON.stringify([trusted.id,trusted.generation,trusted.epoch,ids,rows])).digest("hex");
    return {target,work:trusted,title:host.tasks?.get(trusted.taskId ?? "")?.title ?? legacy.title,legacy:false,token,participants:ids.map(id=>({id,name:host.registry.tryGet(id)?.profile.name ?? id})),resources:rows,...(cancelled?{cancelled}:{}),unknown:["External actions already sent may have happened; cancellation does not roll them back.",...(rows.some(row=>row.kind==="ext-job")?["An extension job has no generic stop protocol; its external state needs verification."]:[])]};
  }
  async cancel(target: WorkTarget, expected: string, by: string, reason: string): Promise<CancelledWork> {
    const preview=this.preview(target), attention=this.deps.host.bus.workAttention;
    if (preview.cancelled) return this.finish(preview.cancelled);
    if (!preview.work || !attention) throw new Error("No reliable work association; use member pause");
    if (!expected || preview.token!==expected) throw new Error("Work changed; refresh the cancellation preview");
    const ended=attention.cancel(preview.work,by,reason,preview.resources);
    this.deps.host.receipts.write({at:ended.at,by,subject:`work:${ended.id}`,decision:"cancelled",because:reason});
    return this.finish(ended);
  }
  async recover(): Promise<void> {
    for (const row of this.deps.host.bus.workAttention?.cancellations() ?? []) if (row.resources.some(item=>item.state!=="confirmed")) await this.finish(row);
  }
  private async finish(ended: CancelledWork): Promise<CancelledWork> {
    const {host}=this.deps, attention=host.bus.workAttention!;
    // Revocation is already on disk. Nothing below grants execution authority again.
    host.bus.interruptWork(ended.id); this.deps.native.cancel(ended.id); this.deps.questions.cancelWork(ended.id);
    const resources=await Promise.all(ended.resources.map(async row=>{
      if (row.state==="confirmed") return row;
      try { return await bounded(this.stopResource(ended,row)); }
      catch (error) { return {...row,state:"unconfirmed" as const,detail:error instanceof Error?error.message:String(error)}; }
    }));
    attention.cleanup(ended.id,resources);
    return attention.cancelled(ended.id)!;
  }
  private async stopResource(ended: CancelledWork, row: StopResource): Promise<StopResource> {
    const {host}=this.deps, confirmed={...row,state:"confirmed" as const};
    if (row.kind==="turn") {
      for(let i=0;i<20 && host.bus.workExecutions(ended.id).length;i++) await new Promise(resolve=>setTimeout(resolve,20));
      return {...row,state:host.bus.workExecutions(ended.id).some(run=>JSON.stringify([run.agentId,run.conversation])===row.id)?"unconfirmed":"confirmed",detail:"Only execution termination is tracked; prior side effects may need verification"};
    }
    if (row.kind==="message" || row.kind==="question" || row.kind==="secret" || row.kind==="desktop") return confirmed;
    if (row.kind==="model-route") {host.modelRelay.revoke(row.id,"work cancelled");return {...confirmed,detail:"Model access revoked; an already dispatched upstream request may still have incurred cost"};}
    if (row.kind==="route") { host.mcpFace.revoke(row.id,"work cancelled"); return confirmed; }
    if (row.kind==="approval") { host.policy.deny(row.id,ended.by,"User work cancelled"); return confirmed; }
    if (row.kind==="task") {
      const task=host.tasks?.get(row.id);
      if(task && (task.progress?.active?.workId && task.progress.active.workId!==ended.id || task.pursuit?.workId && task.pursuit.workId!==ended.id))return {...row,state:"unconfirmed",detail:"Task now belongs to another work; it was not modified"};
      if (task?.pursuit) host.tasks?.setPursuit(task.id,p=>({...p,status:"cleared",pausedReason:"person"}),`User work cancelled by ${ended.by}`);
      else if (task && task.status!=="done" && task.status!=="dropped") host.tasks?.update(task.id,{status:"dropped",note:`User work cancelled by ${ended.by}: ${ended.reason}`},task.requester);
      return confirmed;
    }
    if (row.kind==="host-command") { const stopped=await this.deps.runner?.stopWorkRun(row.id,ended.id); return {...row,state:stopped?"confirmed":"unconfirmed",detail:stopped?"Host command exit observed":"Host process state is no longer tracked; verify externally"}; }
    if (row.kind==="job") return host.jobWatch.stopWorkJob(row.id,ended.id);
    const pending=host.pendingWork?.open().find(item=>item.id===row.id && item.workId===ended.id);
    if (!pending) return {...row,state:"unconfirmed",detail:"The execution record is no longer open; verify any external effect"};
    if (pending.kind==="delegate" || pending.kind==="command") {
      if (pending.data?.mode==="session" || pending.data?.mode==="opening-session") {
        const watch=host.acpDelegates.get(pending.child);
        if (watch) await host.acpDelegates.cancel(pending.child);
        else {const box=host.boxFor(pending.agentId);if(!box)throw new Error("Computer unavailable");await box.acpClose({session_id:pending.child});const running=(await box.acpSessions()).sessions.some(session=>session.session_id===pending.child && session.running);if(!running){host.pendingWork?.dropped(pending.id,"cancelled");return confirmed;}}
        return {...row,state:"requested",detail:"Engine cancellation requested; process exit is not confirmed"};
      }
      const box=host.boxFor(pending.agentId); if (!box) throw new Error("Computer unavailable");
      await box.killJob(pending.child);
      const status=await box.waitForJob({job_id:pending.child,timeout_ms:100});
      if (status.running) return {...row,state:"requested",detail:"Stop requested; process exit is not confirmed"};
    }
    host.pendingWork?.dropped(pending.id,"cancelled");
    if (pending.kind==="ext-job") return {...row,state:"unconfirmed",detail:"Follow-up is revoked; the extension has no generic stop protocol"};
    return confirmed;
  }
}
