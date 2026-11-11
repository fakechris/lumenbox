/** Current user work outlives a physical turn. The host owns admission and peer relationships. */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import type { InboundMessage } from "./admitted-message.ts";
import type { AgentRegistry } from "./registry.ts";

export interface WorkStamp { id: string; owner: string; conversation: string; generation: number; epoch: number; isolated?: boolean; previous?: string; taskId?: string }
export interface WorkReturn { work: WorkStamp; conversation: string }
export interface StopResource { id: string; kind: string; agentId?: string; state?: "requested" | "confirmed" | "unconfirmed"; detail?: string }
export interface CancelledWork extends WorkStamp { by: string; at: string; reason: string; participants: string[]; sourceMessages?: string[]; resources: StopResource[] }
export type WorkWait = "queue" | "interrupted" | "focus" | "capability" | "confirmation" | "dependency" | "plan" | "execution";
export interface CurrentWork extends WorkStamp {
  wait?: WorkWait;
  unresolved?: true;
  principal?: string;
  status: "running" | "waiting" | "answered" | "cancelled";
  reason?: string; unavailable?: {participant: string; tool: string}[];
  messages: string[];
  peers: string[];
  awaiting: string[];
  executions?: { agentId: string; conversation: string }[];
}
export const messageWorkId = (message: InboundMessage): string | undefined => message.work?.id ?? message.goal?.workId ?? message.resumeOf?.workId ?? message.taskBinding?.parent?.workId;
export const personMessage = (message: InboundMessage): boolean => message.fromId === "user" && !message.synthetic && !message.origin && !message.resumeOf && !message.goal;
const keyOf = (agent: string, conversation: string) => JSON.stringify([agent, conversation]);

export interface RootPersistence { load(legacy?: {records:CurrentWork[];cancellations:CancelledWork[]}): {records: CurrentWork[]; cancellations: CancelledWork[]}; save(records: readonly CurrentWork[], cancellations: readonly CancelledWork[]): void; started?(ids:readonly string[]):void }

export class WorkAttention {
  private readonly roots = new Map<string, CurrentWork>();
  private readonly current = new Map<string, CurrentWork>();
  private readonly terminations = new Map<string, CancelledWork>();
  private readonly cancelledInputs = new Set<string>();
  private committed: {records:CurrentWork[];cancellations:CancelledWork[]} = {records:[],cancellations:[]};
  constructor(private readonly path?: string, private readonly epochOf: (agent: string, conversation: string) => number = () => 0, persistence?: RootPersistence) {
    if (path && existsSync(path)) {
      const data = JSON.parse(readFileSync(path, "utf8")) as { schema: number; records: CurrentWork[]; cancellations?: CancelledWork[] };
      if (data.schema !== 1 || !Array.isArray(data.records)) throw new Error("Unsupported current-work state; restore it before continuing");
      for (const row of data.cancellations ?? []) {
        if (!row.id || !row.owner || !row.conversation || !Array.isArray(row.participants) || !row.at || !row.by) throw new Error("Invalid work cancellation state");
        this.terminations.set(row.id, row);
        for(const id of row.sourceMessages ?? [row.id])this.cancelledInputs.add(id);
      }
      for (const row of data.records) {
        if (!row.id || !row.owner || !row.conversation || !Number.isInteger(row.epoch) || !Number.isInteger(row.generation) || !Array.isArray(row.messages) || !Array.isArray(row.peers) || !["running", "waiting", "answered", "cancelled"].includes(row.status)) throw new Error("Invalid current-work state");
        const restored = { ...row, ...((row.status !== "cancelled" && (row.status === "running" || row.awaiting?.some(item => item.startsWith("volatile:")))) ? { status: "waiting" as const, reason: "execution interrupted", wait:"interrupted" as const } : {}), awaiting: (row.awaiting ?? []).filter(item => !item.startsWith("volatile:")) };
        this.project(restored,false);
      }
    }
    if (persistence) this.attach(persistence);
    this.checkpoint();
  }
  private persistence?: RootPersistence;
  attach(persistence:RootPersistence):void {
    if(this.persistence===persistence)return;
    if(this.persistence)throw new Error("Work roots already have a persistence authority");
    const data=persistence.load({records:[...this.roots.values()],cancellations:[...this.terminations.values()]});
    this.persistence=persistence;this.current.clear();this.roots.clear();
    const restored=data.records.map(row=>{
      const interrupted=row.status!=="cancelled" && (row.status==="running" || row.awaiting.some(item=>item.startsWith("volatile:")));
      return {...row,...(interrupted?{status:"waiting" as const,reason:"execution interrupted",wait:"interrupted" as const}:{}),awaiting:row.awaiting.filter(item=>!item.startsWith("volatile:"))};
    });
    persistence.save(restored.filter((row,index)=>JSON.stringify(row)!==JSON.stringify(data.records[index])),data.cancellations);
    for(const row of restored)this.project(row,false);
    for(const row of data.cancellations){this.terminations.set(row.id,row);for(const id of row.sourceMessages??[row.id])this.cancelledInputs.add(id);}
    this.checkpoint();
  }
  epoch(agent:string,conversation:string):number {return this.epochOf(agent,conversation);}
  generation(agent:string,conversation:string):number {return this.current.get(keyOf(agent,conversation))?.generation??0;}
  project(state:CurrentWork,checkpoint=true):void { const row=structuredClone(state);this.roots.set(row.id,row);const key=keyOf(row.owner,row.conversation),current=this.current.get(key);if(!current||row.generation>=current.generation)this.current.set(key,row);if(checkpoint)this.checkpoint(); }
  byId(id:string): CurrentWork | undefined { const work=this.roots.get(id);return work&&structuredClone(work); }
  all(): CurrentWork[] { return [...this.roots.values()].map(work=>structuredClone(work)); }
  get(agent: string, conversation: string): CurrentWork | undefined {
    const value = this.current.get(keyOf(agent, conversation));
    return value && value.epoch === this.epochOf(agent, conversation) ? structuredClone(value) : undefined;
  }
  private live(stamp: WorkStamp): CurrentWork | undefined {
    const value = this.roots.get(stamp.id);
    return !this.terminations.has(stamp.id) && !value?.unresolved && this.current.get(keyOf(stamp.owner,stamp.conversation))?.id===stamp.id && value?.id === stamp.id && value.generation === stamp.generation && value.epoch === stamp.epoch && value.status !== "answered" && value.status !== "cancelled" && value.owner===stamp.owner && value.conversation===stamp.conversation && value.epoch === this.epochOf(stamp.owner, stamp.conversation) ? value : undefined;
  }
  valid(stamp: WorkStamp, participant: string): boolean {
    const value = this.live(stamp);
    return !!value && (value.owner === participant || value.peers.includes(participant));
  }
  /** Only a drained human message can claim or amend foreground work. */
  begin(agent: string, conversation: string, messages: readonly InboundMessage[]): WorkStamp | undefined {
    const humans = messages.filter(personMessage), first = humans[0];
    if(first?.work){const admitted=this.roots.get(first.work.id);if(!admitted || !this.valid(first.work,agent))throw new Error("The admitted root is no longer executable");this.persistence?.started?.(humans.map(message=>message.id));this.settle(admitted,"running");return this.stamp(admitted);}
    if (!first) {
      const related = messages.map(m => m.work).find(stamp => stamp && this.valid(stamp, agent));
      if (related?.owner === agent && related.conversation === conversation) this.settle(related, "running");
      return related;
    }
    const previous = this.get(agent, conversation);
    const reuse = previous && this.valid(previous, agent) && (previous.principal === undefined || previous.principal === first.principalId) && first.steerable !== false;
    const next: CurrentWork = reuse ? { ...previous, principal: first.principalId ?? previous.principal, messages: [...new Set([...previous.messages, ...humans.map(m => m.id)])].slice(-128), status: "running", reason: undefined }
      : { id: first.id, owner: agent, conversation, generation: (previous?.generation ?? 0) + 1, epoch: this.epochOf(agent, conversation), isolated: true, taskId: first.taskBinding?.taskId, ...(previous ? { previous: workStateConversation(previous, conversation) } : {}), principal: first.principalId, status: "running", messages: humans.map(m => m.id), peers: [], awaiting: [] };
    this.current.set(keyOf(agent, conversation), next); this.roots.set(next.id,next); this.save(); return this.stamp(next);
  }
  /** A validated goal/resume already has a durable work identity; it is never replaced with a new UUID. */
  existing(agent: string, conversation: string, id: string, taskId?: string): WorkStamp {
    if (this.terminations.has(id)) throw new Error("This work was cancelled; start new work explicitly");
    const known=this.roots.get(id);
    if(known?.unresolved)throw new Error("Historical work linkage is unresolved; admit a new user request before executing it");
    if(known && known.owner===agent && !known.unresolved && known.epoch===this.epochOf(agent,known.conversation)) {
      if(taskId && known.taskId && taskId!==known.taskId)throw new Error("The work root belongs to another task");
      const focused=this.current.get(keyOf(known.owner,known.conversation));
      if(focused && focused.id!==known.id){
        if(focused.status!=="answered" && focused.status!=="cancelled")throw new Error("Another user work holds execution custody");
        known.generation=focused.generation+1;this.current.set(keyOf(known.owner,known.conversation),known);
      }
      known.taskId??=taskId;known.status="running";known.reason=undefined;this.save();return this.stamp(known);
    }
    const previous = this.get(agent, conversation);
    if (previous?.id === id && previous.status !== "answered") { if (taskId) { previous.taskId = taskId; this.current.get(keyOf(agent, conversation))!.taskId = taskId; } const stamp = this.stamp(previous); this.settle(stamp, "running"); return stamp; }
    const next: CurrentWork = { id, owner: agent, conversation, generation: (previous?.generation ?? 0) + 1, epoch: this.epochOf(agent, conversation), isolated: false, principal: previous?.principal, taskId, status: "running", messages: [], peers: [], awaiting: [] };
    this.current.set(keyOf(agent, conversation), next); this.roots.set(next.id,next); this.save(); return this.stamp(next);
  }
  /** A sender cannot invent a root or acquire membership by writing it into its message. */
  link(stamp: WorkStamp, from: string, to: string, expectsResult = true): WorkStamp | undefined {
    if (!this.valid(stamp, from)) return undefined;
    const value = this.live(stamp)!;
    if (!value.peers.includes(to) && to !== value.owner) { value.peers.push(to); }
    if (expectsResult && to !== value.owner && !value.awaiting.includes(to)) value.awaiting.push(to);
    if (from !== value.owner) value.awaiting = value.awaiting.filter(id => id !== from);
    this.save();
    return this.stamp(value);
  }
  eligible(agent: string, conversation: string, message: InboundMessage): boolean {
    if (this.cancelledMessage(message)) return false;
    if (personMessage(message)) return !message.work ? !this.persistence : this.valid(message.work,agent) && (this.roots.get(message.work.id)?.principal??"web")===(message.principalId??"web");
    if (!message.informational && message.work && (!this.valid(message.work, agent) || !this.valid(message.work, message.fromId) && message.fromId !== "system" && !(message.fromId === "user" && message.synthetic))) return false;
    const current = this.get(agent, conversation);
    if (message.goal || message.resumeOf) return !current || current.status === "answered" || current.id === (message.goal?.workId ?? message.resumeOf?.workId) || !!message.goal && current.taskId !== undefined && current.taskId === message.goal.taskId;
    if (!current || current.status === "answered" || current.status === "cancelled") return true;
    return !!message.work && message.work.id === current.id && message.work.generation === current.generation &&
      (message.fromId === "system" || message.fromId === "user" && message.synthetic || this.valid(message.work, message.fromId)) && this.valid(message.work, agent);
  }
  forId(agent: string, conversation: string, id: string): WorkStamp | undefined {
    for (const work of this.roots.values()) {
      const stamp = this.stamp(work);
      if (work.id === id && this.valid(stamp, agent) && (work.executions?.some(row => row.agentId === agent && row.conversation === conversation) || (work.owner === agent ? conversation === work.conversation : conversation === peerWorkConversation([{fromId: work.owner, work: stamp} as InboundMessage], conversation)))) return stamp;
    }
    return undefined;
  }
  execution(stamp: WorkStamp, agentId: string, conversation: string): void {
    const work = this.live(stamp); if (!work || !this.valid(stamp, agentId)) return;
    if (work.executions?.some(row => row.agentId === agentId && row.conversation === conversation)) return;
    work.executions = [...work.executions ?? [], { agentId, conversation }]; this.save();
  }
  returnTo(agent: string, conversation: string, id: string): WorkReturn | undefined { const work = this.forId(agent, conversation, id); return work ? {work,conversation} : undefined; }
  hold(stamp: WorkStamp, id: string): void { const work = this.live(stamp); if (work && !work.awaiting.includes("volatile:" + id)) { work.awaiting.push("volatile:" + id); this.save(); } }
  release(stamp: WorkStamp, id: string): void { const work = this.live(stamp); if (work) { work.awaiting = work.awaiting.filter(item => item !== "volatile:" + id); this.save(); } }
  capability(stamp: WorkStamp, participant: string, tool: string, available: boolean): void {
    const work = this.live(stamp); if (!work || !this.valid(stamp, participant)) return;
    const before = work.unavailable ?? [], kept = before.filter(block => block.participant !== participant || block.tool !== tool);
    if (!available) kept.push({participant,tool});
    if (!available || kept.length !== before.length) { work.unavailable = kept.length ? kept : undefined; this.save(); }
  }
  settle(stamp: WorkStamp, status: CurrentWork["status"], reason?: string,wait?:WorkWait): void {
    const value = this.live(stamp);
    if (!value) return;
    value.status = status; value.reason = reason;value.wait=status==="waiting"?wait:undefined; this.save();
  }
  cancelled(id: string): CancelledWork | undefined { const value = this.terminations.get(id); return value && structuredClone(value); }
  cancellations(): CancelledWork[] { return [...this.terminations.values()].map(row => structuredClone(row)); }
  cleanup(id: string, resources: StopResource[]): void {
    const row = this.terminations.get(id); if (!row) throw new Error("No cancellation record");
    const merged = new Map(row.resources.map(item => [item.kind + ":" + item.id, item]));
    for (const item of resources) if(merged.get(item.kind + ":" + item.id)?.state!=="confirmed") merged.set(item.kind + ":" + item.id, item);
    const next = { ...row, resources: structuredClone([...merged.values()]) };
    this.save(undefined, [...this.terminations.values()].map(item => item.id === id ? next : item));
    this.terminations.set(id, next);
  }
  cancelledMessage(message: InboundMessage): boolean {
    const id = messageWorkId(message);
    return !!id && this.terminations.has(id) || personMessage(message) && this.cancelledInputs.has(message.id);
  }
  /** The durable revocation is committed before the caller interrupts any executor. */
  cancel(stamp: WorkStamp, by: string, reason: string, resources: StopResource[] = []): CancelledWork {
    const old = this.cancelled(stamp.id); if (old) return old;
    const current = this.roots.get(stamp.id); if (!current || current.generation!==stamp.generation || current.epoch!==stamp.epoch) throw new Error("Work changed; refresh the cancellation preview");
    const ended: CancelledWork = { ...this.stamp(current), by, reason, at: new Date().toISOString(), participants: [current.owner, ...current.peers], sourceMessages:[...new Set([current.id,...current.messages])], resources: structuredClone(resources) };
    const records = [...this.roots.values()].map(row => row.id === stamp.id ? { ...row, status: "cancelled" as const, reason } : row);
    this.save(records, [...this.terminations.values(), ended]);
    this.terminations.set(stamp.id, ended);
    for(const id of ended.sourceMessages!)this.cancelledInputs.add(id);
    const stopped={...current,status:"cancelled" as const,reason}; this.roots.set(stamp.id,stopped);
    if(this.current.get(keyOf(stamp.owner,stamp.conversation))?.id===stamp.id)this.current.set(keyOf(stamp.owner,stamp.conversation),stopped);
    return structuredClone(ended);
  }
  private stamp(work: CurrentWork): WorkStamp { return { id: work.id, owner: work.owner, conversation: work.conversation, generation: work.generation, epoch: work.epoch, isolated: work.isolated, previous: work.previous, taskId: work.taskId }; }
  private checkpoint(records=[...this.roots.values()],cancellations=[...this.terminations.values()]):void {this.committed=structuredClone({records,cancellations});}
  private save(records = [...this.roots.values()], cancellations = [...this.terminations.values()]): void {
    try {
      if (this.persistence) {
        const before=new Map(this.committed.records.map(row=>[row.id,JSON.stringify(row)])), revocations=new Map(this.committed.cancellations.map(row=>[row.id,JSON.stringify(row)]));
        const after=new Map(cancellations.map(row=>[row.id,JSON.stringify(row)]));
        this.persistence.save(records.filter(row=>before.get(row.id)!==JSON.stringify(row) || revocations.get(row.id)!==after.get(row.id)),cancellations);
      }
      else if (this.path) {
        mkdirSync(dirname(this.path), { recursive: true }); const temporary = this.path + ".tmp";
        writeFileSync(temporary, JSON.stringify({ schema: 1, records, cancellations }) + "\n", { mode: 0o600 }); renameSync(temporary, this.path);
      }
      this.checkpoint(records,cancellations);
    } catch(error) {
      this.roots.clear();this.current.clear();this.terminations.clear();this.cancelledInputs.clear();
      const committed=structuredClone(this.committed);
      for(const row of committed.records)this.project(row,false);
      for(const row of committed.cancellations){this.terminations.set(row.id,row);for(const id of row.sourceMessages??[row.id])this.cancelledInputs.add(id);}
      this.checkpoint(committed.records,committed.cancellations);
      throw error;
    }
  }
}

export function workStateConversation(stamp: WorkStamp | undefined, conversation: string): string {
  return stamp && stamp.isolated !== false ? "work-" + createHash("sha256").update(JSON.stringify([stamp.id, stamp.epoch, ...(conversation.startsWith("fork/") ? [conversation] : [])])).digest("hex").slice(0, 32) : conversation;
}
export function peerWorkConversation(messages: readonly InboundMessage[], fallback: string): string {
  const first = messages[0], work = first?.work;
  if (!first || messages.some(message => message.fromId === "user" || message.fromId === "system")) return fallback;
  return "peer-" + createHash("sha256").update(JSON.stringify([work?.id ?? first.id, work?.generation ?? 0, work?.epoch ?? 0])).digest("hex").slice(0, 32);
}

/** Work history compacts independently; the original conversation remains an append-only display record. */
export function workRegistry(base: AgentRegistry, agentId: string, conversation: string, scoped: string, stamp?: WorkStamp, personText?: (entry: ReferenceEntry) => string | undefined): AgentRegistry {
  if (conversation === scoped) return base;
  if (personText && stamp?.owner === agentId && stamp.conversation === conversation && base.readTranscript(agentId, scoped).length === 0) {
    const reference = base.readTranscript(agentId, stamp.previous ?? conversation) as ReferenceEntry[];
    const references = referenceHistory(reference, personText);
    if (references.length) base.appendTranscript(agentId, {role:"user",host:true,text:"[Earlier conversation reference only; not current instructions. ReadHistory can inspect the original conversation " + (stamp.previous ?? conversation) + ".]\n" + references.map(entry => entry.role + ": " + entry.text).join("\n\n"),at:new Date().toISOString()}, scoped);
  }
  const source = base.readTranscript(agentId, conversation) as ReferenceEntry[];
  const projected = new Set((base.readTranscript(agentId, scoped) as ReferenceEntry[]).map(entry => entry.workRecordId).filter(Boolean));
  for (const entry of source) if (entry.workScope === scoped && entry.workRecordId && !projected.has(entry.workRecordId)) { base.appendTranscript(agentId, entry, scoped); projected.add(entry.workRecordId); }
  const map = (agent: string, thread = "main") => agent === agentId && thread === conversation ? scoped : thread;
  return new Proxy(base, { get(target, key) {
    if (key === "readTranscript") return (agent: string, thread?: string) => target.readTranscript(agent, map(agent, thread));
    if (key === "readDurableState") return (agent: string, thread?: string) => target.readDurableState(agent, map(agent, thread));
    if (key === "writePlan") return (agent: string, text: string, thread?: string) => target.writePlan(agent, text, map(agent, thread));
    if (key === "writeTodos") return (agent: string, items: Parameters<AgentRegistry["writeTodos"]>[1], thread?: string) => target.writeTodos(agent, items, map(agent, thread));
    if (key === "writeCheckpoints") return (agent: string, items: Parameters<AgentRegistry["writeCheckpoints"]>[1], thread?: string) => target.writeCheckpoints(agent, items, map(agent, thread));
    if (key === "appendTranscript") return (agent: string, entry: unknown, thread = "main") => {
      const mapped = map(agent, thread);
      if (mapped === thread) { target.appendTranscript(agent, entry, thread); return; }
      const recorded = { ...(entry as object), workScope: mapped, workRecordId: createHash("sha256").update(JSON.stringify([mapped, entry])).digest("hex") };
      // The existing recovery ledger reads the original transcript. Its append is canonical;
      // a crash before the work projection is repaired above, without replaying the effect.
      target.appendTranscript(agent, recorded, thread); target.appendTranscript(agent, recorded, mapped);
    };
    const value = Reflect.get(target, key, target) as unknown;
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

/** Earlier prose supports references; a new request never inherits old tool instructions or plans. */
type ReferenceEntry = { role?: string; kind?: string; text?: string; turnId?: string; fromPerson?: boolean; host?: boolean; workScope?: string; workRecordId?: string };
function referenceHistory(entries: ReferenceEntry[], personText: (entry: ReferenceEntry) => string | undefined): ReferenceEntry[] {
  const isOpening = (entry: ReferenceEntry) => entry.role === "user" && !entry.kind && typeof entry.text === "string";
  const backgroundTurns = new Set(entries.filter(entry => isOpening(entry) && personText(entry) === undefined).map(entry => entry.turnId).filter(Boolean));
  let background = true;
  const admitted = entries.filter(entry => {
    if (isOpening(entry)) background = personText(entry) === undefined;
    return !background && !backgroundTurns.has(entry.turnId) && !entry.kind && !!entry.text;
  }).map(entry => isOpening(entry) ? {...entry,text:personText(entry)!} : entry);
  let remaining = 8000;
  return admitted.slice(-8).reverse().flatMap(entry => {
    const text = entry.text!.slice(0, Math.min(4000, remaining)); remaining -= text.length;
    return text ? [{...entry,text}] : [];
  }).reverse();
}
