import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, mkdirSync,writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentBus, type InboundMessage } from "../agents/bus.ts";
import { AgentRegistry } from "../agents/registry.ts";
import { Inbox } from "../agents/inbox.ts";
import { WorkAttention } from "../agents/work-attention.ts";
import { TaskStore } from "./tasks.ts";
import { admitProgressMessage } from "./progress-admission.ts";
import { currentTaskOf } from "./autonomy-level.ts";
import { admittedTaskBinding } from "./execution-binding.ts";

const human = (id: string): InboundMessage => ({
	id,
	fromId: "user",
	fromName: "Chris",
	principalId: "p",
	text: "Install the skill",
	priority: false,
	receivedAt: new Date().toISOString(),
});
function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "work-admission-"));
	const registry = new AgentRegistry(join(dir, "agents")),
		agent = registry.create({ name: "Mia" });
	const path = join(dir, "tasks.jsonl"),
		inbox = new Inbox<InboundMessage>(join(dir, "inbox.jsonl"));
	let tasks = new TaskStore(path),
		focus = new WorkAttention(undefined, () => 0, tasks.workRoots);
	const bus = (
		run: (
			messages: readonly InboundMessage[],
		) => Promise<void> = async () => {},
	) =>
		new AgentBus(
			registry,
			async (_a, m) => run(m),
			() => {},
			inbox,
			false,
			(id, m) => admitProgressMessage(tasks, id, m),
			focus,
			tasks.workRoots.admission(focus),
		);
	return {
		dir,
		registry,
		agent,
		path,
		inbox,
		bus,
		get tasks() {
			return tasks;
		},
		get focus() {
			return focus;
		},
		reopen() {
			tasks = new TaskStore(path);
			focus = new WorkAttention(undefined, () => 0, tasks.workRoots);
		},
		cleanup() {
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

test("accepted requests have one durable task and work identity before execution; retries do not run twice", async () => {
	const f = fixture();
	try {
		const bus = f.bus();
		bus.sendFromUser(f.agent.id, "Install the skill", {
			messageId: "install",
			principalId: "p",
		});
		const task = f.tasks.list()[0]!;
		assert.equal(task.sourceMessageId, "install");
		assert.equal(task.workRoot?.state.id, "install");
		assert.equal(task.workRoot?.requests?.[0]?.state, "queued");
		assert.equal(
			f.inbox.pending()[0]!.message.taskBinding?.progressAdmission?.rootWorkId,
			"install",
		);
		assert.equal(f.inbox.pending()[0]!.message.taskBinding?.taskId, task.id);
		f.reopen();
		assert.equal(f.focus.get(f.agent.id, "main")!.taskId, task.id);
		let runs = 0;
		const recovered = f.bus(async (messages) => {
			runs++;
			assert.equal(messages[0]!.work?.id, "install");
		});
		assert.equal(recovered.recover(), 1);
		await recovered.idle();
		recovered.sendFromUser(f.agent.id, "Install the skill", {
			messageId: "install",
			principalId: "p",
		});
		await recovered.idle();
		assert.equal(runs, 1);
		assert.equal(f.tasks.list().length, 1);
    f.reopen();
    assert.equal(f.focus.byId("install")!.wait,"interrupted");
    assert.equal(f.tasks.list()[0]!.workRoot!.state.wait,"interrupted","the list and recovery read the same persisted interruption");
    assert.equal(f.inbox.pending().length,0,"a started effect is never re-enqueued by root recovery");
		assert.throws(
			() =>
				recovered.sendFromUser(f.agent.id, "Other contents", {
					messageId: "install",
					principalId: "p",
				}),
			/different content/,
		);
	} finally {
		f.cleanup();
	}
});

test("task tools and execution agree; an unrelated doing task cannot be selected by conversation", () => {
	const f = fixture();
	try {
		const old = f.tasks.create({
			title: "Old audit",
			requester: f.agent.id,
			assigneeId: f.agent.id,
			conversation: "main",
		})!;
		f.tasks.update(old.id, { status: "doing" }, f.agent.id);
		const bus = f.bus();
		bus.sendFromUser(f.agent.id, "Install the skill", {
			messageId: "install",
			principalId: "p",
		});
		const message = f.inbox.pending()[0]!.message;
		const binding = admittedTaskBinding({
			agentId: f.agent.id,
			conversation: "main",
			inbound: [message],
			tasks: f.tasks,
		});
		assert.ok(binding);
		assert.notEqual(binding.taskId, old.id);
		assert.equal(
			currentTaskOf({ agent: f.agent, tasks: f.tasks, taskBinding: binding })!
				.id,
			binding.taskId,
		);
		assert.equal(currentTaskOf({ agent: f.agent, tasks: f.tasks }), undefined);
	} finally {
		f.cleanup();
	}
});

test("admission and transition write failures fail closed, and a prepared request is retryable", () => {
	const f = fixture();
	try {
		mkdirSync(f.path);
		const bus = f.bus();
		assert.throws(() =>
			bus.sendFromUser(f.agent.id, "Install the skill", {
				messageId: "install",
				principalId: "p",
			}),
		);
		assert.equal(f.tasks.list().length, 0);
		assert.equal(f.inbox.pending().length, 0);
		assert.equal(f.focus.all().length, 0);
		rmSync(f.path, { recursive: true });
		bus.sendFromUser(f.agent.id, "Install the skill", {
			messageId: "install",
			principalId: "p",
		});
		const work = f.focus.get(f.agent.id, "main")!;
		rmSync(f.path);
		mkdirSync(f.path);
		assert.throws(() => f.focus.settle(work, "running"));
		assert.equal(
			f.focus.byId(work.id)!.status,
			"waiting",
			"memory cannot grant authority that failed to persist",
		);
	} finally {
		f.cleanup();
	}
});

test("superseded roots remain queryable and revocable after restart without reviving late callbacks", async () => {
	const f = fixture();
	try {
		const bus = f.bus();
		bus.sendFromUser(f.agent.id, "Install the skill", {
			messageId: "install",
			principalId: "p",
		});
		const old = f.focus.get(f.agent.id, "main")!;
		bus.sendFromUser(f.agent.id, "Different work", {
			messageId: "next",
			principalId: "p",
			workRelation: "new",
		});
    assert.equal(f.focus.get(f.agent.id,"main")!.id,"install","queueing does not steal execution custody");
    await bus.wake(f.agent.id);await bus.idle();
		assert.equal(f.focus.get(f.agent.id, "main")!.id, "next");
		assert.equal(f.focus.valid(old, f.agent.id), false);
		f.reopen();
		assert.equal(f.focus.byId("install")!.taskId, old.taskId);
		f.focus.cancel(old, "p", "Stop historical work");
		f.reopen();
		assert.ok(f.focus.cancelled("install"));
		assert.equal(f.focus.get(f.agent.id, "main")!.id, "next");
		assert.throws(
			() =>
				f
					.bus()
					.sendFromUser(f.agent.id, "Install the skill", {
						messageId: "install",
						principalId: "p",
					}),
			/cancelled/,
		);
	} finally {
		f.cleanup();
	}
});

test("a crash after inbox admission but before the receipt retries the same root and progress reservation", async () => {
	const f = fixture();
	try {
		const bus = f.bus(),
			committed = f.tasks.workRoots.committed.bind(f.tasks.workRoots);
		f.tasks.workRoots.committed = () => {
			throw new Error("interrupted receipt");
		};
		assert.throws(
			() =>
				bus.sendFromUser(f.agent.id, "Install the skill", {
					messageId: "install",
					principalId: "p",
				}),
			/interrupted receipt/,
		);
		assert.equal(f.tasks.list().length, 1);
		assert.equal(f.inbox.pending().length, 1);
		const reserved =
			f.inbox.pending()[0]!.message.taskBinding?.progressAdmission?.id;
		f.tasks.workRoots.committed = committed;
		let runs = 0;
		const retried = f.bus(async (messages) => {
			runs++;
			assert.equal(messages[0]!.taskBinding?.progressAdmission?.id, reserved);
		});
		retried.sendFromUser(f.agent.id, "Install the skill", {
			messageId: "install",
			principalId: "p",
		});
		await retried.wake(f.agent.id);
		await retried.idle();
		assert.equal(runs, 1);
		assert.equal(f.tasks.list().length, 1);
	} finally {
		f.cleanup();
	}
});

test("historical recovery uses human provenance, is idempotent, and never assigns a mixed turn's tool calls", async () => {
	const { recoverUserRequests } = await import("./work-recovery.ts");
	const f = fixture();
	try {
		f.registry.appendTranscript(f.agent.id, {
			role: "user",
			fromPerson: true,
			text: "Install the skill",
			at: "2026-11-10T00:00:00Z",
			causedBy: ["lost-install"],
			turnId: "mixed-old-turn",
		});
		f.registry.appendTranscript(f.agent.id, {
			role: "user",
			host: true,
			fromPerson: true,
			text: "Create an audit probe",
			causedBy: ["probe"],
			at: "2026-11-10T00:00:01Z",
		});
		const preview = recoverUserRequests(f.registry, f.tasks, f.agent.id);
		assert.equal(preview.requests.length, 1);
		assert.equal(f.tasks.list().length, 0);
		const result = recoverUserRequests(f.registry, f.tasks, f.agent.id, true);
		assert.equal(result.requests.length, 1);
		assert.equal(
			recoverUserRequests(f.registry, f.tasks, f.agent.id, true).requests
				.length,
			0,
		);
		const task = f.tasks.list()[0]!;
		assert.equal(task.title, "Install the skill");
		assert.equal(task.sourceMessageId, "lost-install");
		assert.equal(task.workRoot?.state.unresolved, true);
		assert.equal(task.progress, undefined);
		assert.equal(f.inbox.pending().length, 0, "migration is not execution");
		f.reopen();
		assert.equal(
			f.focus.valid(f.focus.byId("lost-install")!, f.agent.id),
			false,
		);
	} finally {
		f.cleanup();
	}
});


test("legacy revocations survive migration even after the old focus file is removed",()=>{
 const f=fixture();try {
  const path=join(f.dir,"legacy-focus.json");
  writeFileSync(path,JSON.stringify({schema:1,records:[],cancellations:[{id:"revoked",owner:f.agent.id,conversation:"main",generation:1,epoch:0,by:"p",at:new Date().toISOString(),reason:"Stop",participants:[f.agent.id],resources:[]}]}));
  const focus=new WorkAttention(path,()=>0,f.tasks.workRoots);
  assert.ok(focus.cancelled("revoked"));rmSync(path);
  f.reopen();assert.ok(f.focus.cancelled("revoked"));
  assert.equal(f.focus.byId("revoked")!.status,"cancelled");
 }finally{f.cleanup();}
});

test("a cancellation committed before queue cleanup cannot block recovery of another user request",async()=>{
 const f=fixture();try{
  const bus=f.bus();bus.sendFromUser(f.agent.id,"Install the skill",{messageId:"cancelled",principalId:"p"});
  f.focus.cancel(f.focus.byId("cancelled")!,"p","Stop before crash");
  bus.sendFromUser(f.agent.id,"Other work",{messageId:"other",principalId:"p",workRelation:"new"});
  f.reopen();const ran:string[]=[];const recovered=f.bus(async messages=>{ran.push(messages[0]!.id);});
  assert.equal(recovered.recover(),1);await recovered.idle();
  assert.deepEqual(ran,["other"]);assert.equal(f.inbox.pending().length,0);
 }finally{f.cleanup();}
});

test("a corrupt root is set aside at load: it grants no execution authority and the others still load (INV-1822)", () => {
  const f = fixture();
  try {
    const bus = f.bus();
    bus.sendFromUser(f.agent.id, "Install the skill", { messageId: "install", principalId: "p" });
    bus.sendFromUser(f.agent.id, "Other work", { messageId: "other", principalId: "p", workRelation: "new" });
    const data = f.tasks.workRoots.load();
    const corrupt = data.records.find(row => row.id === "install")!;
    corrupt.status = "not-a-state" as never;
    const lines: string[] = [];
    const focus = new WorkAttention(undefined, () => 0, { load: () => data, save: () => {} }, line => lines.push(line));
    assert.equal(focus.byId("install"), undefined, "nothing can execute under the corrupt record");
    assert.ok(focus.byId("other"), "a sound record is unaffected");
    assert.deepEqual(focus.rejected().map(row => row.id), ["install"]);
    assert.throws(() => focus.project(corrupt), /set aside/, "a retried request cannot project it back");
    assert.match(lines.join("\n"), /install/);
  } finally {
    f.cleanup();
  }
});

test("a damaged cancellation still revokes its work (INV-1822)", () => {
  const damaged = { id: "stopped", owner: "a", conversation: "main", generation: 1, epoch: 0, sourceMessages: ["m1"] } as never;
  const focus = new WorkAttention(undefined, () => 0, { load: () => ({ records: [], cancellations: [damaged] }), save: () => {} });
  assert.ok(focus.cancelled("stopped"), "a stopped piece of work does not start again because its record was damaged");
  assert.equal(focus.cancelledMessage({ id: "m1", fromId: "user", fromName: "p", text: "again", priority: false, receivedAt: "" }), true, "nor does the message that asked for it");
  assert.equal(focus.rejected().length, 1);
});

test("two accepted people or new requests in one conversation are both executed instead of dropping the first as stale",async()=>{
 const f=fixture();try {
  const ran:{id:string;work:string;principal:string}[]=[];
  const bus=f.bus(async messages=>{ran.push({id:messages[0]!.id,work:messages[0]!.work!.id,principal:messages[0]!.principalId!});});
  bus.sendFromUser(f.agent.id,"First request",{messageId:"first",principalId:"p"});
  bus.sendFromUser(f.agent.id,"Second request",{messageId:"second",principalId:"p2"});
  await bus.wake(f.agent.id);await bus.idle();
  assert.deepEqual(ran,[{id:"first",work:"first",principal:"p"},{id:"second",work:"second",principal:"p2"}]);
  assert.equal(f.tasks.list().length,2);
 }finally{f.cleanup();}
});

test("explicit continuation cannot acknowledge a request under another person's execution authority",()=>{
 const f=fixture();try {
  const bus=f.bus();bus.sendFromUser(f.agent.id,"First request",{messageId:"first",principalId:"p"});
  const task=f.tasks.list()[0]!;
  assert.throws(()=>bus.sendFromUser(f.agent.id,"My follow-up",{messageId:"foreign",principalId:"other",taskBinding:{taskId:task.id,role:"executor"}}),/another principal/);
  assert.equal(f.inbox.pending().length,1);
 }finally{f.cleanup();}
});
