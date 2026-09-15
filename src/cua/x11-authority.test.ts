import assert from "node:assert/strict";
import childProcess, { type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough, Writable } from "node:stream";
import { after, beforeEach, test } from "node:test";

// Intercept native launches before the executor captures execFile in promisify.
// No test in this process can invoke a real X server or native command.
const originalExecFile = childProcess.execFile;
const originalSpawn = childProcess.spawn;
let allowed = true;
let captures: string[] = [];
let bindings: string[] = [];
let typed = 0;
let revokeOnKeymapRead = false;
let bindingExit = 0;
let revokeOnBinding = false;

childProcess.execFile = ((command: string, args: string[], _options: unknown, callback: (error: Error | null, output: string | Buffer) => void) => {
  if (command === "xmodmap") {
    if (revokeOnKeymapRead) allowed = false;
    queueMicrotask(() => callback(null, "keycode 200 =\n"));
  } else if (command === "xdotool") {
    typed++;
    queueMicrotask(() => callback(null, ""));
  } else {
    captures.push(command);
    if (command === "ffmpeg") {
      const size = args[args.indexOf("-video_size") + 1] ?? "1x1";
      const [width = 1, height = 1] = size.split("x").map(Number);
      queueMicrotask(() => callback(null, Buffer.alloc(width * height * 3)));
    } else {
      queueMicrotask(() => callback(new Error("unexpected native capture"), ""));
    }
  }
  return new EventEmitter() as ChildProcess;
}) as typeof childProcess.execFile;

childProcess.spawn = ((command: string) => {
  assert.equal(command, "xmodmap");
  const child = new EventEmitter();
  let input = "";
  const stdin = new Writable({
    write(chunk, _encoding, done) { input += String(chunk); done(); },
    final(done) {
      bindings.push(input);
      const installing = input.includes("U6C49");
      if (installing && revokeOnBinding) allowed = false;
      done();
      queueMicrotask(() => child.emit("close", installing ? bindingExit : 0));
    },
  });
  return Object.assign(child, { stdin, stderr: new PassThrough(), kill: () => true }) as unknown as ChildProcess;
}) as typeof childProcess.spawn;
syncBuiltinESMExports();

const { X11Executor } = await import("./x11-executor.ts");
const config = {
  display: ":31",
  resolution: { display: { width: 1280, height: 800 }, api: { width: 1280, height: 800 } },
  measureEffect: false,
  screenshotDelayMs: 10,
  effectSettleMs: 10,
};
const authorize = () => { if (!allowed) throw new Error("revoked"); };

beforeEach(() => {
  allowed = true;
  captures = [];
  bindings = [];
  typed = 0;
  revokeOnKeymapRead = false;
  bindingExit = 0;
  revokeOnBinding = false;
});
after(() => {
  childProcess.execFile = originalExecFile;
  childProcess.spawn = originalSpawn;
  syncBuiltinESMExports();
});

test("window capture rechecks authority after its settle wait", async () => {
  class Executor extends X11Executor {
    protected override async executeAction(): Promise<void> {
      setTimeout(() => { allowed = false; }, 0);
    }
  }
  await assert.rejects(new Executor(config).execute([
    { action: "click", coordinate: [10, 10] },
    { action: "screenshot_window", window_id: "0x00000001" },
  ], { authorize }), /revoked/);
  assert.deepEqual(captures, []);
});

test("effect captures do not launch after the input authority is revoked", async () => {
  class Executor extends X11Executor {
    protected override async executeAction(): Promise<void> { allowed = false; }
  }
  await assert.rejects(new Executor({ ...config, measureEffect: true }).execute([
    { action: "click", coordinate: [10, 10] },
  ], { authorize }), /revoked/);
  assert.deepEqual(captures, ["ffmpeg"], "only the authorized before frame was captured");
});

test("revocation during spare-key lookup cannot clear keys it never borrowed", async () => {
  revokeOnKeymapRead = true;
  await assert.rejects(new X11Executor(config).execute([{ action: "type", text: "汉" }], { authorize }), /revoked/);
  assert.deepEqual(bindings, []);
  assert.equal(typed, 0);
});

test("a partially failed native key binding still releases its own keys after revocation", async () => {
  bindingExit = 1;
  revokeOnBinding = true;
  await assert.rejects(new X11Executor(config).execute([{ action: "type", text: "汉" }], { authorize }), /xmodmap exited with code 1/);
  assert.deepEqual(bindings, ["keycode 200 = U6C49 U6C49\n", "keycode 200 =\n"]);
  assert.equal(typed, 0);
});

test("revocation after binding prevents typing but releases the keys already borrowed", async () => {
  revokeOnBinding = true;
  await assert.rejects(new X11Executor(config).execute([{ action: "type", text: "汉" }], { authorize }), /revoked/);
  assert.deepEqual(bindings, ["keycode 200 = U6C49 U6C49\n", "keycode 200 =\n"]);
  assert.equal(typed, 0);
});

test("accessibility capture rechecks authority after the preceding action settles", async () => {
  class Executor extends X11Executor {
    protected override async executeAction(): Promise<void> {
      setTimeout(() => { allowed = false; }, 0);
    }
  }
  await assert.rejects(new Executor(config).execute([
    { action: "click", coordinate: [10, 10] },
    { action: "list_elements" },
  ], { authorize }), /revoked/);
  assert.deepEqual(captures, [], "the revoked call must not launch box-ax or another capture process");
});
