/** Linux process mechanics. DisplayManager remains the lifecycle authority. */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { Desktop } from "./displays.ts";

export interface DesktopProcessSnapshot {
  processes: { pid: number; start: string; name: string; owned?: boolean }[];
  reason?: string;
  launch_id?: string;
  retryable?: boolean;
}
export interface DesktopResourceRuntime {
  now: () => number;
  idleMs: number;
  adopted: (index: number) => boolean;
  create?: (index: number) => Promise<Desktop>;
  capture: (index: number, launchId?: string) => Promise<DesktopProcessSnapshot>;
  stop: (index: number, snapshot: DesktopProcessSnapshot, authorize: () => boolean) => Promise<{ stopped: boolean; reason?: string; failed?: boolean; retryable?: boolean }>;
}

function processCommand<T>(index: number, snapshot?: DesktopProcessSnapshot, authorize?: () => boolean, launchId?: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.BOXD_DESKTOP_PROCESSES ?? "/usr/local/bin/desktop-processes", [String(index)], { stdio: ["pipe", "pipe", "pipe"] });
    let output = "", result: T | undefined, failure: Error | undefined;
    const timeout = setTimeout(() => { failure = new Error("desktop process check timed out"); child.stdin.end(); child.kill("SIGTERM"); }, 15_000);
    child.stderr.resume();
    child.on("error", error => { clearTimeout(timeout); reject(error); });
    child.stdout.on("data", chunk => {
      output += String(chunk);
      if (output.length > 128 * 1024) { failure = new Error("desktop inventory exceeded limit"); child.stdin.end(); return; }
      while (output.includes("\n")) {
        const newline = output.indexOf("\n");
        const line = output.slice(0, newline); output = output.slice(newline + 1);
        try {
          const value = JSON.parse(line);
          if (value.ready === true) child.stdin.end(JSON.stringify({ commit: authorize?.() === true }) + "\n");
          else result = value as T;
        } catch { failure = new Error("invalid desktop process response"); child.stdin.end(); }
      }
    });
    child.on("close", code => {
      clearTimeout(timeout);
      if (failure || code !== 0 || result === undefined) reject(failure ?? new Error("desktop process inspection unavailable"));
      else resolve(result);
    });
    child.stdin.on("error", () => {});
    child.stdin.write(JSON.stringify(snapshot ? { mode: "stop", snapshot } : { mode: "capture", launch_id: launchId }) + "\n");
  });
}

export function desktopResourceRuntime(): DesktopResourceRuntime {
  const configured = Number(process.env.BOXD_DESKTOP_IDLE_MS ?? 15 * 60_000);
  return {
    now: Date.now,
    // Zero explicitly disables reclamation. Invalid configuration retains desktops.
    idleMs: Number.isFinite(configured) && configured >= 1000 ? configured : 0,
    adopted: index => existsSync(`/tmp/.X11-unix/X${index}`),
    capture: (index, launchId) => processCommand<DesktopProcessSnapshot>(index, undefined, undefined, launchId),
    stop: (index, snapshot, authorize) => processCommand(index, snapshot, authorize),
  };
}
