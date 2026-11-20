/**
 * Tests for screen recording.
 *
 * ffmpeg is not run here — the spawner is injected — because what can actually be got
 * wrong is the lifecycle around it: refusing a second recorder on one desktop, escalating
 * when a clean stop is ignored, and not leaving a desktop marked as recording after the
 * encoder has died. The flags are asserted too, since a wrong container format produces a
 * file that only fails to play later.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const recordingsDir = mkdtempSync(join(tmpdir(), "agentbox-rec-"));
process.env.BOXD_RECORDINGS_DIR = recordingsDir;

const { RecordService, RecordingError, buildFfmpegArgs, pruneRecordings, recordingRetentionFrom, sanitizeName } = await import(
  "./record-service.ts"
);

/** Stands in for an ffmpeg process: records what was written and which signals arrived. */
class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  written = "";
  signals: string[] = [];
  stdin = {
    write: (chunk: string) => {
      this.written += chunk;
      return true;
    },
    end: () => {},
  };
  stderr = new EventEmitter();
  kill(signal: string) {
    this.signals.push(signal);
    if (signal === "SIGKILL") this.exit(137);
    return true;
  }
  exit(code: number) {
    this.exitCode = code;
    this.emit("exit", code);
  }
}

const resolution = { width: 1280, height: 800 };

function serviceWith(children: FakeChild[]) {
  let clock = 1_000_000;
  const service = new RecordService(
    () => {},
    () => {
      const child = new FakeChild();
      children.push(child);
      return child as never;
    },
    () => (clock += 1000)
  );
  return service;
}

test("the arguments produce a seekable, crash-tolerant file", () => {
  const args = buildFfmpegArgs({
    display: 2,
    resolution,
    framerate: 12,
    crf: 30,
    drawMouse: true,
    path: "/tmp/out.mp4",
  }).join(" ");

  assert.match(args, /-f x11grab/);
  assert.match(args, /-i :2/);
  assert.match(args, /-video_size 1280x800/);
  assert.match(args, /-draw_mouse 1/);
  assert.match(args, /-framerate 12/);
  assert.match(args, /-c:v libx264/);
  // Fragmented *and* flushed: fragmentation alone still left an unplayable stub when
  // the encoder was killed, because the output sat in ffmpeg's IO buffer.
  assert.match(args, /-movflags \+frag_keyframe\+empty_moov\+default_base_moof/);
  assert.match(args, /-flush_packets 1/);
  assert.match(args, /-frag_duration 1000000/);
  // A keyframe every two seconds, so the player can seek.
  assert.match(args, /-g 24/);
  assert.match(args, /-pix_fmt yuv420p/);
});

test("the pointer can be left out", () => {
  const args = buildFfmpegArgs({
    display: 1,
    resolution,
    framerate: 12,
    crf: 30,
    drawMouse: false,
    path: "/tmp/out.mp4",
  }).join(" ");
  assert.match(args, /-draw_mouse 0/);
});

test("names cannot escape the recordings directory", () => {
  assert.equal(sanitizeName("../../etc/passwd"), "etc-passwd");
  assert.equal(sanitizeName("a b/c;rm -rf"), "a-b-c-rm--rf");
  assert.equal(sanitizeName(""), "recording");
  assert.equal(sanitizeName("...."), "recording");
});

test("one recording per desktop, and desktops are independent", () => {
  const children: FakeChild[] = [];
  const service = serviceWith(children);

  const first = service.start({ display: 1, resolution });
  assert.ok(first.file.endsWith(".mp4"));
  assert.equal(service.isRecording(1), true);

  assert.throws(() => service.start({ display: 1, resolution }), RecordingError);

  service.start({ display: 2, resolution });
  assert.equal(service.isRecording(2), true);
  assert.equal(children.length, 2);
});

test("a clean stop asks ffmpeg to quit and reports the file", async () => {
  const children: FakeChild[] = [];
  const service = serviceWith(children);
  const started = service.start({ display: 1, resolution });

  const stopping = service.stop(1);
  // "q" is ffmpeg's documented clean shutdown; it writes the trailer and exits.
  assert.equal(children[0]!.written, "q");
  writeFileSync(started.path, "x".repeat(2048));
  children[0]!.exit(0);

  const finished = await stopping;
  assert.ok(finished !== undefined, "a live recording stops and reports");
  assert.equal(finished.size_bytes, 2048);
  assert.ok((finished.duration_ms ?? 0) > 0);
  assert.equal(service.isRecording(1), false);
  assert.deepEqual(children[0]!.signals, []);
});

test("a stuck encoder is escalated rather than waited on forever", async () => {
  const children: FakeChild[] = [];
  const service = serviceWith(children);
  const started = service.start({ display: 3, resolution });
  writeFileSync(started.path, "x");

  const stopping = service.stop(3);
  // Never exits on its own, so the service must escalate: q, SIGTERM, then SIGKILL.
  await stopping;
  assert.deepEqual(children[0]!.signals, ["SIGTERM", "SIGKILL"]);
});

test("an encoder that dies on its own frees the desktop", () => {
  const children: FakeChild[] = [];
  const service = serviceWith(children);
  service.start({ display: 1, resolution });

  children[0]!.stderr.emit("data", Buffer.from("x11grab: Cannot open display :1\n"));
  children[0]!.exit(1);

  assert.equal(service.isRecording(1), false);
  // And the desktop can be recorded again, rather than being stuck as busy.
  assert.doesNotThrow(() => service.start({ display: 1, resolution }));
});

test("stopping something that is not recording is idempotent success, not a crash", async () => {
  // the normal hand-back path has teach.finish stop the recorder first;
  // a resolve that then stops again must not be blocked by an error.
  const service = serviceWith([]);
  assert.equal(await service.stop(9), undefined);
});

test("stopIfCurrent stops only the recording it names", async () => {
  const children: FakeChild[] = [];
  const service = serviceWith(children);
  const started = service.start({ display: 1, resolution });
  writeFileSync(started.path, "x");

  // The id is the identity; the file is presentation. A finished listing can reuse the
  // file name, which is exactly why the id exists.
  assert.ok(started.id !== undefined && started.id !== started.file);
  // A stale identity — the recording it refers to is gone — stops nothing.
  assert.equal(await service.stopIfCurrent(1, "somebody-elses-id"), undefined);
  assert.equal(service.isRecording(1), true, "the current recording keeps running");
  assert.equal(children[0]!.written, "", "no stop was sent to the encoder");

  // The current identity stops it, exactly as a plain stop would.
  const stopping = service.stopIfCurrent(1, started.id);
  assert.equal(children[0]!.written, "q");
  children[0]!.exit(0);
  const stopped = await stopping;
  assert.ok(stopped !== undefined && stopped.id === started.id && stopped.file === started.file);
  assert.equal(service.isRecording(1), false);
});


test("a spawn failure is reported, not fatal to the daemon", () => {
  // A child's `error` event with no listener is fatal to the whole process. So an EAGAIN under load
  // — the moment starting a second encoder is most likely to fail — took boxd down, and its
  // supervisor restarted it into a box whose first recorder was now an orphan.
  const lines: string[] = [];
  const children: FakeChild[] = [];
  let clock = 1_000_000;
  const service = new RecordService(
    line => lines.push(line),
    () => {
      const child = new FakeChild();
      children.push(child);
      return child as never;
    },
    () => (clock += 1000)
  );

  service.start({ display: 1, resolution });
  assert.equal(service.isRecording(1), true);

  children[0]?.emit("error", new Error("spawn ffmpeg EAGAIN"));

  assert.equal(service.isRecording(1), false, "the desktop is free to be tried again");
  assert.ok(
    lines.some(line => /could not start: spawn ffmpeg EAGAIN/.test(line)),
    `expected it to say why, got ${JSON.stringify(lines)}`
  );

  // And the next attempt is not refused by a recording that never existed.
  service.start({ display: 1, resolution });
  assert.equal(service.isRecording(1), true);
});

test("orphaned encoders are looked for, and finding none is not an error", () => {
  // The reclamation reads /proc, which a developer's machine does not have. It must be silent and
  // harmless there rather than throwing on startup.
  const service = new RecordService(() => {});
  assert.equal(service.reclaimOrphans(), 0);
});

const DAY = 24 * 60 * 60_000;
const MB = 1024 * 1024;

/** A finished recording of `bytes`, last written `ageMs` before `now`. */
function recordingAt(dir: string, name: string, bytes: number, now: number, ageMs: number): void {
  const path = join(dir, name);
  writeFileSync(path, Buffer.alloc(bytes));
  utimesSync(path, (now - ageMs) / 1000, (now - ageMs) / 1000);
}

test("retention defaults to 14 days and 2 GB per box, and is configurable (INV-1949)", () => {
  assert.deepEqual(recordingRetentionFrom({}), { keepMs: 14 * DAY, keepBytes: 2048 * MB, minFreeBytes: 512 * MB });
  const set = recordingRetentionFrom({ BOXD_RECORDINGS_KEEP_DAYS: "3", BOXD_RECORDINGS_KEEP_MB: "100", BOXD_RECORDINGS_MIN_FREE_MB: "0" });
  assert.deepEqual(set, { keepMs: 3 * DAY, keepBytes: 100 * MB, minFreeBytes: 0 });
  assert.equal(recordingRetentionFrom({ BOXD_RECORDINGS_KEEP_DAYS: "soon" }).keepMs, 14 * DAY, "garbage keeps the default");
});

test("recordings past the retention period are deleted; younger ones and other files stay", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-rec-age-"));
  const now = Date.UTC(2026, 10, 19);
  recordingAt(dir, "old.mp4", 10, now, 15 * DAY);
  recordingAt(dir, "young.mp4", 10, now, 13 * DAY);
  recordingAt(dir, "notes.txt", 10, now, 30 * DAY);

  const pruned = pruneRecordings(dir, { keepMs: 14 * DAY, keepBytes: 0 }, now);

  assert.deepEqual(pruned, { removed: ["old.mp4"], freedBytes: 10 });
  assert.deepEqual(readdirSync(dir).sort(), ["notes.txt", "young.mp4"]);
});

test("over the per-box ceiling the oldest recordings go first, until the rest fit", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-rec-size-"));
  const now = Date.UTC(2026, 10, 19);
  recordingAt(dir, "a-oldest.mp4", 400, now, 3 * DAY);
  recordingAt(dir, "b-older.mp4", 400, now, 2 * DAY);
  recordingAt(dir, "c-newer.mp4", 400, now, 1 * DAY);
  recordingAt(dir, "d-newest.mp4", 400, now, 0);

  const pruned = pruneRecordings(dir, { keepMs: 14 * DAY, keepBytes: 1000 }, now);

  assert.deepEqual(pruned.removed, ["a-oldest.mp4", "b-older.mp4"]);
  assert.deepEqual(readdirSync(dir).sort(), ["c-newer.mp4", "d-newest.mp4"]);
});

test("a recording still being written is never pruned, however old or large", async () => {
  const now = Date.UTC(2026, 10, 19);
  const lines: string[] = [];
  const children: FakeChild[] = [];
  const service = new RecordService(
    line => lines.push(line),
    () => {
      const child = new FakeChild();
      children.push(child);
      return child as never;
    },
    () => now,
    { keepMs: DAY, keepBytes: 1, minFreeBytes: 0 },
    () => undefined
  );
  recordingAt(recordingsDir, "stale-before.mp4", 10, now, 2 * DAY);
  const live = service.start({ display: 7, resolution, name: "live" });
  assert.equal(existsSync(join(recordingsDir, "stale-before.mp4")), false, "starting a recording applies the retention");
  recordingAt(recordingsDir, live.file, 10, now, 2 * DAY);

  service.prune();

  assert.ok(existsSync(join(recordingsDir, live.file)), "the file ffmpeg is writing stays");
  // Nor while ffmpeg is finishing it after a stop was asked for.
  const stopping = service.stop(7);
  service.prune();
  assert.ok(existsSync(join(recordingsDir, live.file)), "the file ffmpeg is closing stays");
  children[0]?.exit(0);
  await stopping;
  assert.ok(lines.some(line => /removed \d+ recording\(s\) past retention/.test(line)), JSON.stringify(lines));
});

test("a recording is refused, with the reason, when the work volume is nearly full", () => {
  const spawned: FakeChild[] = [];
  const service = new RecordService(
    () => {},
    () => {
      const child = new FakeChild();
      spawned.push(child);
      return child as never;
    },
    () => Date.now(),
    { keepMs: 14 * DAY, keepBytes: 2048 * MB, minFreeBytes: 512 * MB },
    () => ({ free: 100 * MB, total: 10_000 * MB })
  );

  assert.throws(
    () => service.start({ display: 8, resolution }),
    (error: unknown) =>
      error instanceof RecordingError &&
      /Not enough disk space to record desktop 8: 100 MB free.*at least 512 MB/.test(error.message)
  );
  assert.equal(spawned.length, 0, "no encoder is started");
  assert.equal(service.isRecording(8), false);
});
