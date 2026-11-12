/** Operator-only work cancellation and explicit legacy member containment. */
import { WorkControl, type WorkTarget } from "../host/work-control.ts";
import type { Orchestrator } from "../host/orchestrator.ts";
import type { AgentPauses } from "../host/agent-pause.ts";
import type { QuestionWatch } from "../host/question-expiry.ts";
import type { WorkStamp } from "../agents/work-attention.ts";

type NativeEntries = Pick<Map<string,{agentId:string;work?:WorkStamp}>,"entries"|"delete">;
export function workControlFor(host: Orchestrator, pauses: AgentPauses, questions: QuestionWatch, secrets: NativeEntries, desktops: NativeEntries, runner?: import("../host/host-runner.ts").HostRunner): WorkControl {
  return new WorkControl({host,pauses,questions,runner,native:{
    list: workId => [...secrets.entries()].filter(([,row])=>row.work?.id===workId).map(([id,row])=>({kind:"secret",id,agentId:row.agentId})).concat([...desktops.entries()].filter(([,row])=>row.work?.id===workId).map(([id,row])=>({kind:"desktop",id,agentId:row.agentId}))),
    cancel: workId => { for(const map of [secrets,desktops]) for(const [id,row] of map.entries()) if(row.work?.id===workId) map.delete(id); },
  }});
}
export async function pauseManagedMembers(host: Orchestrator, pauses: AgentPauses, agents: string[], by: string, reason: string) {
      const nativeStops:Promise<{kind:string;id:string;state:string}>[]=[];
      const result=await pauses.pauseMany(agents,by,reason,ids=>{
        for(const route of host.modelRelay.active())if(ids.includes(route.agentId))host.modelRelay.revoke(route.key,"member paused");
        for(const route of host.mcpFace.active())if(ids.includes(route.agentId))host.mcpFace.revoke(route.key,"member paused");
        for(const session of host.acpDelegates.list())if(ids.includes(session.agentId))nativeStops.push(new Promise(resolve=>{
          const timer=setTimeout(()=>resolve({kind:"delegate",id:session.jobId,state:"unconfirmed"}),3000);
          host.acpDelegates.close(session.jobId,"member paused").then(()=>{clearTimeout(timer);resolve({kind:"delegate",id:session.jobId,state:"confirmed"});},()=>{clearTimeout(timer);resolve({kind:"delegate",id:session.jobId,state:"unconfirmed"});});
        }));
      });
      return {...result,nativeStops:await Promise.all(nativeStops),warning:"Old messages remain queued. Review them before resuming; unlinked external sessions require verification."};
}
export async function workControlRoute(route: string, url: URL, control: WorkControl, deps: {
  host: Orchestrator; pauses: AgentPauses; refusedAdmin:()=>boolean; mayReadAgent:(id:string)=>boolean; mayReadTask:(id:string)=>boolean; by:()=>string;
  readJson:()=>Promise<Record<string,unknown>>;
}): Promise<{status:number;body:unknown}|undefined> {
  if (!['GET /api/work-control/preview','POST /api/work-control/cancel','POST /api/work-control/pause-members'].includes(route)) return undefined;
  if (deps.refusedAdmin()) return {status:0,body:null};
  try {
    const input = route.startsWith('GET ') ? Object.fromEntries(url.searchParams) : await deps.readJson();
    if (route==='POST /api/work-control/pause-members') {
      if(!Array.isArray(input.agents) || !input.agents.length || input.agents.length>100 || input.agents.some(id=>typeof id!=="string" || !deps.host.registry.has(id))) return {status:400,body:{error:"Choose the members to pause explicitly"}};
      if((input.agents as string[]).some(id=>!deps.mayReadAgent(id)))return {status:403,body:{error:"Box access required for every selected member"}};
      return {status:200,body:await pauseManagedMembers(deps.host,deps.pauses,input.agents as string[],deps.by(),String(input.reason??"User containment of an unlinked historical task").slice(0,500))};
    }
    const taskId=typeof input.taskId==='string' && input.taskId ? input.taskId : undefined;
    const task=taskId?deps.host.tasks?.get(taskId):undefined;
    if(taskId && !deps.mayReadTask(taskId))return {status:403,body:{error:"Task access required"}};
    if(taskId&&!task) return {status:404,body:{error:"Task not found"}};
    const target: WorkTarget={agentId:task?(task.assigneeId??""):String(input.agentId??""),conversation:task?.conversation??String(input.conversation??"main"),...(taskId?{taskId}: {})};
    if(target.agentId && !deps.mayReadAgent(target.agentId))return {status:403,body:{error:"Box access required"}};
    const preview=control.preview(target);
    if([...preview.participants.map(row=>row.id),...preview.resources.flatMap(row=>row.agentId?[row.agentId]:[])].some(id=>!deps.mayReadAgent(id)))return {status:403,body:{error:"Box access required for every participant"}};
    if(preview.resources.some(row=>row.kind==="task" && !deps.mayReadTask(row.id)))return {status:403,body:{error:"Task access required for every linked task"}};
    if(route.startsWith('GET ')) return {status:200,body:preview};
    const cancelled=await control.cancel(target,String(input.token??""),deps.by(),String(input.reason??"Cancelled by the user").slice(0,500));
    return {status:200,body:{cancelled,externalEffectsNeedVerification:true}};
  } catch(error) { return {status:409,body:{error:error instanceof Error?error.message:String(error)}}; }
}
