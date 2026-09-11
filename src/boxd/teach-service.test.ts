/**
 * The demonstration recorder, without X: lines are fed as xinput would print them, the
 * pointer, the outline and the recorder are scripted, and what lands on disk is checked.
 * The rule under test most of all: no key ever reaches the trace, only counts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyBurst, TeachService, TeachSession, parseXi2Line, type TeachDeps, type TeachEvent } from "./teach-service.ts";

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
      return { path: join(root, `${name}.mp4`) };
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
