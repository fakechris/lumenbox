/**
 * Screen recording, one recording per desktop.
 *
 * A transcript says what an agent claims it did and a screenshot shows one instant.
 * Neither answers the question a person actually has while accepting this work — what
 * did it *do* — and by the time something looks wrong, the screen has moved on. So the
 * desktop can be recorded while the agents work.
 *
 * Choices that are not obvious:
 *
 * Fragmented MP4, not plain MP4. A plain MP4 writes its index when the encoder exits, so
 * a recorder that is killed leaves an unplayable file — the exact case worth recording.
 * A browser can play fragmented MP4 directly, which Matroska does not give us.
 *
 * Fragmentation alone was not enough, which only showed up on testing it: SIGKILL left a
 * 28-byte file and "moov atom not found", because ffmpeg's output sat in its IO buffer
 * and a fragment only closes on a keyframe. -flush_packets writes each packet through,
 * and -frag_duration closes a fragment every second regardless of keyframes. Measured
 * rather than assumed: killing a six-second recording used to leave 28 unplayable bytes
 * and now leaves a playable three seconds, so a kill costs the tail rather than the
 * whole file. Encoder buffering is why it is not the full six.
 *
 * Stopped by writing "q" to ffmpeg's stdin, which is its documented clean shutdown, and
 * escalated to signals only when that does not land. A SIGKILL on the first attempt
 * would truncate the last fragment for no reason.
 *
 * The frame rate and quality are deliberately modest — 12fps, CRF 30 — because this
 * shares a CPU with the agents' browser. Recording at 60fps all-intra is what video
 * editing wants; that is a different purpose and roughly twenty times the bitrate.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Under the work volume, so recordings outlive the container that made them. */
export const RECORDINGS_DIR = process.env.BOXD_RECORDINGS_DIR ?? "/home/box/work/recordings";

export const DEFAULT_FRAMERATE = 12;
export const DEFAULT_CRF = 30;

/** How long a clean "q" gets before signals. */
const QUIT_GRACE_MS = 4000;
const TERM_GRACE_MS = 3000;

export interface RecordingStatus {
  display: number;
  file: string;
  path: string;
  started_at: string;
  /** Absent while recording; set once the file is closed. */
  size_bytes?: number;
  duration_ms?: number;
}

export interface StartOptions {
  display: number;
  resolution: { width: number; height: number };
  framerate?: number;
  crf?: number;
  /** The pointer is drawn by default: reviewing a click means seeing where it was. */
  drawMouse?: boolean;
  name?: string;
}

/** Injected so the argument building and lifecycle are testable without ffmpeg. */
export type Spawner = (command: string, args: readonly string[]) => ChildProcess;

const defaultSpawner: Spawner = (command, args) =>
  spawn(command, [...args], { stdio: ["pipe", "ignore", "pipe"] });

export class RecordingError extends Error {}

/** A safe file name: this can reach the shell-free spawn, but also a URL and a disk. */
export function sanitizeName(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[.-]+/, "").slice(0, 80);
  return cleaned || "recording";
}

export function buildFfmpegArgs(options: {
  display: number;
  resolution: { width: number; height: number };
  framerate: number;
  crf: number;
  drawMouse: boolean;
  path: string;
}): string[] {
  const { display, resolution, framerate, crf, drawMouse, path } = options;
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "x11grab",
    "-draw_mouse",
    drawMouse ? "1" : "0",
    "-framerate",
    String(framerate),
    "-video_size",
    `${resolution.width}x${resolution.height}`,
    "-i",
    `:${display}`,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    String(crf),
    // x264 needs even dimensions for yuv420p, and yuv420p is what plays everywhere.
    "-vf",
    "pad=ceil(iw/2)*2:ceil(ih/2)*2",
    "-pix_fmt",
    "yuv420p",
    // A keyframe every two seconds: enough to seek by, far cheaper than all-intra.
    "-g",
    String(framerate * 2),
    "-movflags",
    "+frag_keyframe+empty_moov+default_base_moof",
    // See the header: without these, a killed recorder leaves an unplayable stub.
    "-flush_packets",
    "1",
    "-frag_duration",
    "1000000",
    "-y",
    path,
  ];
}

interface Active {
  status: RecordingStatus;
  child: ChildProcess;
  startedAtMs: number;
  stderr: string;
}

export class RecordService {
  private readonly active = new Map<number, Active>();

  constructor(
    private readonly log: (line: string) => void,
    private readonly spawner: Spawner = defaultSpawner,
    private readonly now: () => number = () => Date.now()
  ) {}

  isRecording(display: number): boolean {
    return this.active.has(display);
  }

  start(options: StartOptions): RecordingStatus {
    const { display, resolution } = options;
    if (this.active.has(display)) {
      throw new RecordingError(`Desktop ${display} is already being recorded.`);
    }

    mkdirSync(RECORDINGS_DIR, { recursive: true });

    const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const base = options.name ? sanitizeName(options.name) : `desktop-${display}`;
    const file = `${base}-${stamp}.mp4`;
    const path = join(RECORDINGS_DIR, file);

    const args = buildFfmpegArgs({
      display,
      resolution,
      framerate: options.framerate ?? DEFAULT_FRAMERATE,
      crf: options.crf ?? DEFAULT_CRF,
      drawMouse: options.drawMouse ?? true,
      path,
    });

    const child = this.spawner("ffmpeg", args);
    const entry: Active = {
      status: {
        display,
        file,
        path,
        started_at: new Date(this.now()).toISOString(),
      },
      child,
      startedAtMs: this.now(),
      stderr: "",
    };

    // A spawn failure arrives as an `error` event, and an `error` event with no listener is fatal
    // to the whole daemon. So an EAGAIN under load — the moment when starting a second encoder is
    // most likely to fail — took boxd down with it, and its supervisor restarted it into a box
    // whose first recorder was now an orphan.
    child.on("error", error => {
      if (this.active.get(display) === entry) this.active.delete(display);
      entry.stderr = `${entry.stderr}\nfailed to start ffmpeg: ${error.message}`.slice(-4000);
      this.log(`recording on desktop ${display} could not start: ${error.message}`);
    });

    // Kept because ffmpeg reports why it failed on stderr and then exits; without it a
    // recording that never started looks identical to one that is running.
    child.stderr?.on("data", (chunk: Buffer) => {
      entry.stderr = `${entry.stderr}${chunk.toString()}`.slice(-4000);
    });
    child.on("exit", code => {
      // An exit we did not ask for: drop the entry so the next start is not refused by
      // a recording that is no longer running.
      if (this.active.get(display) === entry) {
        this.active.delete(display);
        this.log(
          `recording on desktop ${display} ended unexpectedly (code ${code}): ` +
            (entry.stderr.trim().split("\n").pop() ?? "no output")
        );
      }
    });

    this.active.set(display, entry);
    this.log(`recording desktop ${display} to ${file}`);
    return entry.status;
  }

  /**
   * Stops encoders left behind by a previous daemon.
   *
   * ffmpeg is a separate process: when boxd dies, its recorders are adopted by PID 1 and keep
   * writing. The replacement daemon has an empty map, so it believes nothing is recording — and
   * starting a recorder for that desktop gives you two encoders capturing the same screen into two
   * files, one of which nobody will ever stop.
   *
   * They cannot be adopted: a clean stop is `q` on stdin and that pipe died with the old process.
   * SIGTERM is what is left, and ffmpeg does write its trailer on SIGTERM, so the orphan's file is
   * still playable up to that point.
   *
   * Reads /proc directly rather than shelling out to `ps`: this runs at startup, on the path a
   * person is waiting on, and the container has /proc. Anywhere without one — a developer's Mac —
   * it finds nothing and says nothing, which is correct there.
   */
  reclaimOrphans(): number {
    let stopped = 0;
    let pids: string[];
    try {
      pids = readdirSync("/proc").filter(name => /^\d+$/.test(name));
    } catch {
      return 0;
    }

    for (const pid of pids) {
      let argv: string[];
      try {
        argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
      } catch {
        continue; // exited while we were looking, or not ours to read
      }
      const command = argv[0] ?? "";
      if (!command.endsWith("ffmpeg")) continue;
      // Ours only: an argument that is an output file *inside* the recordings directory. Two guards
      // that were missing. A bare `startsWith(RECORDINGS_DIR)` matched `recordings-backup/x` as
      // well as `recordings/x` because it has no boundary — the trailing slash gives it one. And it
      // matched an ffmpeg *reading* a file from the directory, not only one writing to it; requiring
      // the `.mp4` we name our output stops us killing a legitimate reader. An empty RECORDINGS_DIR
      // would have made `startsWith("")` match every ffmpeg on the machine, so that is refused
      // outright.
      const dir = RECORDINGS_DIR.replace(/\/$/, "");
      if (dir === "") continue;
      const prefix = `${dir}/`;
      const isOurs = argv.some(
        argument => argument.startsWith(prefix) && argument.endsWith(".mp4")
      );
      if (!isOurs) continue;

      try {
        process.kill(Number(pid), "SIGTERM");
        stopped += 1;
        this.log(
          `stopped a recording left running by a previous daemon (pid ${pid}); its file is ` +
            `closed where it got to`
        );
      } catch (error) {
        this.log(`could not stop orphaned recorder ${pid}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return stopped;
  }

  async stop(display: number): Promise<RecordingStatus> {
    const entry = this.active.get(display);
    if (!entry) throw new RecordingError(`Desktop ${display} is not being recorded.`);
    this.active.delete(display);

    const exited = new Promise<void>(resolve => {
      if (entry.child.exitCode !== null) return resolve();
      entry.child.once("exit", () => resolve());
    });

    // "q" is ffmpeg's clean stop: it finishes the current fragment and writes the
    // trailer. Signals are the fallback, in order, so a stuck encoder cannot hang this.
    try {
      entry.child.stdin?.write("q");
      entry.child.stdin?.end();
    } catch {
      // Already gone; the waits below settle immediately.
    }

    if (!(await settled(exited, QUIT_GRACE_MS))) {
      this.log(`recording on desktop ${display} ignored "q"; sending SIGTERM`);
      entry.child.kill("SIGTERM");
      if (!(await settled(exited, TERM_GRACE_MS))) {
        this.log(`recording on desktop ${display} ignored SIGTERM; sending SIGKILL`);
        entry.child.kill("SIGKILL");
        await exited;
      }
    }

    const status: RecordingStatus = {
      ...entry.status,
      duration_ms: this.now() - entry.startedAtMs,
    };
    try {
      status.size_bytes = statSync(entry.status.path).size;
    } catch {
      throw new RecordingError(
        `Recording produced no file. ffmpeg said: ${entry.stderr.trim() || "nothing"}`
      );
    }

    this.log(
      `recording of desktop ${display} stopped: ${status.file}, ` +
        `${Math.round((status.size_bytes ?? 0) / 1024)}KB`
    );
    return status;
  }

  /** In-progress recordings first, then finished files newest-first. */
  list(): RecordingStatus[] {
    const running = [...this.active.values()].map(entry => entry.status);
    const runningFiles = new Set(running.map(status => status.file));

    let finished: RecordingStatus[] = [];
    try {
      finished = readdirSync(RECORDINGS_DIR)
        .filter(name => name.endsWith(".mp4") && !runningFiles.has(name))
        .map(name => {
          const path = join(RECORDINGS_DIR, name);
          const info = statSync(path);
          return {
            display: 0,
            file: name,
            path,
            started_at: info.mtime.toISOString(),
            size_bytes: info.size,
          };
        })
        .sort((a, b) => b.started_at.localeCompare(a.started_at));
    } catch {
      // No recordings directory yet.
    }

    return [...running, ...finished];
  }
}

function settled(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    void promise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}
