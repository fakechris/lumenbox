/**
 * The demonstration recorder, without X: lines are fed as xinput would print them, the
 * pointer, the outline and the recorder are scripted, and what lands on disk is checked.
 * The rule under test most of all: no key ever reaches the trace, only counts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyBurst, TeachService, TeachSession, parseXi2Line, type TeachDeps, type TeachEvent } from "./teach-service.ts";

test("a queued demonstration retains the task and agent captured before recording starts, across restart and display reuse", async t => {
  const root = mkdtempSync(join(tmpdir(), "teach-binding-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const service = new TeachService(scripted(root).deps, root);
  const binding = { agentId: "ada", taskId: "task-a" };
  const beginning = service.begin(21, 5, binding);
  binding.agentId = "bob";
  const first = await beginning;
  await assert.rejects(service.begin(21, 5, { agentId: "bob", taskId: "other" }), /another agent or task/);
  await service.finish(21, "handback");
  await service.begin(21, 6, { agentId: "bob", taskId: "task-b" });
  await service.finish(21, "handback");
  const restarted = new TeachService(scripted(root).deps, root);
  const old = restarted.queue.list().pending.find(entry => entry.id === first?.id);
  assert.deepEqual(old?.binding, { agentId: "ada", taskId: "task-a" });
  assert.equal(old?.epoch, 5);
});

test("only Raw*Press lines are events; the key itself is never parsed", () => {
  assert.deepEqual(parseXi2Line("EVENT type 15 (RawButtonPress)"), { kind: "button", press: true });
  assert.deepEqual(parseXi2Line("EVENT type 16 (RawButtonRelease)"), { kind: "button", press: false });
  assert.deepEqual(parseXi2Line("EVENT type 13 (RawKeyPress)"), { kind: "key", press: true });
  assert.equal(parseXi2Line("    detail: 38"), undefined);
  assert.equal(parseXi2Line("EVENT type 17 (RawMotion)"), undefined);
});

test("key presses become bursts separated by silence, with a count and no content", () => {
  const bursts = new KeyBurst(1000);
  assert.equal(bursts.press(0), undefined);
  assert.equal(bursts.press(200), undefined);
  assert.equal(bursts.press(900), undefined);
  // Silence longer than the gap: the earlier run closes as this press opens a new one.
  assert.deepEqual(bursts.press(2500), { count: 3, from: 0, to: 900 });
  assert.deepEqual(bursts.flush(), { count: 1, from: 2500, to: 2500 });
  assert.equal(bursts.flush(), undefined);
  assert.equal(bursts.idleSince(0), false);
});

class FakeInput extends EventEmitter {
  stdout = new EventEmitter();
  killed = false;
  kill(): boolean {
    this.killed = true;
    return true;
  }
}

function scripted(root: string, over: Partial<TeachDeps> = {}): { deps: TeachDeps; input: FakeInput; calls: string[]; clock: { now: number } } {
  const input = new FakeInput();
  const calls: string[] = [];
  const clock = { now: 1_000_000 };
  const url = "https://shop.test/cart";
  const deps: TeachDeps = {
    spawnInput: () => input as never,
    pointer: async () => ({ x: 400, y: 300, window: "0x00000001", title: "Cart — Chromium" }),
    snapshot: async () => ({ url, title: "Cart", snapshot: `- textbox "Coupon" [ref=e1] value="${calls.filter(c => c === "keys").length > 0 ? "SAVE10" : ""}"`, snapshot_id: "s1" }),
    startRecording: (_display, name) => {
      calls.push(`record:${name}`);
      return { id: `id-${name}`, path: join(root, `${name}.mp4`) };
    },
    stopRecording: async () => {
      calls.push("stop");
      return { path: join(root, "final.mp4") };
    },
    execsBetween: async () => [{ at: new Date(clock.now).toISOString(), cmd: "git status -s", user: "box" }],
    now: () => clock.now,
    log: () => {},
    ...over,
  };
  const wrapped: TeachDeps = { ...deps, snapshot: async d => { calls.push("snap"); return deps.snapshot(d); } };
  // Expose "keys" markers for the scripted outline: the session calls snapshot after a
  // burst; the test's clock decides when a burst closes.
  const spawnInput: TeachDeps["spawnInput"] =
    over.spawnInput !== undefined
      ? over.spawnInput
      : () => {
          calls.push("input");
          return input as never;
        };
  return { deps: { ...wrapped, spawnInput }, input, calls, clock };
}

const events = (path: string): TeachEvent[] =>
  readFileSync(path, "utf8").split("\n").filter(l => l.trim() !== "").map(l => JSON.parse(l) as TeachEvent);

test("a demonstration records clicks with where they landed, typing as counts, and outlines after each", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentbox-teach-"));
  try {
    const { deps, input, calls, clock } = scripted(root);
    const session = new TeachSession(3, deps, root, 1000);
    await session.start();
    assert.ok(calls.includes("input") && calls.some(c => c.startsWith("record:teach-")), "input capture and recording start with the session");

    // Two keys, then a click 300ms later (which closes the burst), then silence.
    session.onInputLine("EVENT type 13 (RawKeyPress)");
    session.onInputLine("    detail: 38");
    clock.now += 100;
    session.onInputLine("EVENT type 13 (RawKeyPress)");
    clock.now += 300;
    session.onInputLine("EVENT type 15 (RawButtonPress)");
    // Let the click's pointer read and the settle timer run.
    await new Promise(resolve => setTimeout(resolve, 900));
    clock.now += 5000;
    const record = await session.end("handback");
    assert.ok(input.killed, "input capture is stopped");
    assert.equal(record.endedBy, "handback");
    assert.equal(record.videoPath, join(root, "final.mp4"));
    assert.equal(record.counts.clicks, 1);
    assert.equal(record.counts.keyBursts, 1);
    assert.equal(record.counts.execs, 1);

    const trace = events(record.eventsPath);
    const keys = trace.find(e => e.type === "keys");
    assert.ok(keys !== undefined && keys.type === "keys" && keys.count === 2, "the burst counted two presses");
    assert.doesNotMatch(readFileSync(record.eventsPath, "utf8"), /"detail"|keycode|38/, "no key detail reaches the trace");
    const click = trace.find(e => e.type === "click");
    assert.ok(click !== undefined && click.type === "click" && click.x === 400 && click.title === "Cart — Chromium");
    const snaps = trace.filter(e => e.type === "snapshot").map(e => (e as { after: string }).after);
    assert.deepEqual(snaps, ["start", "keys", "click", "end"], "an outline at start, after the burst, after the click, and at the end");
    assert.ok(trace.some(e => e.type === "exec" && (e as { cmd: string }).cmd === "git status -s"));
    assert.ok(existsSync(join(session.dir, "session.json")));
    assert.equal(JSON.parse(readFileSync(join(session.dir, "session.json"), "utf8")).endedBy, "handback");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a session with no browser and no input capture still records the video and says so", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentbox-teach-"));
  try {
    const { deps, clock } = scripted(root, { spawnInput: () => undefined, snapshot: async () => undefined });
    const session = new TeachSession(4, deps, root, 1000);
    await session.start();
    clock.now += 100;
    const record = await session.end("lapse");
    const trace = events(record.eventsPath);
    assert.ok(trace.some(e => e.type === "note" && /input capture unavailable/.test((e as { text: string }).text)));
    assert.equal(record.counts.snapshots, 0);
    assert.equal(record.videoPath, join(root, "final.mp4"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the service starts on takeover, ends on hand-back or lapse, and queues; the queue claims atomically with a lease", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentbox-teach-"));
  try {
    const { deps, clock } = scripted(root);
    const service = new TeachService(deps, root);
    assert.ok(await service.begin(1));
    assert.ok(service.isTeaching(1));
    assert.ok(await service.begin(1), "beginning twice is one session");
    clock.now += 50;
    // The lease lapsed: the reaper ends it.
    await service.reapLapsed(() => false);
    assert.ok(!service.isTeaching(1));

    const listed = service.queue.list();
    assert.equal(listed.pending.length, 1);
    assert.equal(listed.pending[0]?.display, 1);
    assert.equal(listed.claimed.length, 0);

    const claimed = service.queue.claim();
    assert.ok(claimed !== undefined && claimed.leaseUntil !== undefined);
    assert.equal(service.queue.claim(), undefined, "nothing left to claim");
    assert.equal(service.queue.list().claimed.length, 1);

    // A claim nobody finished lapses back to pending.
    const leaseFile = join(root, "queues", "claimed", `${claimed!.id}.json.lease`);
    const old = new Date(clock.now - 13 * 60 * 60_000);
    utimesSync(leaseFile, old, old);
    assert.equal(service.queue.list().pending.length, 1);

    const again = service.queue.claim();
    assert.ok(again !== undefined);
    assert.equal(service.queue.release(again!.id), true);
    assert.equal(service.queue.list().pending.length, 1);
    const third = service.queue.claim()!;
    assert.equal(service.queue.done(third.id, true), true);
    assert.equal(service.queue.done(third.id), false, "done twice is not done");
    assert.deepEqual(service.queue.list(), { pending: [], claimed: [] });
    assert.ok(!existsSync(join(root, "final.mp4")), "the video went with delete_video");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});



// ── session identity and the generation swap ─────────────────

/**
 * The recorder half of the wiring, modelling RecordService's contract: a recording has
 * an immutable id distinct from its file path, one current recording per display, and a
 * stop for any other id is refused. `holdStop` blocks a stop mid-flight so a takeover
 * can land while an end() is awaiting. The clock is FIXED: every session begins in the
 * same second, the condition the unique-id suffix must survive.
 */
function recorderBacked(root: string) {
  let current: { display: number; id: string; path: string } | undefined;
  const stops: string[] = [];
  const control = { hold: false, release: undefined as (() => void) | undefined };
  // Resolved the moment the first stop enters, so a test can hold a stop mid-flight and
  // land the takeover inside the await — the round-5 sequence, deterministically.
  let enteredStop: (id: string) => void = () => {};
  const firstStop = new Promise<string>(resolve => {
    enteredStop = resolve;
  });
  const deps: TeachDeps = {
    spawnInput: () => undefined,
    pointer: async () => ({ x: 0, y: 0 }),
    snapshot: async () => undefined,
    now: () => 1_000_000,
    startRecording: (display, name) => {
      current = { display, id: `id-of-${name}`, path: join(root, `${name}.mp4`) };
      return { id: current.id, path: current.path };
    },
    stopRecording: async (display, recordingId) => {
      stops.push(recordingId);
      enteredStop(recordingId);
      if (control.hold) {
        // One shot: only the stop entered while the test holds gets gated.
        control.hold = false;
        await new Promise<void>(resolve => {
          control.release = resolve;
        });
        control.release = undefined;
      }
      if (current === undefined || current.display !== display || current.id !== recordingId) {
        return undefined;
      }
      const path = current.path;
      current = undefined;
      return { path };
    },
    execsBetween: async () => [],
  };
  return { deps, stops, control, firstStop, current: () => current };
}

test("the session captures its begin-time identity: session id, recording id, epoch", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentbox-teach-"));
  try {
    const { deps } = recorderBacked(root);
    const service = new TeachService(deps, root);
    const record = await service.begin(2, 7);
    assert.ok(record !== undefined);
    const session = (service as unknown as { active: Map<number, TeachSession> }).active.get(2)!;
    assert.equal(session.epoch, 7, "the displayEpoch at begin is part of the immutable identity");
    assert.equal(session.id, record.id);
    await service.finish(2, "handback");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("same-second incarnations are distinct sessions, and finish converges per session", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentbox-teach-"));
  try {
    const backing = recorderBacked(root);
    const service = new TeachService(backing.deps, root);

    // A begins and its end() is held mid-flight; B begins in the same second.
    backing.control.hold = true;
    const a = await service.begin(2, 1);
    const finishingA = service.finish(2, "handback");
    const stoppedA = await backing.firstStop;
    const b = await service.begin(2, 2);

    assert.notEqual(a!.id, b!.id, "same second, same desktop — still two incarnations");
    assert.ok(b!.id.startsWith(`teach-1970-01-01T00-16-40-d2-`));
    assert.ok(service.isTeaching(2), "B holds the desktop slot while A ends");

    backing.control.release!();
    const endedA = await finishingA;
    const finishingB = service.finish(2, "handback");
    const endedB = await finishingB;

    assert.ok(endedA !== undefined && endedB !== undefined);
    assert.notEqual(endedA.id, endedB.id);
    assert.equal(endedB.endedBy, "handback", "B actually ended; its finish did not return A's record");
    assert.equal(stoppedA, `id-of-${a!.id}`, "A's stop carried A's recording identity");
    assert.deepEqual(backing.stops, [`id-of-${a!.id}`, `id-of-${b!.id}`]);
    assert.equal(service.queue.list().pending.length, 2, "both sessions queued");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a begin from a newer generation ends the old session instead of returning its record", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentbox-teach-"));
  try {
    const backing = recorderBacked(root);
    const service = new TeachService(backing.deps, root);
    const a = await service.begin(1, 1);
    // Generation 2 takes over while generation 1 is still live (its hand-back went missing).
    const b = await service.begin(1, 2);
    assert.notEqual(a!.id, b!.id);
    assert.equal(service.queue.list().pending.length, 1, "the old generation was ended and queued");
    assert.equal(service.isTeaching(1), true);
    // Same-generation retry returns the same session; an older epoch does not rewind it.
    const again = await service.begin(1, 2);
    assert.equal(again!.id, b!.id);
    const older = await service.begin(1, 1);
    assert.equal(older!.id, b!.id, "a stale epoch cannot rewind the live generation");
    await service.finish(1, "handback");
    assert.equal(backing.stops.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("generation swap: an old session's end() passes the guard, then the desktop turns over — its stop must not touch the new recording", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentbox-teach-"));
  try {
    const backing = recorderBacked(root);
    const service = new TeachService(backing.deps, root);

    // Incarnation A: epoch 1. The recorder is now holding A's recording.
    const recordA = await service.begin(1, 1);
    assert.ok(recordA !== undefined);
    const recordingA = backing.current()!.id;
    assert.ok(recordingA !== undefined);

    // The guard at the entry has already passed when the desktop turns over: A's end() is
    // awaiting its stop, and mid-await a new takeover begins incarnation B (epoch 2).
    backing.control.hold = true;
    const finishingA = service.finish(1, "handback");
    const stoppedId = await backing.firstStop;
    assert.equal(stoppedId, recordingA, "A's end() is inside its stop call");
    const recordB = await service.begin(1, 2);
    assert.ok(recordB !== undefined && recordB.id !== recordA.id, "a takeover mid-hand-back starts the next incarnation");
    const recordingB = backing.current()!.id;
    assert.notEqual(recordingB, recordingA);

    // A's stop proceeds now — and must find that the desktop's recording is no longer its own.
    backing.control.release!();
    const endedA = await finishingA;

    // The superseded stop is skipped and said so; B's recording was not stopped and is
    // not attributed to A.
    const traceA = events(endedA!.eventsPath);
    assert.ok(
      traceA.some(e => e.type === "note" && /recording superseded/.test((e as { text: string }).text)),
      "the trace records that the recording was superseded"
    );
    assert.equal(endedA!.videoPath, join(root, `${recordA.id}.mp4`), "A keeps its own recording, not B's");
    assert.equal(backing.current()!.id, recordingB, "B's recording is still running");

    // Ending B stops B's recording — and only B's.
    const endedB = await service.finish(1, "handback");
    assert.equal(endedB!.videoPath, join(root, `${recordB.id}.mp4`));
    assert.deepEqual(backing.stops, [recordingA, recordingB]);
    assert.equal(backing.current(), undefined);
    const pending = service.queue.list().pending;
    assert.equal(pending.length, 2);
    assert.deepEqual(pending.map(entry => entry.id).sort(), [recordA.id, recordB.id].sort());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent finishes of one session converge on a single in-flight promise", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentbox-teach-"));
  try {
    const backing = recorderBacked(root);
    const service = new TeachService(backing.deps, root);
    await service.begin(1, 1);

    const [first, second] = await Promise.all([
      service.finish(1, "handback"),
      service.finish(1, "handback"),
    ]);
    assert.ok(first !== undefined && second !== undefined);
    assert.equal(first, second, "both callers get the same record object from the one end()");
    assert.equal(backing.stops.length, 1, "the recording was stopped once, not twice");
    assert.equal(service.queue.list().pending.length, 1, "queued once");

    // After the finish settled, the desktop is teachable again and a finish with no
    // session is a clean no-op.
    assert.equal(await service.finish(1, "handback"), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reapLapsed and shutdown run the same finish path, still honouring stillHeld", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentbox-teach-"));
  try {
    const backing = recorderBacked(root);
    const service = new TeachService(backing.deps, root);
    await service.begin(1, 1);
    await service.begin(2, 1);

    // Desktop 1 is still the person's: only desktop 2 is reaped.
    await service.reapLapsed(display => display === 1);
    assert.ok(service.isTeaching(1));
    assert.ok(!service.isTeaching(2));
    assert.equal(service.queue.list().pending.length, 1);

    // Shutdown ends what is left through the identical mechanism.
    await service.shutdown();
    assert.ok(!service.isTeaching(1));
    assert.equal(service.queue.list().pending.length, 2);
    assert.deepEqual(backing.stops.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── the real two-module wiring: TeachService × RecordService exactly as main.ts wires them ──

class FakeEncoder extends EventEmitter {
  exitCode: number | null = null;
  written = "";
  stdin = {
    write: (chunk: string) => {
      this.written += chunk;
      return true;
    },
    end: () => {},
  };
  stderr = new EventEmitter();
  kill() {
    return true;
  }
  exit(code: number) {
    this.exitCode = code;
    this.emit("exit", code);
  }
}

test("actual wiring: a normal finish stops the encoder; a superseded one leaves the new recording running", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentbox-teach-"));
  const recordings = join(root, "recordings");
  process.env.BOXD_RECORDINGS_DIR = recordings;
  const { RecordService } = await import("./record-service.ts");
  try {
    // Wired exactly like main.ts: startRecording forwards the recorder's id AND path,
    // stopRecording stops by id.
    const encoders: FakeEncoder[] = [];
    const recorder = new RecordService(
      () => {},
      () => {
        const child = new FakeEncoder();
        encoders.push(child);
        return child as never;
      },
      () => 1_000_000
    );
    let enteredStop: () => void = () => {};
    const stopEntered = new Promise<void>(resolve => {
      enteredStop = resolve;
    });
    const wiring = (rec: typeof recorder): TeachDeps => ({
      spawnInput: () => undefined,
      pointer: async () => ({ x: 0, y: 0 }),
      snapshot: async () => undefined,
      startRecording: (display, name) => {
        try {
          const status = rec.start({ display, name, resolution: { width: 1280, height: 800 } });
          // ffmpeg creates the output as it encodes; the fake stands in for that so the
          // stop's size check has a file to stat.
          writeFileSync(status.path, "x");
          return { id: status.id, path: status.path };
        } catch {
          return undefined;
        }
      },
      stopRecording: async (display, id) => {
        enteredStop();
        const stopped = await rec.stopIfCurrent(display, id);
        return stopped === undefined ? undefined : { path: stopped.path };
      },
      execsBetween: async () => [],
    });
    const activeEntry = (display: number) =>
      (recorder as unknown as { active: Map<number, { status: { id: string } }> }).active.get(display)!.status;

    const service = new TeachService(wiring(recorder), join(root, "teach"));

    // Normal finish: the encoder receives "q" and the recorder reports the desktop free.
    await service.begin(1, 1);
    const stopping = service.finish(1, "handback");
    await stopEntered;
    assert.equal(encoders[0]!.written, "q", "the clean stop reaches the encoder");
    encoders[0]!.exit(0);
    await stopping;
    assert.equal(recorder.isRecording(1), false);
    assert.equal(service.queue.list().pending.length, 1);

    // Superseded finish: while the hand-back hung, an operator stopped A's recording and
    // started a fresh one on the same desktop. A's end() must leave the new recording
    // running and say so, never touching the new encoder.
    await service.begin(2, 1);
    const recordingA = activeEntry(2).id;
    const operatorStop = recorder.stop(2);
    encoders[1]!.exit(0); // the operator's stop settles A's encoder
    const stoppedByOperator = await operatorStop;
    assert.equal(stoppedByOperator!.id, recordingA);
    const startedByOperator = recorder.start({ display: 2, name: "operator", resolution: { width: 1280, height: 800 } });
    writeFileSync(startedByOperator.path, "x");
    assert.notEqual(startedByOperator.id, recordingA);

    const endedA = await service.finish(2, "handback");
    assert.ok(
      events(endedA!.eventsPath).some(e => e.type === "note" && /recording superseded/.test((e as { text: string }).text)),
      "the trace records that A's recording was superseded"
    );
    assert.equal(recorder.isRecording(2), true, "the operator's recording is untouched by A's end");
    assert.equal(encoders[2]!.written, "", "the new encoder never received a stop");
    const finalStop = recorder.stop(2);
    encoders[2]!.exit(0);
    await finalStop;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("generation regression: a begin awaiting an old finish re-evaluates instead of overwriting a newer generation", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentbox-teach-"));
  try {
    const backing = recorderBacked(root);
    const service = new TeachService(backing.deps, root);
    // A's end is held at its final snapshot, so begin(1,2) suspends inside finish(A)...
    backing.control.hold = true;
    await service.begin(1, 1);
    const pending2 = service.begin(1, 2);
    // ...and begin(1,3) lands while begin(1,2) is still awaiting: it must win the slot.
    const record3 = await service.begin(1, 3);
    const activeBefore = (service as unknown as { active: Map<number, TeachSession> }).active.get(1)!.epoch;
    assert.equal(activeBefore, 3);
    // Release A's end. The stale epoch-2 begin must NOT overwrite C: it re-evaluates,
    // finds generation 3 in place, and converges to it.
    backing.control.release!();
    const record2 = await pending2;
    const activeAfter = (service as unknown as { active: Map<number, TeachSession> }).active.get(1)!.epoch;
    assert.equal(activeAfter, 3, "the stale begin must not rewind the active generation");
    assert.equal(record2!.id, record3!.id, "it returns the newer session's record, not one of its own");
    assert.ok(record3 !== undefined);
    assert.equal(record3.endedAt, undefined, "C is un-ended and still live");
    assert.equal(service.queue.list().pending.length, 1, "only A was queued");
    await service.finish(1, "handback");
    assert.equal(service.queue.list().pending.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("generation regression: an awaited begin never regresses the epoch past an ENDING newer session", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentbox-teach-"));
  try {
    const backing = recorderBacked(root);
    // Both A's and C's end snapshots are held, so each finish suspends mid-end.
    let shots = 0;
    const gates: (() => void)[] = [];
    const held = [new Promise<void>(r => gates.push(r)), new Promise<void>(r => gates.push(r))];
    const deps: TeachDeps = {
      ...backing.deps,
      snapshot: async () => {
        const n = ++shots;
        if (n === 2) await held[0]!; // A's end snapshot
        if (n === 4) await held[1]!; // C's end snapshot
        return undefined;
      },
    };
    const s = new TeachService(deps, root);
    await s.begin(1, 1);
    const pendingB = s.begin(1, 2);          // waits on finish(A)
    const recordC = await s.begin(1, 3);     // claims the slot while A ends
    const endingC = s.finish(1, "handback"); // C starts ending, held at its end snapshot
    const active = (s as unknown as { active: Map<number, TeachSession> }).active.get(1)!;
    assert.equal(active.epoch, 3);
    assert.equal(active.ending, true);
    gates[0]!();                             // release A: the stale B2 resumes NOW
    const recordB = await pendingB;
    const after = (s as unknown as { active: Map<number, TeachSession> }).active.get(1)!;
    assert.equal(after.epoch, 3, "the stale begin must not rewind the active epoch");
    assert.equal(after.ending, true, "C still holds the slot and is still ending");
    assert.equal(recordB!.id, recordC!.id, "the stale begin converges to the newer session");
    gates[1]!();
    await endingC;
    assert.equal((s as unknown as { active: Map<number, TeachSession> }).active.get(1), undefined);
    assert.equal(s.queue.list().pending.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
