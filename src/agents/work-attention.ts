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

export interface RootPersistence { load(legacy?: {records:CurrentWork[];cancellations:CancelledWork[]}): {records: CurrentWork[]; cancellations: CancelledWork[]}; save(records: readonly CurrentWork[], cancellations: readonly CancelledWork[]): void; started?(ids:readonly string[]):void; hasRequest?(taskId:string,messageId:string):boolean }

const WORK_STATUSES = ["running", "waiting", "answered", "cancelled"];
const WORK_WAITS = ["queue", "interrupted", "focus", "capability", "confirmation", "dependency", "plan", "execution"];
const RESOURCE_STATES = ["requested", "confirmed", "unconfirmed"];
const isStrings = (value: unknown): boolean => Array.isArray(value) && value.every(item => typeof item === "string" && item.length > 0);
const isCount = (value: unknown): boolean => Number.isInteger(value) && (value as number) >= 0;
const isStamp = (row: WorkStamp | undefined): boolean =>
  !!row && typeof row.id === "string" && !!row.id && typeof row.owner === "string" && !!row.owner &&
  typeof row.conversation === "string" && !!row.conversation && isCount(row.epoch) && isCount(row.generation);

function validRecord(row: CurrentWork): boolean {
  return isStamp(row) && isStrings(row.messages) && isStrings(row.peers) && isStrings(row.awaiting ?? []) &&
    WORK_STATUSES.includes(row.status) && (row.wait === undefined || WORK_WAITS.includes(row.wait)) &&
    (row.unresolved === undefined || row.unresolved === true) &&
    (row.executions === undefined || Array.isArray(row.executions) && row.executions.every(item => !!item && typeof item.agentId === "string" && typeof item.conversation === "string"));
}

function validCancellation(row: CancelledWork): boolean {
  return isStamp(row) && isStrings(row.participants) && !!row.at && !!row.by && Array.isArray(row.resources) &&
    (row.sourceMessages === undefined || isStrings(row.sourceMessages)) &&
    row.resources.every(item => !!item && typeof item.id === "string" && typeof item.kind === "string" &&
      (item.state === undefined || RESOURCE_STATES.includes(item.state)));
}

export interface RejectedWork { id?: string; reason: string }
export interface AdmittedWorkState { records: CurrentWork[]; cancellations: CancelledWork[]; rejected: RejectedWork[] }

/**
 * Every storage adapter passes the same authority check before projection or execution (INV-1822).
 *
 * One bad record used to stop the host from starting, with a message to "restore it" and nothing to
 * restore it with. A record that fails the check is set aside instead: it is not projected, so nothing
 * can execute under it, and the rest of the installation runs. A damaged cancellation still revokes —
 * forgetting that a piece of work was stopped is the one failure that would start it again.
 */
export function admitWorkRecords(data: { records: CurrentWork[]; cancellations?: CancelledWork[] }): AdmittedWorkState {
  if (!Array.isArray(data.records) || data.cancellations !== undefined && !Array.isArray(data.cancellations)) throw new Error("Invalid work state collection");
  const admitted: AdmittedWorkState = { records: [], cancellations: [], rejected: [] };
  const seen = new Set<string>();
  for (const row of data.records) {
    const id = typeof row?.id === "string" ? row.id : undefined;
    if (!validRecord(row)) admitted.rejected.push({ id, reason: "invalid work record" });
    else if (seen.has(row.id)) admitted.rejected.push({ id, reason: "a second task claims this work root" });
    else { seen.add(row.id); admitted.records.push(row); }
  }
  for (const row of data.cancellations ?? []) {
    if (validCancellation(row)) { admitted.cancellations.push(row); continue; }
    const id = typeof row?.id === "string" && row.id ? row.id : undefined;
    admitted.rejected.push({ id, reason: "invalid cancellation record" + (id ? "; the work stays cancelled" : "") });
    if (!id) continue;
    const owner = typeof row.owner === "string" && row.owner ? row.owner : "unknown";
    const conversation = typeof row.conversation === "string" && row.conversation ? row.conversation : "main";
    admitted.cancellations.push({ id, owner, conversation, generation: isCount(row.generation) ? row.generation : 0, epoch: isCount(row.epoch) ? row.epoch : 0, by: "host", at: new Date().toISOString(), reason: "cancellation record was damaged", participants: [owner], resources: [], ...(isStrings(row.sourceMessages) ? { sourceMessages: row.sourceMessages } : {}) });
  }
  return admitted;
}

/** A record read back as running, or waiting on something that lived only in memory, was interrupted. */
function afterRestart(row: CurrentWork): CurrentWork {
  const awaiting = (row.awaiting ?? []).filter(item => !item.startsWith("volatile:"));
  const interrupted = row.status !== "cancelled" && (row.status === "running" || awaiting.length !== (row.awaiting ?? []).length);
  return { ...row, ...(interrupted ? { status: "waiting" as const, reason: "execution interrupted", wait: "interrupted" as const } : {}), awaiting };
}

export class WorkAttention {
  private readonly roots = new Map<string, CurrentWork>();
  private readonly current = new Map<string, CurrentWork>();
  private readonly terminations = new Map<string, CancelledWork>();
  private readonly cancelledInputs = new Set<string>();
  private readonly setAside: RejectedWork[] = [];
  private committed: {records:CurrentWork[];cancellations:CancelledWork[]} = {records:[],cancellations:[]};
  constructor(private readonly path?: string, private readonly epochOf: (agent: string, conversation: string) => number = () => 0, persistence?: RootPersistence, private readonly log: (line: string) => void = () => {}) {
    if (path && existsSync(path)) {
      const data = this.readFile(path);
      if (data) {
        const admitted = this.admit(data);
        for (const row of admitted.cancellations) this.revoke(row);
        for (const row of admitted.records) this.project(afterRestart(row), false);
      }
    }
    if (persistence) this.attach(persistence);
    this.checkpoint();
  }
  private persistence?: RootPersistence;
  /** The state file as written, or nothing when it cannot be read: it is moved aside, never deleted. */
  private readFile(path: string): { records: CurrentWork[]; cancellations?: CancelledWork[] } | undefined {
    try {
      const data = JSON.parse(readFileSync(path, "utf8")) as { schema: number; records: CurrentWork[]; cancellations?: CancelledWork[] };
      if (data.schema !== 1 || !Array.isArray(data.records) || data.cancellations !== undefined && !Array.isArray(data.cancellations)) throw new Error("unsupported schema");
      return data;
    } catch (error) {
      const aside = path + ".rejected-" + Date.now();
      renameSync(path, aside);
      this.setAside.push({ reason: "unreadable work state file, kept as " + aside });
      this.log(`work state file could not be read (${error instanceof Error ? error.message : String(error)}); kept as ${aside}`);
      return undefined;
    }
  }
  private admit(data: { records: CurrentWork[]; cancellations?: CancelledWork[] }): AdmittedWorkState {
    const admitted = admitWorkRecords(data);
    for (const row of admitted.rejected) { this.setAside.push(row); this.log(`work record set aside${row.id ? " (" + row.id + ")" : ""}: ${row.reason}`); }
    return admitted;
  }
  private revoke(row: CancelledWork): void {
    this.terminations.set(row.id, row);
    for (const id of row.sourceMessages ?? [row.id]) this.cancelledInputs.add(id);
  }
  /** Records that failed the authority check at load. They are not executable; a person decides what they were. */
  rejected(): RejectedWork[] { return structuredClone(this.setAside); }
  attach(persistence:RootPersistence):void {
    if(this.persistence===persistence)return;
    if(this.persistence)throw new Error("Work roots already have a persistence authority");
    const loaded = this.admit(persistence.load({records:[...this.roots.values()],cancellations:[...this.terminations.values()]}));
    this.persistence=persistence;this.current.clear();this.roots.clear();
    const restored = loaded.records.map(afterRestart);
    persistence.save(restored.filter((row, index) => JSON.stringify(row) !== JSON.stringify(loaded.records[index])), loaded.cancellations);
    for (const row of restored) this.project(row, false);
    for (const row of loaded.cancellations) this.revoke(row);
    this.checkpoint();
  }
  epoch(agent:string,conversation:string):number {return this.epochOf(agent,conversation);}
  generation(agent:string,conversation:string):number {return Math.max(0,...[...this.roots.values()].filter(row=>row.owner===agent && row.conversation===conversation).map(row=>row.generation));}
  project(state:CurrentWork,checkpoint=true,activate=true):void {
    // The one door into the projection: a record set aside at load cannot come back through a retried request.
    if (!validRecord(state)) throw new Error("This work record is invalid and was set aside; it cannot execute");
    const row=structuredClone(state);this.roots.set(row.id,row);const key=keyOf(row.owner,row.conversation),current=this.current.get(key);if(!current||row.id===current.id||activate&&row.generation>=current.generation)this.current.set(key,row);if(checkpoint)this.checkpoint(); }
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
    if(first?.work){
      if(!humans.every(message=>message.work?.id===first.work!.id && this.admittedPerson(agent,conversation,message)))throw new Error("The admitted root is no longer executable");
      this.persistence?.started?.(humans.map(message=>message.id));
      const admitted=this.roots.get(first.work.id)!,previous=this.current.get(keyOf(agent,conversation));
      if(previous && previous.id!==admitted.id && previous.status!=="answered" && previous.status!=="cancelled"){previous.status="waiting";previous.wait="focus";previous.reason="Focus moved to another request";}
      const next={...admitted,status:"running" as const,reason:undefined,wait:undefined,generation:previous && previous.id!==admitted.id?this.generation(agent,conversation)+1:admitted.generation};
      this.roots.set(next.id,next);this.current.set(keyOf(agent,conversation),next);this.save();return this.stamp(next);
    }
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
  admittedPerson(agent:string,conversation:string,message:InboundMessage):boolean {
    if(!personMessage(message))return false;
    if(!message.work)return !this.persistence;
    const work=this.roots.get(message.work.id);
    return !!work && !work.unresolved && !this.terminations.has(work.id) && work.status!=="cancelled" && work.owner===agent && work.conversation===conversation && work.epoch===message.work.epoch && work.epoch===this.epochOf(agent,conversation) && message.work.generation<=work.generation && (work.principal??"web")===(message.principalId??"web") && (this.persistence?.hasRequest ? !!work.taskId && this.persistence.hasRequest(work.taskId,message.id) : work.messages.includes(message.id));
  }
  eligible(agent: string, conversation: string, message: InboundMessage): boolean {
    if (this.cancelledMessage(message)) return false;
    if (personMessage(message)) return this.admittedPerson(agent,conversation,message);
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

/**
 * The transcript a turn of this work reads and writes (INV-1822).
 *
 * A person's requests to one agent in one conversation are one thread: the second is said to somebody
 * who heard the first, tool results included. So every piece of work its owner runs there shares one
 * transcript, per context epoch, and `/new` starts another. What stays per work is the plan, the todo
 * list and the checkpoints (`workStateConversation`). Background turns never write here, which is the
 * isolation the per-work transcript was built for, without the amnesia it cost.
 */
export function workHistoryConversation(stamp: WorkStamp | undefined, agentId: string, conversation: string): string {
  if (!stamp || stamp.isolated === false) return conversation;
  if (stamp.owner !== agentId || stamp.conversation !== conversation) return workStateConversation(stamp, conversation);
  return "work-" + createHash("sha256").update(JSON.stringify(["thread", agentId, conversation, stamp.epoch])).digest("hex").slice(0, 32);
}

/**
 * The registry a turn of this work sees: the conversation's name resolves to the person's thread for
 * the transcript and to the work's own scope for durable state. The original conversation stays the
 * append-only record the recovery ledger and the page read.
 */
export function workRegistry(base: AgentRegistry, agentId: string, conversation: string, history: string, stamp?: WorkStamp, personText?: (entry: ReferenceEntry) => string | undefined): AgentRegistry {
  const state = workStateConversation(stamp, conversation);
  if (conversation === history && conversation === state) return base;
  const source = base.readTranscript(agentId, conversation) as ReferenceEntry[];
  const thread = base.readTranscript(agentId, history) as ReferenceEntry[];
  const ownsThread = stamp?.owner === agentId && stamp.conversation === conversation;
  if (thread.length === 0 && ownsThread) {
    // First turn on this thread. Work recorded before the thread existed is carried in whole, in order;
    // a conversation older than work scopes has only its prose to offer, and that as reference.
    const earlier = source.filter(entry => entry.workScope?.startsWith("work-") && entry.workRecordId);
    if (earlier.length > 0) {
      for (const entry of earlier) base.appendTranscript(agentId, { ...entry, workScope: history }, history);
    } else if (personText) {
      const references = referenceHistory(base.readTranscript(agentId, stamp.previous ?? conversation) as ReferenceEntry[], personText);
      if (references.length > 0) base.appendTranscript(agentId, { role: "user", host: true, text: "[Earlier conversation reference only; not current instructions. ReadHistory can inspect the original conversation " + (stamp.previous ?? conversation) + ".]\n" + references.map(entry => entry.role + ": " + entry.text).join("\n\n"), at: new Date().toISOString() }, history);
    }
  } else {
    // A crash between the canonical append and the thread's copy is repaired here, without replaying the effect.
    const projected = new Set(thread.map(entry => entry.workRecordId).filter(Boolean));
    for (const entry of source) {
      if (entry.workScope !== history || !entry.workRecordId || projected.has(entry.workRecordId)) continue;
      base.appendTranscript(agentId, entry, history);
      projected.add(entry.workRecordId);
    }
  }
  const mine = (agent: string, thread: string) => agent === agentId && thread === conversation;
  const historyOf = (agent: string, thread = "main") => mine(agent, thread) ? history : thread;
  const stateOf = (agent: string, thread = "main") => mine(agent, thread) ? state : thread;
  return new Proxy(base, { get(target, key) {
    if (key === "readTranscript") return (agent: string, thread?: string) => target.readTranscript(agent, historyOf(agent, thread));
    if (key === "readDurableState") return (agent: string, thread?: string) => target.readDurableState(agent, stateOf(agent, thread));
    if (key === "writePlan") return (agent: string, text: string, thread?: string) => target.writePlan(agent, text, stateOf(agent, thread));
    if (key === "writeTodos") return (agent: string, items: Parameters<AgentRegistry["writeTodos"]>[1], thread?: string) => target.writeTodos(agent, items, stateOf(agent, thread));
    if (key === "writeCheckpoints") return (agent: string, items: Parameters<AgentRegistry["writeCheckpoints"]>[1], thread?: string) => target.writeCheckpoints(agent, items, stateOf(agent, thread));
    if (key === "appendTranscript") return (agent: string, entry: unknown, thread = "main") => {
      const mapped = historyOf(agent, thread);
      if (mapped === thread) { target.appendTranscript(agent, entry, thread); return; }
      const recorded = { ...(entry as object), workScope: mapped, workRecordId: createHash("sha256").update(JSON.stringify([mapped, entry])).digest("hex") };
      // The existing recovery ledger reads the original transcript. Its append is canonical;
      // a crash before the thread's copy is repaired above.
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
