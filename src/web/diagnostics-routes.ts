/**
 * What this process and its box are holding, for a person deciding why the machine is slow (INV-1559).
 *
 * The desktop app's main process runs the web server and every agent's turns; until now it said
 * nothing about itself. On 2026-11-04 its footprint followed the box's activity from 1.5 GB to 3.1 GB
 * and there was no way to say what held it. Two answers, admin only:
 *
 * - GET  /api/diagnostics/resources — the process's memory and event-loop delay, each agent's turns,
 *   queue and watched jobs, the page's open event streams, and the box's cgroup memory and CPU.
 * - POST /api/diagnostics/heap-snapshot — a V8 heap snapshot written under the home directory, for
 *   Chrome DevTools → Memory → Load. It holds whatever the process holds, conversations included,
 *   so it is written only when asked and the answer says where it is and how to remove it.
 */

import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { getHeapSpaceStatistics, writeHeapSnapshot } from "node:v8";

export interface DiagnosticsDeps {
  refusedAdmin: () => boolean;
  agents: () => { id: string; name: string }[];
  activeTurns: (agentId: string) => number;
  queued: (agentId: string) => number;
  watchedJobs: (agentId: string) => number;
  eventSubscribers: () => number;
  box: () => { exec(command: string, options: { timeoutMs?: number; actor?: string }): Promise<{ stdout: string; exit_code: number }> } | undefined;
  /** Where snapshots go: `<home>/diagnostics`. */
  home: string;
  now?: () => Date;
}

export interface BoxResources {
  memoryCurrent?: number;
  memoryMax?: number | "max";
  memoryEvents?: Record<string, number>;
  cpu?: Record<string, number>;
  error?: string;
}

let delay: ReturnType<typeof monitorEventLoopDelay> | undefined;

/** Event-loop delay since the previous read, in milliseconds; the monitor starts on first use. */
export function eventLoopDelay(): { meanMs: number; p50Ms: number; p99Ms: number; maxMs: number; sinceStart: boolean } {
  const sinceStart = delay === undefined;
  if (delay === undefined) {
    delay = monitorEventLoopDelay({ resolution: 20 });
    delay.enable();
  }
  const ms = (ns: number) => Math.round((Number.isFinite(ns) ? ns : 0) / 1e5) / 10;
  const read = { meanMs: ms(delay.mean), p50Ms: ms(delay.percentile(50)), p99Ms: ms(delay.percentile(99)), maxMs: ms(delay.max), sinceStart };
  delay.reset();
  return read;
}

/** `key value` lines (memory.events, cpu.stat) as numbers. */
function keyed(text: string): Record<string, number> {
  return Object.fromEntries(text.split("\n").map(line => line.trim().split(/\s+/)).filter(parts => parts.length === 2 && /^\d+$/.test(parts[1]!)).map(([key, value]) => [key!, Number(value)]));
}

const SECTION = "---lumenbox-section---";

/** The box's own cgroup, read from inside it; a box that is down answers with why. */
export async function boxResources(box: DiagnosticsDeps["box"]): Promise<BoxResources> {
  const client = box();
  if (client === undefined) return { error: "no box connected" };
  try {
    const files = ["memory.current", "memory.max", "memory.events", "cpu.stat"];
    const result = await client.exec(files.map(file => `cat /sys/fs/cgroup/${file} 2>/dev/null; echo ${SECTION}`).join("; "), { timeoutMs: 5_000, actor: "host:diagnostics" });
    const [current, max, events, cpu] = result.stdout.split(SECTION).map(part => part.trim());
    return {
      ...(current && /^\d+$/.test(current) ? { memoryCurrent: Number(current) } : {}),
      ...(max === "max" ? { memoryMax: "max" as const } : max && /^\d+$/.test(max) ? { memoryMax: Number(max) } : {}),
      memoryEvents: keyed(events ?? ""),
      cpu: keyed(cpu ?? ""),
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export async function resources(deps: DiagnosticsDeps): Promise<Record<string, unknown>> {
  const memory = process.memoryUsage();
  return {
    at: (deps.now?.() ?? new Date()).toISOString(),
    process: { pid: process.pid, uptimeSeconds: Math.round(process.uptime()), rss: memory.rss, heapUsed: memory.heapUsed, heapTotal: memory.heapTotal, external: memory.external, arrayBuffers: memory.arrayBuffers },
    heapSpaces: getHeapSpaceStatistics().map(space => ({ name: space.space_name, used: space.space_used_size, size: space.space_size })),
    eventLoop: eventLoopDelay(),
    eventSubscribers: deps.eventSubscribers(),
    agents: deps.agents().map(agent => ({ id: agent.id, name: agent.name, activeTurns: deps.activeTurns(agent.id), queued: deps.queued(agent.id), watchedJobs: deps.watchedJobs(agent.id) })),
    box: await boxResources(deps.box),
  };
}

/** Writes a heap snapshot under `<home>/diagnostics` and says where, how big, and how to remove it. */
export function heapSnapshot(home: string, now: Date = new Date(), write: (path: string) => string = writeHeapSnapshot): { path: string; bytes: number; note: string } {
  const dir = join(home, "diagnostics");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = write(join(dir, `${now.toISOString().replace(/[:.]/g, "-")}.heapsnapshot`));
  return {
    path,
    bytes: statSync(path).size,
    note: "Open it in Chrome DevTools → Memory → Load. It holds everything this process holds, conversations included: keep it on this machine, and delete the file when you are done.",
  };
}

export async function diagnosticsRoute(route: string, deps: DiagnosticsDeps): Promise<{ status: number; body: unknown } | undefined> {
  if (route !== "GET /api/diagnostics/resources" && route !== "POST /api/diagnostics/heap-snapshot") return undefined;
  if (deps.refusedAdmin()) return { status: 0, body: null };
  if (route === "GET /api/diagnostics/resources") return { status: 200, body: await resources(deps) };
  return { status: 200, body: heapSnapshot(deps.home, deps.now?.()) };
}
