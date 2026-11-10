/** Re-check authority at the actual box call, including calls after asynchronous preparation. */
import type {BoxClient} from "../box/client.ts";
import type {AgentBus} from "../agents/bus.ts";
import type {WorkStamp,StopResource} from "../agents/work-attention.ts";
import type {PendingWork} from "./pending-work.ts";

export function workBox(box: BoxClient | undefined, work: WorkStamp | undefined, agentId: string, conversation: string, bus: AgentBus, pending?: PendingWork): BoxClient | undefined {
  if (!box || !work) return box;
  const record = (id: string): string | undefined => {
    const old=pending?.open().find(row=>row.workId===work.id && row.child===id);
    return old?.id ?? pending?.prepare({kind:"command",agentId,workId:work.id,parent:conversation,child:id,brief:"Background command owned by this work"});
  };
  return new Proxy(box,{get(target,name){
    const value=Reflect.get(target,name,target);
    if(typeof value!=="function")return value;
    return async(...args:unknown[])=>{
      if(!bus.workAttention?.valid(work,agentId))throw new Error("Work cancelled or superseded before execution");
      let recorded: string|undefined;
      if(name==="startJob") {const id=(args[1] as {jobId?:string}|undefined)?.jobId;if(id)recorded=record(id);}
      let result: unknown;
      try {result=await value.apply(target,args);}
      catch(error){if(recorded)pending?.dropped(recorded,"unrecorded");throw error;}
      if(name!=="startJob" && name!=="exec")return result;
      const shape=result as {job_id?:unknown;still_running?:{job_id?:unknown}} | undefined;
      const jobId=name==="startJob"?shape?.job_id:shape?.still_running?.job_id;
      if(typeof jobId!=="string")return result;
      recorded=record(jobId);
      const cancelled=bus.workAttention?.cancelled(work.id);
      if(cancelled){
        const resource:StopResource={kind:recorded?"command":"job",id:recorded??jobId,agentId,state:"unconfirmed",detail:"Command returned after cancellation; stop not yet confirmed"};
        bus.workAttention!.cleanup(work.id,[resource]);
        try {
          await target.killJob(jobId);
          const status=await target.waitForJob({job_id:jobId,timeout_ms:100});
          bus.workAttention!.cleanup(work.id,[{...resource,state:status.running?"requested":"confirmed"}]);
          if(!status.running && recorded)pending?.dropped(recorded,"cancelled");
        } catch { /* durable unconfirmed cleanup remains visible and recoverable */ }
      }
      return result;
    };
  }});
}
