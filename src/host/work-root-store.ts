/** Durable root ownership lives on task snapshots; focus is a projection, not another task store. */
import { createHash } from "node:crypto";
import { redactText } from "./secret-redaction.ts";
import type { InboundMessage } from "../agents/admitted-message.ts";
import {personMessage,type WorkAttention} from "../agents/work-attention.ts";
import type { Task, TaskStore } from "./tasks.ts";
import type {
	CancelledWork,
	CurrentWork,
	RootPersistence,
} from "../agents/work-attention.ts";
export interface RootRequest {
	id: string;
	hash: string;
	relation: "new" | "continue" | "explicit";
	state: "prepared" | "queued" | "started";
	admission?: number;
	selectionTaskId?: string;
}
export interface TaskWorkRoot {
	state: CurrentWork;
	cancellation?: CancelledWork;
	automatic?: true;
	requests?: RootRequest[];
	historical?: { epoch: number; turnId?: string; sourceIds: string[] };
}
export class TaskWorkRoots implements RootPersistence {
	private readonly written = new Map<string, string>();
	constructor(
		private readonly tasks: () => readonly Task[],
		private readonly create: TaskStore["create"],
		private readonly write: (task: Task) => void,
	) {}
  admission(focus:WorkAttention) {
    return {
      prepare:(agent:string,message:InboundMessage)=>personMessage(message)?this.prepare(agent,message,focus):{message},
      committed:(message:InboundMessage,seq:number|undefined)=>{if(personMessage(message))this.committed(message,seq);},
    };
  }

	load(legacy?: { records: CurrentWork[]; cancellations: CancelledWork[] }) {
		const recordsWithRevocations=[...legacy?.records??[],...(legacy?.cancellations??[]).filter(row=>!legacy?.records.some(state=>state.id===row.id)).map(row=>({...row,status:"cancelled" as const,unresolved:true as const,messages:row.sourceMessages??[row.id],peers:row.participants.filter(id=>id!==row.owner),awaiting:[]}))];
    for (const state of recordsWithRevocations) {
      const recorded=this.tasks().find(task=>task.workRoot?.state.id===state.id);
      if(recorded){
        const cancelled=legacy?.cancellations.find(row=>row.id===state.id);
        if(cancelled && !recorded.workRoot!.cancellation)this.write({...recorded,workRoot:{...recorded.workRoot!,state:{...recorded.workRoot!.state,status:"cancelled"},cancellation:cancelled}});
        continue;
      }
			const task = this.tasks().find(
				(task) =>
					task.id === state.taskId &&
					task.assigneeId === state.owner &&
					(task.conversation ?? "main") === state.conversation &&
					!task.workRoot,
			);
			const cancellation = legacy?.cancellations.find(
				(row) => row.id === state.id,
			);
			if (task) this.write({ ...task, workRoot: { state, cancellation } });
			else
				this.create({
					title: "Recovered work: " + state.id,
					requester: "host",
					assigneeId: state.owner,
					conversation: state.conversation,
					origin: { kind: "internal", workId: state.id },
					durable: true,
					workRoot: { state: { ...state, unresolved: true }, cancellation },
				});
		}
		const records: CurrentWork[] = [],
			cancellations: CancelledWork[] = [];
		for (const task of this.tasks())
			if (task.workRoot) {
				records.push(task.workRoot.state);
				if (task.workRoot.cancellation)
					cancellations.push(task.workRoot.cancellation);
				this.written.set(task.id, JSON.stringify(task.workRoot));
			}
		return { records, cancellations };
	}
	save(
		records: readonly CurrentWork[],
		cancellations: readonly CancelledWork[],
	) {
		const tasks = new Map(this.tasks().map((task) => [task.id, task]));
		const revoked = new Map(cancellations.map((row) => [row.id, row]));
		for (const state of records) {
			let task = state.taskId ? tasks.get(state.taskId) : undefined;
			if (!task) {
				task = this.create({
					title: "Host work: " + state.id,
					requester: "host",
					assigneeId: state.owner,
					conversation: state.conversation,
					origin: { kind: "internal", workId: state.id },
					durable: true,
					workRoot: { state, cancellation: revoked.get(state.id) },
				});
				if (!task) throw new Error("Work root could not be persisted");
				state.taskId = task.id;
				tasks.set(task.id, task);
			}
			state.principal ??= task.requester;
			if (task.workRoot && task.workRoot.state.id !== state.id)
				throw new Error("A task already has another work root");
			const workRoot: TaskWorkRoot = {
				...task.workRoot,
				state,
				...(revoked.has(state.id)
					? { cancellation: revoked.get(state.id)! }
					: {}),
			};
			const value = JSON.stringify(workRoot);
			if (this.written.get(task.id) === value) continue;
			this.write({ ...task, workRoot: structuredClone(workRoot) });
			this.written.set(task.id, value);
		}
	}
	prepare(
		agentId: string,
		message: InboundMessage,
		focus: WorkAttention,
	): { message: InboundMessage; duplicate?: boolean; admission?: number } {
		const conversation = message.conversation ?? "main",
			tasks = this.tasks();
		const hash = createHash("sha256")
			.update(
				JSON.stringify([
					agentId,
					conversation,
					message.principalId ?? "web",
					message.text,
					message.workRelation ?? null,
				]),
			)
			.digest("hex");
		for (const task of tasks) {
			const request = task.workRoot?.requests?.find(
				(row) => row.id === message.id,
			);
			if (!request) continue;
			if (request.hash !== hash)
				throw new Error(
					"An admitted message id cannot identify different content or authority",
				);
			const state = task.workRoot!.state;
			if (focus.cancelled(state.id))
				throw new Error(
					"This work was cancelled; begin a new request explicitly",
				);
			if(request.state==="prepared")this.focus(state,focus);
			return {
				message: {
					...message,
					work: state,
					taskBinding: {
						taskId: request.selectionTaskId ?? task.id,
						role: "executor",
					},
				},
				duplicate: request.state !== "prepared",
				admission: request.admission,
			};
		}
		const selected = message.taskBinding
			? tasks.find((row) => row.id === message.taskBinding!.taskId)
			: tasks.find((row) => row.sourceMessageId === message.id);
		if (
			message.taskBinding &&
			(!selected ||
				selected.assigneeId !== agentId ||
				(selected.conversation ?? "main") !== conversation ||
				selected.proposedBy)
		)
			throw new Error(
				"The selected task is not admitted to this execution context",
			);
		const explicit = message.work
			? focus.byId(message.work.id)
			: selected?.workRoot?.state;
		if (message.work && (!explicit || !focus.valid(message.work, agentId)))
			throw new Error("The explicitly continued work is not executable");
		if (
			selected?.sourceMessageId === message.id &&
			(selected.status === "done" || selected.status === "dropped")
		)
			return { message, duplicate: true };
		if (
			selected?.workRoot?.historical &&
			selected.sourceMessageId === message.id
		)
			return { message, duplicate: true };
		const previous = focus.get(agentId, conversation);
		const continuing =
			explicit && focus.valid(explicit, agentId)
				? explicit
				: !selected &&
						message.workRelation !== "new" &&
						message.steerable !== false &&
						previous &&
						focus.valid(previous, agentId) &&
						(previous.principal ?? "web") === (message.principalId ?? "web")
					? previous
					: undefined;
		if (message.workRelation === "continue" && !continuing)
			throw new Error(
				"There is no live work to continue; select new work explicitly",
			);
		const rootId =
			continuing?.id ??
			selected?.workRoot?.state.id ??
			selected?.pursuit?.workId ??
			message.id;
		if (focus.cancelled(rootId) || selected?.mandate?.withdrawn)
			throw new Error(
				"This work was cancelled; begin a new request explicitly",
			);
		const state: CurrentWork = continuing
			? {
					...continuing,
					status: "waiting",
					messages: [...new Set([...continuing.messages, message.id])].slice(
						-128,
					),
				}
			: {
					id: rootId,
					owner: agentId,
					conversation,
					generation:
						Math.max(
							focus.generation(agentId, conversation),
							selected?.workRoot?.state.generation ?? 0,
						) + 1,
					epoch: focus.epoch(agentId, conversation),
					isolated: !selected?.pursuit,
					principal: message.principalId ?? "web",
					status: "waiting",
					reason: "queued",wait:"queue",
					messages: [message.id],
					peers: [],
					awaiting: [],
				};
		if (state.owner !== agentId || state.conversation !== conversation)
			throw new Error(
				"A human request cannot assume another work owner's authority",
			);
		let task = tasks.find((row) => row.id === continuing?.taskId) ?? selected;
		const request: RootRequest = {
			id: message.id,
			hash,
			relation: continuing ? "continue" : task ? "explicit" : "new",
			state: "prepared",
			...(selected ? { selectionTaskId: selected.id } : {}),
		};
		const workRoot: TaskWorkRoot = {
			state,
			requests: [...(task?.workRoot?.requests ?? []), request],
			...(task?.workRoot?.automatic ||
			(task?.sourceMessageId === message.id && !task.pursuit)
				? { automatic: true }
				: {}),
		};
		if (!task) {
			workRoot.automatic = true;
			task = this.create({
				title:
					redactText(message.text.trim().split("\n")[0]!).slice(0, 180) ||
					"User request",
				description: redactText(message.text),
				requester: message.principalId ?? "web",
				sourceMessageId: message.id,
				assigneeId: agentId,
				conversation,
				origin: { kind: "user", workId: state.id },
				durable: true,
				workRoot,
			});
		} else {
			state.taskId = task.id;
			this.write({ ...task, workRoot: structuredClone(workRoot) });
		}
		if (!task) throw new Error("The user request could not be recorded");
		const recorded = this.tasks().find((row) => row.id === task!.id)!.workRoot!
			.state;
		this.focus(recorded,focus);
		return {
			message: {
				...message,
				...(!continuing && previous ? { steerable: false } : {}),
				work: recorded,
				taskBinding: { taskId: selected?.id ?? task.id, role: "executor" },
			},
		};
	}
  private focus(state:CurrentWork,focus:WorkAttention):void {
    const previous=focus.get(state.owner,state.conversation);
    if(previous && previous.id!==state.id && state.generation>=previous.generation && focus.valid(previous,previous.owner))focus.settle(previous,"waiting","focus moved to another request","focus");
    focus.project(state);
  }

	recover(
		agentId: string,
		record: {
			source: string;
			conversation: string;
			epoch: number;
			turnId?: string;
			text: string;
			sourceIds: string[];
		},
	) {
		const existing = this.tasks().find(
			(task) =>
				task.sourceMessageId === record.source ||
				(task.workRoot?.state.id === record.source &&
					task.assigneeId === agentId &&
					(task.conversation ?? "main") === record.conversation),
		);
		if (existing?.workRoot && !existing.workRoot.state.unresolved)
			return existing;
		const state: CurrentWork = {
			id: record.source,
			owner: agentId,
			conversation: record.conversation,
			generation: 0,
			epoch: record.epoch,
			principal: "web",
			status: "waiting",
			reason: "Historical request; execution and completion unverified",
			messages: record.sourceIds,
			peers: [],
			awaiting: [],
			unresolved: true,
		};
		const workRoot: TaskWorkRoot = {
			...existing?.workRoot,
			state,
			automatic: true,
			historical: {
				epoch: record.epoch,
				turnId: record.turnId,
				sourceIds: record.sourceIds,
			},
		};
		const title =
			record.text.split("\n")[0]!.slice(0, 180) || "Historical user request";
		if (!existing)
			return this.create({
				title,
				description: record.text,
				requester: "web",
				sourceMessageId: record.source,
				assigneeId: agentId,
				conversation: record.conversation,
				origin: { kind: "user", workId: record.source },
				durable: true,
				workRoot,
			});
		state.taskId = existing.id;
		this.write({
			...existing,
			title,
			description: record.text,
			sourceMessageId: record.source,
			origin: { kind: "user", workId: record.source },
			workRoot,
		});
		return this.tasks().find((task) => task.id === existing.id);
	}
	committed(message: InboundMessage, admission: number | undefined) {
		const task = this.tasks().find((row) => row.id === message.work?.taskId);
		if (!task?.workRoot) return;
		this.write({
			...task,
			workRoot: {
				...task.workRoot,
				requests: task.workRoot.requests?.map((row) =>
					row.id === message.id ? { ...row, state: "queued", admission } : row,
				),
			},
		});
	}
	started(ids: readonly string[]) {
		const wanted = new Set(ids);
		for (const task of this.tasks())
			if (
				task.workRoot?.requests?.some(
					(row) => wanted.has(row.id) && row.state !== "started",
				)
			)
				this.write({
					...task,
					workRoot: {
						...task.workRoot,
						requests: task.workRoot.requests.map((row) =>
							wanted.has(row.id) ? { ...row, state: "started" } : row,
						),
					},
				});
	}
}

/** Execution is distinct from business acceptance; all read faces share this projection. */
export function workRootSummary(task: Pick<Task, "workRoot">) {
	const root = task.workRoot;
	if (!root) return undefined;
	const { state } = root;
	const phase = root.cancellation ? "cancelled" : state.unresolved ? "unresolved" : state.status==="waiting" ? state.wait==="queue" ? "queued" : state.wait==="interrupted" ? "interrupted" : "waiting" : state.status;
	return {
		id: state.id,
		taskId: state.taskId,
		phase,
		reason: state.reason,
		generation: state.generation,
		epoch: state.epoch,
		automatic: root.automatic === true,
	};
}
