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
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const recordingsDir = mkdtempSync(join(tmpdir(), "agentbox-rec-"));
process.env.BOXD_RECORDINGS_DIR = recordingsDir;

const { RecordService, RecordingError, buildFfmpegArgs, sanitizeName } = await import(
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

test("stopping something that is not recording is an error, not a crash", async () => {
  const service = serviceWith([]);
  await assert.rejects(() => service.stop(9), RecordingError);
});
