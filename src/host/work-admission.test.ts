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

test("historical recovery restores what ingress evidence shows a person sent, holds the rest as unknown, and never runs anything (INV-1808)", async () => {
	const { recoverUserRequests } = await import("./work-recovery.ts");
	const f = fixture();
	try {
		// The protocol the host wrote for an audit, as it was stored until 2026-11-04: a person's stamp, no host stamp.
		const protocol = 'Audit task t1290: "fix the import", which Bob claims is done.\n\nRead their work with ReadHistory and inspect the evidence.';
		const at = (second: number) => `2026-11-10T00:00:${String(second).padStart(2, "0")}Z`;
		const opened = (text: string, id: string, second: number, more: Record<string, unknown> = {}) =>
			f.registry.appendTranscript(f.agent.id, { role: "user", text, at: at(second), causedBy: [id], turnId: `turn-${id}`, ...more } as never);
		opened("Install the skill", "door-install", 0, { fromPerson: true }); // a chat door let it in
		opened(protocol, "old-audit", 1, { fromPerson: true }); // the old stamp, and nothing at the door
		opened("[scheduled] Send the weekly report.", "old-routine", 2, { fromPerson: true }); // from before routines were marked
		opened("[webhook] This turn was started by something calling this routine's URL.", "old-webhook", 3, { fromPerson: true });
		opened("[scheduled] Send the weekly report.", "new-routine", 4); // marked, and heard as a routine
		opened("Create an audit probe", "probe", 5, { fromPerson: true, host: true }); // the host's own stamp wins over the person's
		opened(protocol, "quoted", 6, { fromPerson: true }); // a person pasting the same protocol back, heard as theirs
		opened("Fix the report from last week", "old-web", 7, { fromPerson: true }); // a real request nothing vouches for
		opened("[first run] You were just created by chris and nobody has said anything yet.", "cue", 8, { fromPerson: true }); // heard as the person's before INV-829
		const door = { schema: "lumenbox.message/v1" as const, id: "door-install", channel: "feishu-personal", chatKey: "feishu:chat-1", identity: "ou_chris", senderLabel: "Chris", conversationKey: "feishu:chat-1", receivedAt: at(0), text: "Install the skill\nfrom the attached package", textChars: 42 };
		const heardRows: Record<string, import("../agents/heard-record.ts").HeardRow> = {
			"door-install": { id: "door-install", at: at(0), conversation: "main", speaker: { by: "person", principal: "chris" }, asked: true },
			"new-routine": { id: "new-routine", at: at(4), conversation: "main", speaker: { by: "routine" }, asked: true },
			quoted: { id: "quoted", at: at(6), conversation: "main", speaker: { by: "person", principal: "chris" }, asked: true },
			cue: { id: "cue", at: at(8), conversation: "main", speaker: { by: "person", principal: "chris" }, asked: true },
		};
		const evidence = { door: (id: string) => (id === door.id ? door : undefined), heard: (_agent: string, id: string) => heardRows[id] };

		// The old stamp proves nothing by itself: with no evidence, nothing is a person's request.
		const blind = recoverUserRequests(f.registry, f.tasks, f.agent.id);
		assert.deepEqual(blind.requests, []);
		assert.ok(blind.unknown.some(row => row.source === "door-install") && !blind.unknown.some(row => row.source === "probe"));

		const preview = recoverUserRequests(f.registry, f.tasks, f.agent.id, { evidence });
		assert.deepEqual(preview.requests.map(row => [row.source, row.evidence]), [["door-install", "door"], ["quoted", "heard"]], "what a person sent, including their quote of the host's own protocol");
		assert.deepEqual(preview.unknown.map(row => row.source).sort(), ["cue", "old-audit", "old-routine", "old-web", "old-webhook"], "a stamp with no evidence is unknown, whatever the text reads like");
		assert.equal(preview.unknown.find(row => row.source === "old-audit")!.reads, "host", "what it reads like is a note for the person deciding");
		assert.equal(f.tasks.list().length, 0, "a preview writes nothing");

		const result = recoverUserRequests(f.registry, f.tasks, f.agent.id, { apply: true, evidence });
		assert.equal(result.requests.length, 2);
		assert.equal(recoverUserRequests(f.registry, f.tasks, f.agent.id, { apply: true, evidence }).requests.length, 0, "a second run restores nothing twice");
		assert.equal(f.tasks.list().length, 2, "no host prompt and no unknown became a request");
		const task = f.tasks.list().find(row => row.sourceMessageId === "door-install")!;
		assert.equal(task.description, door.text, "the words are the door's copy, whole");
		assert.deepEqual([task.requester, task.workRoot!.state.principal, task.conversation, task.workRoot!.historical!.epoch], ["chris", "chris", "main", 0]);
		assert.deepEqual([task.workRoot!.historical!.channel, task.workRoot!.historical!.chatKey, task.workRoot!.historical!.identity], ["feishu-personal", "feishu:chat-1", "ou_chris"], "the door it came through is kept, not replaced by the web");
		assert.equal(task.workRoot!.state.unresolved, true);
		assert.equal(task.progress, undefined, "the turn's tool steps are not attributed to it");
		assert.equal(f.tasks.list().find(row => row.sourceMessageId === "quoted")!.description, protocol);

		// A person vouches for one unknown entry by name. That is recorded; the others stay unknown.
		assert.throws(() => recoverUserRequests(f.registry, f.tasks, f.agent.id, { apply: true, evidence, confirm: { sources: ["old-web"], by: " " } }), /name of the person/);
		const vouched = recoverUserRequests(f.registry, f.tasks, f.agent.id, { apply: true, evidence, confirm: { sources: ["old-web", "no-such-source"], by: "chris" } });
		assert.deepEqual(vouched.requests.map(row => [row.source, row.evidence, row.confirmedBy]), [["old-web", "confirmed", "chris"]]);
		assert.deepEqual(vouched.unmatched, ["no-such-source"]);
		const confirmedTask = f.tasks.list().find(row => row.sourceMessageId === "old-web")!;
		assert.equal(confirmedTask.workRoot!.historical!.confirmedBy, "chris");
		assert.ok(confirmedTask.workRoot!.historical!.confirmedAt);
		assert.equal(confirmedTask.workRoot!.state.principal, undefined, "who asked is still not known, and is not made up");
		assert.equal(f.tasks.list().length, 3);
		assert.equal(f.inbox.pending().length, 0, "migration is not execution");
		f.reopen();
		assert.equal(f.focus.valid(f.focus.byId("door-install")!, f.agent.id), false);
		assert.equal(f.tasks.list().find(row => row.sourceMessageId === "old-web")!.workRoot!.historical!.confirmedBy, "chris", "the confirmation survives a restart");
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
