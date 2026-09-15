/**
 * A demonstration, recorded while a person holds the desktop (INV-405, docs/49 C2).
 *
 * Grok Bot's teach mode has only pixels to learn from and reconstructs URLs from the
 * browser's history afterwards. Ours starts the moment a person takes the desktop over
 * (INV-404) and keeps, beside the video, what the box can see for itself: every click with
 * its screen position and the window it landed in, every burst of typing as a *count* —
 * never the keys, never the text — and, after each click and each burst, the browser's
 * outline of the page with its URL, which is where the typed values show up (password
 * fields redacted, as in every outline). Shell commands the person ran arrive from
 * xwatchdog at the end. Handing the desktop back, or the lease lapsing, closes the
 * session and queues it for a teaching turn (INV-406), with Grok Bot's pending / claimed /
 * lease shape so a turn that dies mid-way does not lose the recording.
 *
 * Under /home/box/work, which survives a rebuild. A session is a directory: session.json,
 * events.jsonl, and the video the recorder wrote.
 */

import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendLine } from "../host/jsonl.ts";
import { copyTeachBinding, type TeachBinding, type TeachQueueEntry } from "../protocol/index.ts";

export const TEACH_ROOT = process.env.BOXD_TEACH_DIR ?? "/home/box/work/teach-sessions";
/** A typing burst ends after this much silence. */
export const KEY_BURST_GAP_MS = 1_200;
/** A click's outline is taken after the page has had this long to react. */
export const CLICK_SETTLE_MS = 700;
/** A claim nobody finished goes back to pending after this long. */
export const CLAIM_LEASE_MS = 12 * 60 * 60_000;

export type TeachEvent =
  | { at: string; type: "click"; button: number; x: number; y: number; window?: string; title?: string }
  | { at: string; type: "keys"; count: number; from: string; to: string }
  | { at: string; type: "snapshot"; url: string; title: string; snapshot_id?: string; outline: string; after: "click" | "keys" | "start" | "end" }
  | { at: string; type: "navigation"; from: string; to: string }
  | { at: string; type: "exec"; cmd: string; user?: string }
  | { at: string; type: "note"; text: string };

export interface TeachSessionRecord {
  id: string;
  display: number;
  startedAt: string;
  endedAt?: string;
  /** Why it ended: the person handed back, the lease lapsed, or the daemon stopped. */
  endedBy?: "handback" | "lapse" | "shutdown";
  videoPath?: string;
  eventsPath: string;
  counts: { clicks: number; keyBursts: number; snapshots: number; execs: number };
  binding?: TeachBinding;
  epoch?: number;
}

export class TeachBindingConflict extends Error {}

/** The raw XI2 event a line of `xinput test-xi2 --root` announces, or nothing. */
export function parseXi2Line(line: string): { kind: "button" | "key"; press: boolean } | undefined {
  const match = /^EVENT type \d+ \((Raw(Button|Key)(Press|Release))\)/.exec(line.trim());
  if (match === null) return undefined;
  return { kind: match[2] === "Button" ? "button" : "key", press: match[3] === "Press" };
}

/**
 * Turns key presses into bursts: one event per run of typing, with a count and never a
 * key. The gap is what separates "typed a sentence" from "typed a word, read, typed".
 */
export class KeyBurst {
  private count = 0;
  private from: number | undefined;
  private last: number | undefined;

  constructor(private readonly gapMs = KEY_BURST_GAP_MS) {}

  /** Records a press; returns the burst that just ended, if this press started a new one. */
  press(at: number): { count: number; from: number; to: number } | undefined {
    let ended: { count: number; from: number; to: number } | undefined;
    if (this.last !== undefined && at - this.last > this.gapMs) ended = this.flush();
    if (this.from === undefined) this.from = at;
    this.count += 1;
    this.last = at;
    return ended;
  }

  /** The open burst, closed; undefined when nothing was typed. */
  flush(): { count: number; from: number; to: number } | undefined {
    if (this.from === undefined || this.last === undefined || this.count === 0) return undefined;
    const burst = { count: this.count, from: this.from, to: this.last };
    this.count = 0;
    this.from = undefined;
    this.last = undefined;
    return burst;
  }

  /** Whether a burst is open and has gone quiet. */
  idleSince(now: number): boolean {
    return this.last !== undefined && now - this.last > this.gapMs;
  }
}

/** What the session needs from the box, injected so the lifecycle is testable without X. */
export interface TeachDeps {
  /** Starts `xinput test-xi2 --root` on the display; undefined when it cannot. */
  spawnInput: (display: number) => ChildProcess | undefined;
  /** Where the pointer is and which window is under it. */
  pointer: (display: number) => Promise<{ x: number; y: number; window?: string; title?: string }>;
  /** The browser's outline, or undefined when no browser is open on this desktop. */
  snapshot: (display: number) => Promise<{ url: string; title: string; snapshot: string; snapshot_id?: string } | undefined>;
  /**
   * Starts the recording and returns both its immutable identity (captured by the
   * session; stop-by-identity uses it) and its file path (presentation).
   */
  startRecording: (display: number, name: string) => { id: string; path: string } | undefined;
  /**
   * Stops the recording that began as `recordingId`, whatever the desktop's recording
   * state is now. Returning undefined means "not the current recording any more": the
   * session must leave whatever is recording now alone.
   */
  stopRecording: (display: number, recordingId: string) => Promise<{ path: string } | undefined>;
  /** Shell commands run on the box between two instants. */
  execsBetween: (from: string, to: string) => Promise<{ at: string; cmd: string; user?: string }[]>;
  now?: () => number;
  log?: (line: string) => void;
}

const defaultInputSpawner = (display: number): ChildProcess | undefined => {
  try {
    return spawn("xinput", ["test-xi2", "--root"], {
      env: { ...process.env, DISPLAY: `:${display}` },
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
};

export class TeachSession {
  readonly id: string;
  readonly dir: string;
  readonly record: TeachSessionRecord;
  private input: ChildProcess | undefined;
  private readonly bursts: KeyBurst;
  private lastUrl: string | undefined;
  private clickTimer: NodeJS.Timeout | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private ended = false;
  /**
   * Set synchronously when end() begins, before its first await. The service uses it to
   * tell "a session that is closing" from "the desktop's live session": a takeover that
   * arrives while the old session is still ending must start a fresh session, not be
   * folded into the dying one.
   */
  ending = false;
  /**
   * The identity captured when the session began: its own session id,
   * the recording that this session started, and the displayEpoch the desktop was armed
   * with at begin time. Immutable on purpose — an end() that ran after the desktop was
   * handed to a newer incarnation must still act for *this* identity: it stops the
   * recording it began, never "whatever the desktop is recording now".
   */
  private recordingId: string | undefined;
  readonly epoch: number | undefined;
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(
    readonly display: number,
    private readonly deps: TeachDeps,
    root = TEACH_ROOT,
    gapMs = KEY_BURST_GAP_MS,
    epoch?: number,
    binding?: TeachBinding
  ) {
    this.now = deps.now ?? (() => Date.now());
    this.log = deps.log ?? (() => {});
    this.epoch = epoch;
    this.bursts = new KeyBurst(gapMs);
    const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, "-").slice(0, 19);
    // The stamp only has second resolution, and two incarnations of one desktop can
    // begin in the same second (a hand-back racing the next takeover). The id — and the
    // directory derived from it — must be unique per incarnation regardless: a shared id
    // would merge distinct sessions in every map and queue keyed on it.
    this.id = `teach-${stamp}-d${display}-${randomUUID().slice(0, 8)}`;
    this.dir = join(root, this.id);
    mkdirSync(this.dir, { recursive: true });
    this.record = {
      id: this.id,
      display,
      startedAt: new Date(this.now()).toISOString(),
      eventsPath: join(this.dir, "events.jsonl"),
      counts: { clicks: 0, keyBursts: 0, snapshots: 0, execs: 0 },
      ...(binding === undefined ? {} : { binding: copyTeachBinding(binding) }),
      ...(epoch === undefined ? {} : { epoch }),
    };
  }

  async start(): Promise<void> {
    const video = this.deps.startRecording(this.display, this.id);
    if (video !== undefined) {
      this.record.videoPath = video.path;
      this.recordingId = video.id;
    }
    this.input = this.deps.spawnInput(this.display);
    if (this.input?.stdout) {
      let buffer = "";
      this.input.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) this.onInputLine(line);
      });
    } else {
      this.note("input capture unavailable: clicks and typing will not be in the trace; the video still is");
    }
    this.writeSession();
    await this.takeSnapshot("start");
  }

  /** One line of xinput output. Public so a test can feed lines without a process. */
  onInputLine(line: string): void {
    if (this.ended) return;
    const event = parseXi2Line(line);
    if (event === undefined || !event.press) return;
    const at = this.now();
    if (event.kind === "button") {
      // The button number is on the next `detail:` line; the click is recorded when the
      // pointer is read, which is what the coordinates are anyway.
      void this.onClick(at);
      return;
    }
    const ended = this.bursts.press(at);
    if (ended !== undefined) this.closeBurst(ended);
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      const burst = this.bursts.flush();
      if (burst !== undefined) this.closeBurst(burst);
    }, this.gap() + 50);
  }

  private gap(): number {
    return (this.bursts as unknown as { gapMs: number }).gapMs;
  }

  private async onClick(at: number): Promise<void> {
    // A click ends whatever was being typed: the value is on the page now.
    const burst = this.bursts.flush();
    if (burst !== undefined) this.closeBurst(burst);
    let where: { x: number; y: number; window?: string; title?: string };
    try {
      where = await this.deps.pointer(this.display);
    } catch {
      where = { x: -1, y: -1 };
    }
    this.append({ at: new Date(at).toISOString(), type: "click", button: 1, ...where });
    this.record.counts.clicks += 1;
    if (this.clickTimer !== undefined) clearTimeout(this.clickTimer);
    this.clickTimer = setTimeout(() => void this.takeSnapshot("click"), CLICK_SETTLE_MS);
  }

  private closeBurst(burst: { count: number; from: number; to: number }): void {
    this.append({ at: new Date(burst.to).toISOString(), type: "keys", count: burst.count, from: new Date(burst.from).toISOString(), to: new Date(burst.to).toISOString() });
    this.record.counts.keyBursts += 1;
    void this.takeSnapshot("keys");
  }

  private async takeSnapshot(after: "click" | "keys" | "start" | "end"): Promise<void> {
    if (this.ended && after !== "end") return;
    let page: Awaited<ReturnType<TeachDeps["snapshot"]>>;
    try {
      page = await this.deps.snapshot(this.display);
    } catch {
      page = undefined;
    }
    if (page === undefined) return;
    if (this.lastUrl !== undefined && this.lastUrl !== page.url) {
      this.append({ at: new Date(this.now()).toISOString(), type: "navigation", from: this.lastUrl, to: page.url });
    }
    this.lastUrl = page.url;
    this.append({
      at: new Date(this.now()).toISOString(),
      type: "snapshot",
      url: page.url,
      title: page.title,
      ...(page.snapshot_id !== undefined ? { snapshot_id: page.snapshot_id } : {}),
      outline: page.snapshot,
      after,
    });
    this.record.counts.snapshots += 1;
  }

  private note(text: string): void {
    this.append({ at: new Date(this.now()).toISOString(), type: "note", text });
  }

  private append(event: TeachEvent): void {
    appendLine(this.record.eventsPath, JSON.stringify(event));
  }

  private writeSession(): void {
    writeFileSync(join(this.dir, "session.json"), `${JSON.stringify(this.record, null, 2)}\n`, "utf8");
  }

  /**
   * Stops the recording this session began, by the identity captured at begin time.
   *
   * If the desktop's current recording is not this one — the desktop was handed on and a
   * newer session started its own — the stop is skipped and the trace says so. This check
   * must select the recording atomically and never re-resolve "the display's current
   * recording" after an await: the round-5 reproduction was an end() that passed the
   * entry guard, waited, and then stopped the *new* incarnation's recording.
   */
  private async stopRecordingByIdentity(): Promise<void> {
    if (this.recordingId === undefined) return;
    try {
      const video = await this.deps.stopRecording(this.display, this.recordingId);
      if (video !== undefined) {
        this.record.videoPath = video.path;
      } else {
        this.note("recording superseded: this session's recording is no longer the desktop's current one; it was left recording");
      }
    } catch (error) {
      this.note(`recording did not stop cleanly: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Closes the session: last outline, recording stopped, shell history appended, queued. */
  async end(by: TeachSessionRecord["endedBy"]): Promise<TeachSessionRecord> {
    if (this.ended) return this.record;
    this.ending = true;
    if (this.clickTimer !== undefined) clearTimeout(this.clickTimer);
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    const burst = this.bursts.flush();
    if (burst !== undefined) this.closeBurst(burst);
    await this.takeSnapshot("end");
    this.ended = true;
    try {
      this.input?.kill();
    } catch {
      // Already gone.
    }
    const endedAt = new Date(this.now()).toISOString();
    await this.stopRecordingByIdentity();
    try {
      for (const exec of await this.deps.execsBetween(this.record.startedAt, endedAt)) {
        this.append({ at: exec.at, type: "exec", cmd: exec.cmd, ...(exec.user !== undefined ? { user: exec.user } : {}) });
        this.record.counts.execs += 1;
      }
    } catch {
      this.note("shell history unavailable for this window");
    }
    this.record.endedAt = endedAt;
    this.record.endedBy = by;
    this.writeSession();
    this.log(`teach ${this.id}: ${this.record.counts.clicks} click(s), ${this.record.counts.keyBursts} typing burst(s), ${this.record.counts.snapshots} outline(s), ended by ${by}`);
    return this.record;
  }
}

// ── the queue ───────────────────────────────────────────────────────────────────────

export type QueueEntry = TeachQueueEntry;

/**
 * Grok Bot's shape: pending/ and claimed/ directories, a claim is an atomic rename plus
 * a lease file, and a claim whose lease lapsed goes back to pending on the next look.
 */
export class TeachQueue {
  constructor(private readonly root = TEACH_ROOT, private readonly now: () => number = () => Date.now()) {}

  private dir(name: "pending" | "claimed"): string {
    const path = join(this.root, "queues", name);
    mkdirSync(path, { recursive: true });
    return path;
  }

  enqueue(record: TeachSessionRecord, sessionDir: string): void {
    const entry: QueueEntry = {
      id: record.id,
      sessionDir,
      display: record.display,
      startedAt: record.startedAt,
      ...(record.endedAt !== undefined ? { endedAt: record.endedAt } : {}),
      ...(record.videoPath !== undefined ? { videoPath: record.videoPath } : {}),
      ...(record.binding !== undefined ? { binding: copyTeachBinding(record.binding) } : {}),
      ...(record.epoch !== undefined ? { epoch: record.epoch } : {}),
    };
    writeFileSync(join(this.dir("pending"), `${record.id}.json`), `${JSON.stringify(entry, null, 2)}\n`, "utf8");
  }

  private read(path: string): QueueEntry | undefined {
    try {
      return JSON.parse(readFileSync(path, "utf8")) as QueueEntry;
    } catch {
      return undefined;
    }
  }

  /** Lapsed claims back to pending, so a dead teaching turn does not lose its recording. */
  private reap(): void {
    const claimed = this.dir("claimed");
    for (const name of readdirSync(claimed).filter(n => n.endsWith(".json"))) {
      const lease = join(claimed, `${name}.lease`);
      let expired: boolean;
      try {
        expired = statSync(lease).mtimeMs + CLAIM_LEASE_MS < this.now();
      } catch {
        expired = true;
      }
      if (expired) {
        renameSync(join(claimed, name), join(this.dir("pending"), name));
        rmSync(lease, { force: true });
      }
    }
  }

  list(): { pending: QueueEntry[]; claimed: QueueEntry[] } {
    this.reap();
    const load = (which: "pending" | "claimed") =>
      readdirSync(this.dir(which))
        .filter(n => n.endsWith(".json"))
        .sort()
        .map(n => this.read(join(this.dir(which), n)))
        .filter((e): e is QueueEntry => e !== undefined);
    return { pending: load("pending"), claimed: load("claimed") };
  }

  /** The oldest pending session, moved to claimed with a fresh lease; undefined when none. */
  claim(id?: string): QueueEntry | undefined {
    this.reap();
    const pending = this.dir("pending");
    for (const name of readdirSync(pending).filter(n => n.endsWith(".json")).sort()) {
      if (id !== undefined && name !== `${id}.json`) continue;
      const target = join(this.dir("claimed"), name);
      try {
        renameSync(join(pending, name), target);
      } catch {
        continue;
      }
      const leaseUntil = new Date(this.now() + CLAIM_LEASE_MS).toISOString();
      writeFileSync(`${target}.lease`, `${leaseUntil}\n`, "utf8");
      const entry = this.read(target);
      return entry === undefined ? undefined : { ...entry, leaseUntil };
    }
    return undefined;
  }

  /** Gives a claim back without finishing it. */
  release(id: string): boolean {
    const target = join(this.dir("claimed"), `${id}.json`);
    if (!existsSync(target)) return false;
    renameSync(target, join(this.dir("pending"), `${id}.json`));
    rmSync(`${target}.lease`, { force: true });
    return true;
  }

  /** The teaching turn is done: the claim goes; the video may go with it. */
  done(id: string, deleteVideo = false): boolean {
    const target = join(this.dir("claimed"), `${id}.json`);
    const entry = this.read(target);
    if (entry === undefined) return false;
    rmSync(target, { force: true });
    rmSync(`${target}.lease`, { force: true });
    if (deleteVideo && entry.videoPath !== undefined) rmSync(entry.videoPath, { force: true });
    return true;
  }
}

/** One session per desktop; starts on takeover, ends on hand-back or lapse. */
export class TeachService {
  private readonly active = new Map<number, TeachSession>();
  /**
   * In-flight finishes keyed by the session object itself: a second
   * finish for a session whose end is already running — a doubled hand-back, a reaper
   * pass racing the route — returns the same promise instead of finding the session gone
   * and starting nothing. Object identity, not the session id, is the key: same-second
   * incarnations of one desktop have distinct ids now, but even the id must never be the
   * thing that decides two sessions are one.
   */
  private readonly finishing = new Map<TeachSession, Promise<TeachSessionRecord | undefined>>();
  readonly queue: TeachQueue;

  constructor(private readonly deps: TeachDeps, private readonly root = TEACH_ROOT) {
    this.queue = new TeachQueue(root, deps.now);
  }

  isTeaching(display: number): boolean {
    return this.active.has(display);
  }

  /**
   * The highest control generation a session has ever claimed on this desktop, this
   * boot. The slot's epoch NEVER regresses: a begin older than the floor is stale
   * wherever it finds the slot — held by a live session, held by an ending one, or
   * empty because the newer session just finished. This is what stops a begin that
   * passed the route's entry guard before a generation swap from reopening an older
   * scene after the swap (the generation regression sequences, including the double-finishing
   * interleaving where a newer session is ENDING when the stale begin resumes).
   */
  private readonly epochFloor = new Map<number, number>();

  /**
   * Begins a session on a takeover. A live session from the same control generation is
   * one session — a repeated takeover returns it. A strictly newer epoch is a new
   * generation: the old session is ended through the normal finish path (its recording
   * stops by identity, so a generation swap can never stop the wrong encoder), and then
   * the whole decision is re-made from the current state before anything is created.
   *
   * The re-evaluation is conditional on the epoch floor, not on the slot's current
   * holder: while this call awaited the old session's end, a higher-epoch begin may
   * have claimed — and even started ending on — the desktop. The slot claim itself is
   * synchronous, so two racing begins cannot both pass the check; the loser's
   * re-evaluation converges to the winner instead of overwriting it.
   */
  /** Check before the control route changes the lease; begin repeats it after awaits. */
  validateBegin(display: number, epoch?: number, teaching?: TeachBinding): void {
    const binding = copyTeachBinding(teaching);
    const existing = this.active.get(display);
    if (existing && !existing.ending && (epoch === undefined || existing.epoch === undefined || epoch <= existing.epoch)
      && JSON.stringify(binding) !== JSON.stringify(existing.record.binding)) {
      throw new TeachBindingConflict("The active demonstration belongs to another agent or task");
    }
  }

  async begin(display: number, epoch?: number, teaching?: TeachBinding): Promise<TeachSessionRecord | undefined> {
    const binding = copyTeachBinding(teaching);
    for (;;) {
      this.validateBegin(display, epoch, binding);
      const existing = this.active.get(display);
      if (existing !== undefined && !existing.ending) {
        const existingEpoch = existing.epoch;
        if (epoch === undefined || existingEpoch === undefined || epoch <= existingEpoch) {
          return existing.record;
        }
        await this.finish(display, "handback");
        continue;
      }
      // The slot is empty or held by an ending session. Either way, a begin below the
      // desktop's generation floor is stale: it must never claim the slot, because that
      // would rewind the active epoch even when the newer session it raced is ending or
      // has just finished.
      const floor = this.epochFloor.get(display) ?? 0;
      if (epoch !== undefined && epoch < floor) {
        return existing?.record;
      }
      const session = new TeachSession(display, this.deps, this.root, KEY_BURST_GAP_MS, epoch, binding);
      // Claim the slot before the first await: the check above and this set are one
      // atomic step, so a concurrent begin either sees this session or wins the slot
      // itself — never both.
      this.active.set(display, session);
      if (epoch !== undefined && epoch > floor) this.epochFloor.set(display, epoch);
      try {
        await session.start();
      } catch (error) {
        if (this.active.get(display) === session) this.active.delete(display);
        this.deps.log?.(`teach: could not start on desktop ${display}: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      }
      return session.record;
    }
  }

  async finish(display: number, by: TeachSessionRecord["endedBy"]): Promise<TeachSessionRecord | undefined> {
    const session = this.active.get(display);
    if (session === undefined) return undefined;
    // Already ending: the concurrent caller joins the in-flight finish instead of
    // starting a second end() for the same session.
    if (session.ending) return this.finishing.get(session);
    const inFlight = this.finishing.get(session);
    if (inFlight !== undefined) return inFlight;
    const promise = this.endAndEnqueue(session, by);
    this.finishing.set(session, promise);
    try {
      return await promise;
    } finally {
      this.finishing.delete(session);
      // A newer session may have taken the desktop's slot while this one was ending; only
      // release the slot when it is still ours.
      if (this.active.get(display) === session) this.active.delete(display);
    }
  }

  /** Ends the session and queues it; the sole body every finish path runs through. */
  private async endAndEnqueue(session: TeachSession, by: TeachSessionRecord["endedBy"]): Promise<TeachSessionRecord> {
    const record = await session.end(by);
    this.queue.enqueue(record, session.dir);
    return record;
  }

  /** Ends every session whose desktop is no longer a person's. Run on a timer. */
  async reapLapsed(stillHeld: (display: number) => boolean): Promise<void> {
    for (const display of [...this.active.keys()]) {
      if (!stillHeld(display)) await this.finish(display, "lapse");
    }
  }

  async shutdown(): Promise<void> {
    for (const display of [...this.active.keys()]) await this.finish(display, "shutdown");
  }
}

export { defaultInputSpawner };
