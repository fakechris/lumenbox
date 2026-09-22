import { spawn } from "node:child_process";

/** Native accessibility lives in a disposable process, with bounded output and lifetime.
 * Values go over stdin, never command-line arguments, stderr or error messages.
 */
export function nativeHelper(
  command: string, args: string[], input: unknown,
  options: { env?: Record<string, string>; authorize?: () => void; timeoutMs?: number; maxBytes?: number; allowReadRefusal?: boolean } = {},
): Promise<string> {
  options.authorize?.();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: { ...process.env, ...options.env }, stdio: ["pipe", "pipe", "ignore"] });
    let output = "";
    let bytes = 0;
    let failure: Error | undefined;
    const stop = (error: Error) => { failure ??= error; child.kill("SIGKILL"); };
    const deadline = setTimeout(() => stop(new Error("native helper deadline exceeded; dispatch may be partial")), options.timeoutMs ?? 6000);
    const authority = setInterval(() => {
      try { options.authorize?.(); } catch { stop(new Error("native helper authority revoked; dispatch may be partial")); }
    }, 25);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > (options.maxBytes ?? 4 * 1024 * 1024)) stop(new Error("native helper output limit exceeded"));
      else output += chunk.toString("utf8");
    });
    child.stdin.on("error", () => {}); // EPIPE is reported through the process result.
    child.on("error", () => { failure ??= new Error("native helper could not be launched"); });
    child.on("close", code => {
      clearTimeout(deadline); clearInterval(authority);
      if (failure) reject(failure);
      else if (code !== 0 && !(options.allowReadRefusal && code === 1)) reject(new Error("native helper exited without a receipt; dispatch may be partial"));
      else resolve(output);
    });
    child.stdin.end(JSON.stringify(input));
  });
}
