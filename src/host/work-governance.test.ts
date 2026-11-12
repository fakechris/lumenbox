import { AgentRegistry } from "../agents/registry.ts";
import { readPause, clearPause } from "../agents/pause.ts";
import { AgentPauses } from "./agent-pause.ts";
import { Orchestrator } from "./orchestrator.ts";
import { fakeModel } from "./testing/fake-model.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GovernanceLedger,
  WorkGovernance,
  resourceKey,
  routineResource,
  type GovernedResource,
  type GovernanceAdapter,
} from "./work-governance.ts";
import { Scheduler, parseSchedule } from "./schedule.ts";
import type { InboundMessage } from "../agents/admitted-message.ts";
import { PendingWork } from "./pending-work.ts";
import { Effects } from "./effects.ts";

const row = (
  key: string,
  extras: Partial<GovernedResource> = {},
): GovernedResource => ({
  key,
  kind: "message",
  title: "Install the requested skill",
  section: "future",
  state: "queued",
  source: "unknown",
  version: "original",
  scope: "messageOnly",
  actions: ["stop"],
  unknown: ["otherMessagesRemain"],
  target: { id: "old-message" },
  ...extras,
});
const message = (id: string): InboundMessage => ({
  id,
  fromId: "user",
  fromName: "person",
  text: "Install",
  priority: false,
  receivedAt: "now",
});
const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), "work-governance-")),
    path = join(dir, "work-governance.jsonl"),
    ledger = new GovernanceLedger(path);
  return {
    dir,
    path,
    ledger,
    service: new WorkGovernance(ledger),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

test("batch revocation precedes every cleanup; restart and a late message cannot revive stopped resources or stop unrelated work", async () => {
  const f = fixture();
  try {
    const first = row(resourceKey("message", "old-message")),
      second = row(resourceKey("recovery", "old-attempt"), {
        kind: "recovery",
      });
    const effects: string[] = [];
    let fail = true;
    const adapter: GovernanceAdapter = {
      inventory: async () => ({ rows: [first, second], unknown: [] }),
      mayRead: () => true,
      apply: async (resource) => {
        const restart = new GovernanceLedger(f.path);
        assert.equal(
          restart.allows(message("old-message")),
          false,
          "the entire selection must be barred before any cleanup",
        );
        assert.equal(
          restart.allows({
            ...message("resume"),
            resumeOf: { id: "old-attempt", attempt: 2 },
          }),
          false,
        );
        assert.equal(restart.allows(message("unrelated")), true);
        effects.push(resource.key);
        if (resource.key === second.key && fail)
          throw Error("External stop unconfirmed");
        return { confirmed: true };
      },
    };
    const preview = await f.service.preview(adapter, [
      { key: first.key, action: "stop" },
      { key: second.key, action: "stop" },
    ]);
    const initial = await f.service.execute(
      adapter,
      { token: preview.token, operationId: "operation-1" },
      "operator",
    );
    assert.deepEqual(
      initial.results.map((result) => result.state),
      ["confirmed", "unconfirmed"],
    );
    const restart = new GovernanceLedger(f.path),
      service = new WorkGovernance(restart);
    assert.equal(restart.allows(message("old-message")), false);
    assert.equal(restart.allows(message("unrelated")), true);
    assert.equal(service.operation(adapter, "operation-1", "operator").results.filter(row=>row.state!=="confirmed").length,1);
    assert.throws(()=>service.operation({...adapter,mayRead:()=>false}, "operation-1", "operator"),/unavailable/);
    assert.equal(restart.pendingOperations().length,1);
    fail = false;
    await service.execute(
      adapter,
      { token: "expired-process-token", operationId: "operation-1" },
      "operator",
    );
    assert.deepEqual(
      effects,
      [first.key, second.key, second.key],
      "retry performs only the unconfirmed resource",
    );
    await service.execute(
      adapter,
      { token: "", operationId: "operation-1" },
      "operator",
    );
    assert.equal(effects.length, 3);
  } finally {
    f.cleanup();
  }
});

test("preview rejects stale, denied or expanded selections without revoking any resource", async () => {
  const f = fixture();
  try {
    let resource = row(resourceKey("message", "old-message")),
      permitted = true;
    const adapter: GovernanceAdapter = {
      inventory: async () => ({ rows: [resource], unknown: [] }),
      mayRead: () => permitted,
      apply: async () => {
        throw Error("must not run");
      },
    };
    const preview = await f.service.preview(adapter, [
      { key: resource.key, action: "stop" },
    ]);
    resource = { ...resource, version: "new owner" };
    await assert.rejects(
      f.service.execute(
        adapter,
        { token: preview.token, operationId: "operation-2" },
        "operator",
      ),
      /changed/,
    );
    assert.equal(f.ledger.revoked(resource.key), undefined);
    permitted = false;
    await assert.rejects(
      f.service.preview(adapter, [{ key: resource.key, action: "stop" }]),
      /unavailable/,
    );
    assert.equal(f.ledger.operation("operation-2"), undefined);
  } finally {
    f.cleanup();
  }
});

test("zero physical executions can coexist with future entries; archives and access filtering precede the 50-record page", async () => {
  const ledger = new GovernanceLedger(),
    service = new WorkGovernance(ledger);
  const records = Array.from({ length: 1601 }, (_, n) =>
    row("old-" + n, {
      title: n === 0 ? "Completed internal root" : "Historical work " + n,
      ...(n === 0 ? {state:"answered",archived:true} : {}),
      kind: "record",
      section: "history",
      actions: [],
    }),
  );
  const rows = [
    row("private", { title: "PRIVATE", section: "future" }),
    row("timer", { kind: "routine" }),
    ...records,
  ];
  const adapter: GovernanceAdapter = {
    inventory: async () => ({ rows, unknown: ["offlineBoxUnknown"] }),
    mayRead: (resource) => resource.key !== "private",
    apply: async () => ({ confirmed: true }),
  };
  const page = await service.list(adapter, { section: "history", limit: 500 });
  assert.equal(page.total, 1600);
  assert.equal(page.rows.length, 50);
  assert.equal(page.metrics.executions, 0);
  assert.equal(page.metrics.future, 1);
  assert.doesNotMatch(JSON.stringify(page), /PRIVATE/);
  const searched = await service.list(adapter, {
    search: "Historical work 1377",
  });
  assert.equal(searched.total, 1);
  assert.equal(searched.rows[0]!.title, "Historical work 1377");
  const automatic = await service.list(adapter, { section: "automatic" });
  assert.deepEqual(
    automatic.rows.map((resource) => resource.key),
    ["timer"],
  );
});

test("disabling a routine is durable across tick, webhook, listener, manual retry and a racing credential check", async () => {
  const f = fixture();
  try {
    const parsed = parseSchedule("* * * * *");
    assert.ok("schedule" in parsed);
    if (!("schedule" in parsed)) return;
    const skill = {
      slug: "install",
      name: "Requested installation",
      boxId: "box",
      path: "/skills/install",
      schedule: parsed.schedule,
    };
    let entered!: () => void, release!: () => void;
    const checking = new Promise<void>((done) => {
        entered = done;
      }),
      held = new Promise<void>((done) => {
        release = done;
      });
    let runs = 0;
    const scheduler = new Scheduler({
      due: async () => [skill],
      hooked: async () => [skill],
      listeners: async () => [{ ...skill, match: "install" }],
      defaultAgent: () => "worker",
      allowed: (candidate) => !f.ledger.revoked(routineResource(candidate)),
      precheck: async () => {
        entered();
        await held;
        return undefined;
      },
      run: async () => {
        runs++;
      },
      now: () => new Date("2026-11-11T10:00:00Z"),
      path: null,
    });
    const resource = row(routineResource(skill), {
      kind: "routine",
      actions: ["disable"],
    });
    const adapter: GovernanceAdapter = {
      inventory: async () => ({ rows: [resource], unknown: [] }),
      mayRead: () => true,
      apply: async () => ({ confirmed: true }),
    };
    const tick = scheduler.tick();
    await checking;
    const preview = await f.service.preview(adapter, [
      { key: resource.key, action: "disable" },
    ]);
    await f.service.execute(
      adapter,
      { token: preview.token, operationId: "disable-install" },
      "operator",
    );
    release();
    await tick;
    await new Promise((done) => setImmediate(done));
    await scheduler.tick();
    assert.equal((await scheduler.runNow(skill.slug)).ok, false);
    assert.equal(
      (await scheduler.fireWebhook(skill.slug, "install")).ok,
      false,
    );
    assert.deepEqual(
      await scheduler.heard({ text: "install", chatKey: "room" }),
      [],
    );
    assert.equal(runs, 0);
    assert.equal(new GovernanceLedger(f.path).revoked(resource.key), "disable");
  } finally {
    f.cleanup();
  }
});

test("stopping a confirmation callback while it is awaiting a result cannot manufacture a new reminder afterwards", async () => {
  const f = fixture();
  try {
    const pending = new PendingWork(join(f.dir, "pending.jsonl"));
    pending.resourceAllowed = (id) =>
      !f.ledger.revoked(resourceKey("pending", id));
    let release!: (value: { text: string; effects: [] }) => void;
    const result = new Promise<{ text: string; effects: [] }>((done) => {
      release = done;
    });
    const id = pending.prepare({
      agentId: "worker",
      kind: "pause",
      parent: "main",
      child: "mcp__test__resume",
      brief: "Continue installation",
      data: { approvalId: "approval", resumeInput: {} },
    });
    const effects = new Effects({
      pendingWork: pending,
      policy: { pending: () => [], request: () => ({ id: "unused" }) } as never,
      mcp: () => ({ callFromHost: () => result }) as never,
      deliver: () => {
        throw Error("A cancelled callback must not wake the model");
      },
    });
    const settling = effects.settleApproval("approval", "allowed");
    await new Promise((done) => setImmediate(done));
    const resource = row(resourceKey("pending", id), { kind: "pending" });
    const adapter: GovernanceAdapter = {
      inventory: async () => ({ rows: [resource], unknown: [] }),
      mayRead: () => true,
      apply: async () => ({ confirmed: true }),
    };
    const preview = await f.service.preview(adapter, [
      { key: resource.key, action: "stop" },
    ]);
    await f.service.execute(
      adapter,
      { token: preview.token, operationId: "stop-callback" },
      "operator",
    );
    release({ text: "late result", effects: [] });
    await settling;
    assert.equal(pending.open().length, 0);
    assert.equal(
      new PendingWork(join(f.dir, "pending.jsonl"))
        .open()
        .filter((item) => item.kind === "reminder").length,
      0,
    );
  } finally {
    f.cleanup();
  }
});


test("confirmed member pauses never replay after an explicit resume, including a concurrent old-operation retry", async () => {
  const f = fixture(); try {
    const pauses = new AgentPauses({ dirFor: () => f.dir, interrupt: () => [], box: () => undefined, wake() {}, tell: async () => {}, receipt() {}, log() {} });
    const resource = row(resourceKey("member", "worker"), { kind: "member", agentId: "worker", actions: ["pause"] }); let applications = 0;
    const adapter: GovernanceAdapter = { inventory: async () => ({ rows: [resource], unknown: [] }), mayRead: () => true, prepare: selections => { if (selections.length) pauses.barrier(["worker"], "operator", "selected member"); }, apply: async () => { applications++; return { confirmed: true }; } };
    const preview = await f.service.preview(adapter, [{ key: resource.key, action: "pause" }]);
    await Promise.all([f.service.execute(adapter,{token:preview.token,operationId:"pause-member"},"operator"),f.service.execute(adapter,{token:preview.token,operationId:"pause-member"},"operator")]);
    assert.equal(applications,1); assert.ok(readPause(f.dir)); await pauses.resume("worker","operator"); assert.equal(readPause(f.dir),undefined);
    await f.service.execute(adapter,{token:preview.token,operationId:"pause-member"},"operator"); assert.equal(readPause(f.dir),undefined); assert.equal(applications,1);
    new GovernanceLedger(f.path).restorePauses(()=>{throw Error("A finished pause must not be restored after an intentional resume");});
  } finally { f.cleanup(); }
});

test("a crash after journal commit but before writing pause files restores the real pause authority before host execution", async () => {
  const f = fixture(), previous = process.env.AGENTBOX_HOME; process.env.AGENTBOX_HOME = f.dir;
  try {
    const registry = new AgentRegistry(join(f.dir,"agents")), agent = registry.create({name:"Mia"});
    const resource = row(resourceKey("member",agent.id),{kind:"member",agentId:agent.id,actions:["pause"]});
    const adapter: GovernanceAdapter = {inventory:async()=>({rows:[resource],unknown:[]}),mayRead:()=>true,prepare:()=>{throw Error("process crashed before writing the pause file");},apply:async()=>{throw Error("must not run");}};
    const preview = await f.service.preview(adapter,[{key:resource.key,action:"pause"}]);
    await assert.rejects(f.service.execute(adapter,{token:preview.token,operationId:"pause-crash-window"},"operator"),/crashed/);
    assert.equal(readPause(registry.dirFor(agent.id)),undefined); assert.ok(new GovernanceLedger(f.path).pendingPause(agent.id));
    let calls = 0;
    const host = new Orchestrator({ registry,useBox:false,inbox:null,mcp:null,hooks:null,tasks:null,extensions:null,pendingWork:new PendingWork(null),client:fakeModel(()=>{calls++;throw Error("Paused members must not invoke a model");}) });
    assert.equal(readPause(registry.dirFor(agent.id))?.by,"operator");
    host.bus.sendFromUser(agent.id,"New request remains held");await host.bus.wake(agent.id);assert.equal(calls,0);assert.equal(host.bus.queuedCount(agent.id),1);
    const current = new GovernanceLedger(f.path); assert.equal(current.pendingPause(agent.id),undefined,"the real pause file now owns the hold"); assert.equal(current.pendingOperations().length,1,"cleanup still requires an operator-visible confirmation");
  } finally { if(previous===undefined)delete process.env.AGENTBOX_HOME;else process.env.AGENTBOX_HOME=previous;f.cleanup(); }
});
