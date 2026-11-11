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

test("superseded roots remain queryable and revocable after restart without reviving late callbacks", () => {
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
