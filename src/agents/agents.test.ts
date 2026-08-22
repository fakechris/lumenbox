/**
 * Tests for the multi-agent runtime.
 *
 * The bus semantics are the part worth pinning down: fire-and-forget delivery,
 * one turn per agent at a time, priority interrupting background work but not the
 * user's own turn, and a burst of messages collapsing into a single turn.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "./registry.ts";
import { STARTER_TEAM } from "../host/orchestrator.ts";
import { buildTools, dispatchTool } from "../host/tools.ts";
import { AGENT_MESSAGE_MAX_LENGTH, AgentBus, type BusEvent, type InboundMessage } from "./bus.ts";

function tempRegistry(): { registry: AgentRegistry; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "agentbox-test-"));
  return {
    registry: new AgentRegistry(root),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("registry round-trips an agent through disk", () => {
  const { registry, cleanup } = tempRegistry();
  try {
    const created = registry.create({
      name: "Ada",
      description: "coordinates the team",
      title: "coordinator",
    });

    const loaded = registry.get(created.id);
    assert.equal(loaded.profile.name, "Ada");
    assert.equal(loaded.profile.description, "coordinates the team");
    assert.equal(loaded.profile.title, "coordinator");

    // The profile must be valid JSON on disk — the agent reads it with a shell.
    const raw = readFileSync(registry.profilePathFor(created.id), "utf8");
    assert.equal(JSON.parse(raw).name, "Ada");
  } finally {
    cleanup();
  }
});

test("registry clamps names to one line and enforces a non-empty name", () => {
  const { registry, cleanup } = tempRegistry();
  try {
    const created = registry.create({ name: "  Grace\n  Hopper  " });
    assert.equal(created.profile.name, "Grace Hopper");
    assert.throws(() => registry.create({ name: "   " }), /non-empty name/);
  } finally {
    cleanup();
  }
});

test("registry update merges and never blanks a name", () => {
  const { registry, cleanup } = tempRegistry();
  try {
    const created = registry.create({ name: "Ada", description: "original" });

    const renamed = registry.update(created.id, { name: "Ada Lovelace" });
    assert.equal(renamed.profile.name, "Ada Lovelace");
    assert.equal(renamed.profile.description, "original", "omitted fields survive");

    // An empty name is ignored rather than destroying the profile.
    const blanked = registry.update(created.id, { name: "  " });
    assert.equal(blanked.profile.name, "Ada Lovelace");
  } finally {
    cleanup();
  }
});

test("registry resolves by id or by unique name", () => {
  const { registry, cleanup } = tempRegistry();
  try {
    const ada = registry.create({ name: "Ada" });
    assert.equal(registry.resolve(ada.id).id, ada.id);
    assert.equal(registry.resolve("Ada").id, ada.id);
    assert.equal(registry.resolve("ada").id, ada.id, "name match is case-insensitive");

    registry.create({ name: "Ada" });
    assert.throws(() => registry.resolve("Ada"), /matches 2 agents/);
    assert.throws(() => registry.resolve("nobody"), /No agent found/);
  } finally {
    cleanup();
  }
});

test("registry memory and transcript persist across instances", () => {
  const root = mkdtempSync(join(tmpdir(), "agentbox-test-"));
  try {
    const first = new AgentRegistry(root);
    const agent = first.create({ name: "Ada" });
    first.writeMemory(agent.id, "# Memory\n\n- prefers metric units\n");
    first.appendTranscript(agent.id, { role: "user", text: "hello" });
    first.appendTranscript(agent.id, { role: "assistant", text: "hi" });

    const second = new AgentRegistry(root);
    assert.match(second.readMemory(agent.id), /prefers metric units/);
    assert.equal(second.readTranscript(agent.id).length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("send returns an acknowledgement and queues for the recipient", async () => {
  const { registry, cleanup } = tempRegistry();
  try {
    const seen: InboundMessage[][] = [];
    const bus = new AgentBus(registry, async (_agent, inbound) => {
      seen.push([...inbound]);
    });

    const ada = registry.create({ name: "Ada" });
    const bob = registry.create({ name: "Bob" });

    const ack = bus.send({ fromId: ada.id, toId: bob.id, text: "please review" });
    assert.match(ack, /queued for Bob/);
    // It must tell the model not to wait, which it now does by saying what it will and will not
    // hear rather than by using the word.
    assert.match(ack, /You will hear again only if they reply, or if their turn fails/);

    await bus.idle();
    assert.equal(seen.length, 1, "Bob ran exactly one turn");
    assert.equal(seen[0]![0]!.text, "please review");
    assert.equal(seen[0]![0]!.fromName, "Ada");
  } finally {
    cleanup();
  }
});

test("send refuses self-messaging and unknown targets without throwing", () => {
  const { registry, cleanup } = tempRegistry();
  try {
    const bus = new AgentBus(registry, async () => {});
    const ada = registry.create({ name: "Ada" });

    // These return text for the model rather than throwing: a bad tool call
    // should teach the model, not abort its turn.
    assert.match(
      bus.send({ fromId: ada.id, toId: ada.id, text: "hi" }),
      /can't message itself/
    );
    assert.match(
      bus.send({ fromId: ada.id, toId: "missing-id", text: "hi" }),
      /No agent found with id missing-id/
    );
    assert.match(bus.send({ fromId: ada.id, toId: ada.id, text: "   " }), /empty/);
  } finally {
    cleanup();
  }
});

test("a burst of messages collapses into one turn", async () => {
  const { registry, cleanup } = tempRegistry();
  try {
    const turns: number[] = [];
    const bus = new AgentBus(registry, async (_agent, inbound) => {
      turns.push(inbound.length);
    });

    const ada = registry.create({ name: "Ada" });
    const bob = registry.create({ name: "Bob" });

    // Three messages sent before Bob's turn starts should arrive together,
    // rather than waking him three times.
    bus.send({ fromId: ada.id, toId: bob.id, text: "one" });
    bus.send({ fromId: ada.id, toId: bob.id, text: "two" });
    bus.send({ fromId: ada.id, toId: bob.id, text: "three" });

    await bus.idle();
    assert.equal(turns.length, 1, "one turn, not three");
    assert.equal(turns[0], 3, "all three messages delivered to it");
  } finally {
    cleanup();
  }
});

test("turns for one agent are serialized, never concurrent", async () => {
  const { registry, cleanup } = tempRegistry();
  try {
    let inFlight = 0;
    let maxInFlight = 0;

    const bus = new AgentBus(registry, async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(resolve => setTimeout(resolve, 20));
      inFlight--;
    });

    const ada = registry.create({ name: "Ada" });

    // Three overlapping user turns for the same agent.
    bus.sendFromUser(ada.id, "first");
    const a = bus.runExclusive(ada.id, { userDriven: true });
    bus.sendFromUser(ada.id, "second");
    const b = bus.runExclusive(ada.id, { userDriven: true });
    bus.sendFromUser(ada.id, "third");
    const c = bus.runExclusive(ada.id, { userDriven: true });

    await Promise.all([a, b, c]);
    assert.equal(maxInFlight, 1, "an agent must only ever be inside one turn");
  } finally {
    cleanup();
  }
});

test("priority message interrupts a background turn", async () => {
  const { registry, cleanup } = tempRegistry();
  try {
    const ada = registry.create({ name: "Ada" });
    const bob = registry.create({ name: "Bob" });

    let bobAborted = false;
    let bobTurns = 0;

    const bus = new AgentBus(registry, async (agent, _inbound, signal) => {
      if (agent.id !== bob.id) return;
      bobTurns++;
      if (bobTurns === 1) {
        // Simulate a long background turn that watches for abort.
        for (let i = 0; i < 100; i++) {
          if (signal.aborted) {
            bobAborted = true;
            return;
          }
          await new Promise(resolve => setTimeout(resolve, 5));
        }
      }
    });

    // Wake Bob with ordinary work, then interrupt with a priority message.
    bus.send({ fromId: ada.id, toId: bob.id, text: "background task" });
    await new Promise(resolve => setTimeout(resolve, 30));
    bus.send({ fromId: ada.id, toId: bob.id, text: "STOP", priority: true });

    await bus.idle();
    assert.equal(bobAborted, true, "the background turn saw the abort");
    assert.equal(bobTurns, 2, "a follow-up turn handled the priority message");
  } finally {
    cleanup();
  }
});

test("priority message does not interrupt the user's own turn", async () => {
  const { registry, cleanup } = tempRegistry();
  try {
    const ada = registry.create({ name: "Ada" });
    const bob = registry.create({ name: "Bob" });

    let adaAborted = false;

    const bus = new AgentBus(registry, async (agent, _inbound, signal) => {
      if (agent.id !== ada.id) return;
      for (let i = 0; i < 20; i++) {
        if (signal.aborted) {
          adaAborted = true;
          return;
        }
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    });

    bus.sendFromUser(ada.id, "user is watching this");
    const userTurn = bus.runExclusive(ada.id, { userDriven: true });

    await new Promise(resolve => setTimeout(resolve, 20));
    bus.send({ fromId: bob.id, toId: ada.id, text: "STOP", priority: true });

    await userTurn;
    assert.equal(
      adaAborted,
      false,
      "the user's turn must finish; yanking it out from under them is worse"
    );

    await bus.idle();
  } finally {
    cleanup();
  }
});

test("a failing turn does not poison later turns for the same agent", async () => {
  const { registry, cleanup } = tempRegistry();
  try {
    const ada = registry.create({ name: "Ada" });
    let calls = 0;

    const bus = new AgentBus(registry, async () => {
      calls++;
      if (calls === 1) throw new Error("first turn explodes");
    });

    bus.sendFromUser(ada.id, "one");
    await assert.rejects(
      bus.runExclusive(ada.id, { userDriven: true }),
      /first turn explodes/
    );

    bus.sendFromUser(ada.id, "two");
    await bus.runExclusive(ada.id, { userDriven: true });
    assert.equal(calls, 2, "the second turn still ran");
  } finally {
    cleanup();
  }
});

test("a message that arrived during a failed turn is kept, not discarded", async () => {
  // The wake loop's failure handler used to drain the queue, reasoning that re-running a turn that
  // just failed would fail the same way. True of the message that turn was given — but that one was
  // taken off the queue before it ran. What the drain actually threw away was everything that
  // arrived afterwards, whose senders had already been told "Sent".
  const { registry, cleanup } = tempRegistry();
  try {
    const ada = registry.create({ name: "Ada" });
    const seen: string[] = [];
    const events: BusEvent[] = [];
    let failing = true;

    const bus = new AgentBus(
      registry,
      async (_agent, inbound) => {
        if (failing) {
          // Arrives while this doomed turn is in flight, so it is not the message that failed.
          bus.sendFromUser(ada.id, "second");
          throw new Error("the provider was down");
        }
        for (const message of inbound) seen.push(message.text);
      },
      event => events.push(event)
    );

    bus.sendFromUser(ada.id, "first");
    await bus.wake(ada.id);

    assert.equal(bus.pendingCount(ada.id), 1, "the later message survives the earlier failure");
    const failed = events.find(event => event.type === "turn_failed");
    assert.ok(failed && "waiting" in failed && failed.waiting === 1, "and the queue is reported");

    // And it is delivered when the agent next runs, rather than sitting there unmentioned forever.
    failing = false;
    await bus.wake(ada.id);
    assert.deepEqual(seen, ["second"]);
    assert.equal(bus.pendingCount(ada.id), 0);
  } finally {
    cleanup();
  }
});

test("agents can hand work back and forth without deadlocking", async () => {
  const { registry, cleanup } = tempRegistry();
  try {
    const ada = registry.create({ name: "Ada" });
    const bob = registry.create({ name: "Bob" });
    const exchanges: string[] = [];

    // Bob replies once, then stays silent — the discipline the prompt asks for.
    const bus = new AgentBus(registry, async (agent, inbound) => {
      for (const message of inbound) {
        exchanges.push(`${message.fromName}->${agent.profile.name}: ${message.text}`);
      }
      if (agent.id === bob.id && inbound.some(m => m.text === "ping")) {
        bus.send({ fromId: bob.id, toId: ada.id, text: "pong" });
      }
    });

    bus.send({ fromId: ada.id, toId: bob.id, text: "ping" });
    await bus.idle();

    assert.deepEqual(exchanges, ["Ada->Bob: ping", "Bob->Ada: pong"]);
  } finally {
    cleanup();
  }
});

// ── the starter team ───────────────────────────────────────────────────────────────────

test("the starter team is small, distinct, and free of one-time instructions", () => {
  // Small because the roster is a cost: every agent appears in every other agent's system prompt,
  // and a team is also a set of desktops and a set of things a person reads before doing anything.
  assert.ok(STARTER_TEAM.length >= 2 && STARTER_TEAM.length <= 6, "a team, not a directory");

  const names = STARTER_TEAM.map(entry => entry.name);
  assert.equal(new Set(names).size, names.length, "names are distinct");
  assert.equal(STARTER_TEAM[0]?.title, "coordinator", "the first one is who a person talks to");

  for (const entry of STARTER_TEAM) {
    // A description is re-read into the system prompt on every turn, so a one-time instruction
    // parked here keeps asserting itself long after it stopped being true. This is the lesson that
    // cost someone else a bug: a "the disk is low" briefing in a profile insists on it forever.
    // Narrowed after a false positive on correct text: "they talk to you first" is standing
    // identity, not a moment in time. The guard is for words that can only describe *now* —
    // a heuristic that fires on good prose is a worse test than no heuristic.
    assert.doesNotMatch(
      entry.description,
      /\b(start by|begin by|right now|currently|today|at the moment|for now)\b/i,
      `${entry.name}'s description reads like a briefing rather than an identity`
    );
    // Tool names in a description freeze on the day it was written.
    assert.doesNotMatch(
      entry.description,
      /SendToAgent|SetTodos|SetPlan|RememberFact|CreateAgent/,
      `${entry.name}'s description names a tool, which will be wrong after the next rename`
    );
    assert.ok(entry.description.length > 120, `${entry.name} needs enough to be a role`);
    assert.ok(entry.description.length < 900, `${entry.name} is paid for on every turn`);
  }
});

test("the starter team differs in what it touches, not in adjectives", () => {
  // Five flavours of "helpful assistant" would be worse than one agent, because it implies a
  // structure that does not exist. Each of these should name concrete, different work.
  const byName = new Map(STARTER_TEAM.map(entry => [entry.name, entry.description]));
  assert.match(byName.get("Rex") ?? "", /browser/i);
  assert.match(byName.get("Ops") ?? "", /shell/i);
  assert.match(byName.get("Vera") ?? "", /transcript/i);
  assert.match(byName.get("Ada") ?? "", /coordinate/i);

  // And the reviewer's remit names the failure it exists for, since "review the work" is an
  // instruction nobody can act on.
  assert.match(byName.get("Vera") ?? "", /looked like it worked and did not/);
});

test("shared memory is sharded by writer, and a shard cannot claim to be another", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-shared-"));
  try {
    const registry = new AgentRegistry(dir);
    const ada = registry.create({ name: "Ada" });
    const rex = registry.create({ name: "Rex" });

    registry.appendSharedMemory(ada.id, [
      { at: "2026-08-01T00:00:00.000Z", kind: "fact", text: "deploys are on Friday" },
    ]);
    // Sharded because agents run concurrently, and two appends to one file are not reliably atomic
    // once a line exceeds the pipe-buffer size. One writer per file removes the question.
    registry.appendSharedMemory(rex.id, [
      { at: "2026-08-02T00:00:00.000Z", kind: "fact", text: "the docs are client-side rendered" },
    ]);

    const merged = registry.readSharedMemory();
    assert.equal(merged.length, 2, "every shard is merged on read");
    assert.deepEqual(
      merged.map(entry => entry.via).sort(),
      [ada.id, rex.id].sort(),
      "provenance is stamped from the filename"
    );

    // A shard claiming someone else wrote it is overruled: `via` comes from where the file is, not
    // from what the record says, so a shard cannot attribute its contents to another agent.
    registry.appendSharedMemory(rex.id, [
      { at: "2026-08-03T00:00:00.000Z", kind: "fact", text: "something", via: ada.id },
    ]);
    const claimed = registry.readSharedMemory().find(entry => entry.text === "something");
    assert.equal(claimed?.via, rex.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("what an agent taught the team survives that agent's directory going away", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-shared-"));
  try {
    const registry = new AgentRegistry(dir);
    const rex = registry.create({ name: "Rex" });
    registry.appendSharedMemory(rex.id, [
      { at: "2026-08-01T00:00:00.000Z", kind: "fact", text: "the API needs a trailing slash" },
    ]);
    // Whatever removes an agent — a person clearing it out, a restore from a partial backup — takes
    // its directory. The shared tier lives outside those directories precisely so that removing an
    // agent does not remove what it taught everyone else.
    rmSync(join(dir, rex.id), { recursive: true, force: true });

    const survived = registry.readSharedMemory();
    assert.equal(survived.length, 1);
    assert.equal(survived[0]?.via, rex.id, "and it still says who learned it");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the shared-memory directory is not mistaken for an agent", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-shared-"));
  try {
    const registry = new AgentRegistry(dir);
    const ada = registry.create({ name: "Ada" });
    registry.appendSharedMemory(ada.id, [
      { at: "2026-08-01T00:00:00.000Z", kind: "fact", text: "something shared" },
    ]);

    // It lives under the same root so an installation's state stays together, which means the
    // listing has to exclude it by name. It previously survived only because reading a profile that
    // is not there returns undefined — which worked, and was an accident rather than a rule.
    assert.deepEqual(registry.list().map(entry => entry.profile.name), ["Ada"]);
    assert.equal(registry.tryGet("shared-memory"), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test("a message too long to deliver says it was cut", async () => {
  // It used to be sliced at 8,000 characters in silence: a pasted specification whose acceptance
  // criteria were at the end arrived without them, the sender was told "Sent", and the model had no
  // way to know it was reading part of a request — so it answered the truncated question
  // confidently. Losing the text is survivable; not knowing it was lost is not.
  const { registry, cleanup } = tempRegistry();
  try {
    const ada = registry.create({ name: "Ada" });
    const seen: string[] = [];
    const bus = new AgentBus(registry, async (_agent, inbound) => {
      for (const item of inbound) seen.push(item.text);
    });

    const spec = `${"x".repeat(AGENT_MESSAGE_MAX_LENGTH)}ACCEPTANCE CRITERIA AT THE END`;
    bus.sendFromUser(ada.id, spec);
    await bus.wake(ada.id);

    const delivered = seen[0] ?? "";
    assert.ok(!delivered.includes("ACCEPTANCE"), "it is still cut — the cap is the cap");
    assert.match(delivered, /30 more characters were not delivered/);
    assert.match(delivered, /You are reading part of it/);
    assert.match(delivered, /ask for the rest/, "and it says how to get the rest");

    // A message inside the limit is delivered exactly, with nothing appended.
    bus.sendFromUser(ada.id, "short one");
    await bus.wake(ada.id);
    assert.equal(seen[1], "short one");
  } finally {
    cleanup();
  }
});


test("an acknowledgement says what it promises, and what it does not", () => {
  // "Sent" reads like "received and understood", and never meant that. An acknowledgement that
  // cannot be told apart from agreement is where a team of agents starts building the ack layer it
  // does not have — "you sure?" / "sure" / "ok starting" — a turn each, confirming nothing.
  const { registry, cleanup } = tempRegistry();
  try {
    const ada = registry.create({ name: "Ada" });
    const rex = registry.create({ name: "Rex" });
    const bus = new AgentBus(registry, async () => {});

    const ack = bus.send({ fromId: ada.id, toId: rex.id, text: "look at the logs" });
    assert.match(ack, /Recorded and queued for Rex/);
    assert.match(ack, /written down and it will be delivered/);
    assert.match(ack, /does not mean Rex has read it, agrees with it, or is doing it/);
    // And it heads off the confirmation loop directly, because that loop is the observed failure.
    assert.match(ack, /asking them to confirm receipt buys nothing/);
  } finally {
    cleanup();
  }
});

test("a sender is told when the turn its message reached failed", async () => {
  // Their acknowledgement promised delivery, and delivery happened — into a turn that then failed.
  // Without this the sender waits forever on something that will never be acted on, which is what
  // turns that promise into a lie.
  const { registry, cleanup } = tempRegistry();
  try {
    const ada = registry.create({ name: "Ada" });
    const rex = registry.create({ name: "Rex" });
    const seen: { agent: string; text: string }[] = [];

    const bus = new AgentBus(registry, async (agent, inbound) => {
      for (const message of inbound) seen.push({ agent: agent.profile.name, text: message.text });
      if (agent.id === rex.id) throw new Error("the provider was down");
    });

    const ack = bus.send({ fromId: ada.id, toId: rex.id, text: "deploy it" });
    const id = /message ([0-9a-f-]{36})/.exec(ack)?.[1];
    assert.ok(id);
    await bus.wake(rex.id).catch(() => {});
    // idle(), not wake(): the notice schedules Ada's wake itself, and a second wake call returns
    // straight away because one is already queued.
    await bus.idle();

    const notice = seen.find(entry => entry.agent === "Ada");
    assert.ok(notice, `Ada should have been told; saw ${JSON.stringify(seen)}`);
    assert.match(notice.text, /reached a turn that then failed/);
    assert.match(notice.text, new RegExp(id));
    assert.match(notice.text, /the provider was down/);
    // The distinction that decides what the sender does next.
    assert.match(notice.text, /delivered and not acted on/);
    assert.match(notice.text, /Nothing has been retried/);
  } finally {
    cleanup();
  }
});

test("a failure notice cannot cause another one", async () => {
  // A notification about a notification is how one failing agent becomes a broadcast storm.
  const { registry, cleanup } = tempRegistry();
  try {
    const ada = registry.create({ name: "Ada" });
    const rex = registry.create({ name: "Rex" });
    let adaTurns = 0;

    const bus = new AgentBus(registry, async agent => {
      if (agent.id === rex.id) throw new Error("rex is broken");
      adaTurns += 1;
      throw new Error("ada is broken too");
    });

    bus.send({ fromId: ada.id, toId: rex.id, text: "deploy it" });
    await bus.wake(rex.id);
    await bus.wake(ada.id);
    await bus.wake(ada.id);

    assert.ok(adaTurns <= 2, `Ada ran ${adaTurns} turns; a notice must not beget notices`);
    assert.equal(bus.pendingCount(rex.id), 0, "and nothing bounced back to Rex");
  } finally {
    cleanup();
  }
});


test("the team differs in what it may do, not only in how it is described", () => {
  // Four agents holding identical tools are four agents differing only in prose — a division of
  // tone rather than of labour, and the thing that makes a multi-agent claim hollow.
  const byName = new Map(STARTER_TEAM.map(profile => [profile.name, profile]));

  const ada = byName.get("Ada")?.tools ?? [];
  const vera = byName.get("Vera")?.tools ?? [];
  const rex = byName.get("Rex")?.tools ?? [];

  assert.ok(ada.includes("CreateAgent"), "the coordinator builds the team");
  assert.ok(!rex.includes("CreateAgent"), "and nobody else does");

  // The one real division: a reviewer that can rewrite the work is no longer reviewing it, and
  // "fixed it" and "checked it" stop being distinguishable afterwards.
  assert.ok(!vera.includes("write_file"));
  // It keeps bash, because reproducing a step is its whole job and reproducing means running.
  assert.ok(vera.includes("bash"));
  assert.ok(vera.includes("ReadHistory"));
});

test("every tool is accounted for in the coordinator's set", () => {
  // The guard that makes an allowlist safe to use. A restriction expressed as an allowlist fails
  // closed, which is right — but adding a tool would then silently withhold it from three of four
  // agents, and nobody would notice until someone wondered why the reviewer could not use it. This
  // makes adding a tool a decision rather than an omission.
  // With the host door open too, so a tool reachable only in that mode is still
  // accounted for rather than slipping past because the default build omits it.
  const offered = buildTools(true, true, undefined, true).map(tool => tool.name).sort();
  const coordinator = [...(STARTER_TEAM.find(profile => profile.name === "Ada")?.tools ?? [])].sort();
  assert.deepEqual(
    offered.filter(name => !coordinator.includes(name)),
    [],
    "a tool exists that the starter team's own lists have never heard of"
  );
});

test("a restricted agent cannot create an unrestricted one", async () => {
  // Otherwise the restriction is not a restriction, only a longer path: an agent that may not write
  // creates one that may, and asks it to write.
  const { registry, cleanup } = tempRegistry();
  try {
    const vera = registry.create({ name: "Vera", tools: ["SendToAgent", "CreateAgent", "read_file"] });
    const bus = new AgentBus(registry, async () => {});
    const result = await dispatchTool(
      "CreateAgent",
      { name: "Helper", description: "writes things" },
      { agent: vera, registry, bus, box: undefined }
    );
    assert.equal(result.isError, undefined);
    assert.match(result.text, /same tools you do/);

    const helper = registry.list().find(agent => agent.profile.name === "Helper");
    assert.deepEqual([...(helper?.profile.tools ?? [])], ["SendToAgent", "CreateAgent", "read_file"]);
    assert.ok(!(helper?.profile.tools ?? []).includes("write_file"));
  } finally {
    cleanup();
  }
});
