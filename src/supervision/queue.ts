/**
 * Supervisor runs as files (INV-1527): the web writes a request into queue/, the supervision
 * process takes it, runs it under runs/<id>/ (status.json, transcript.jsonl, summary.md), and a
 * stop is a file named `stop` in that directory. Files, because the two processes share a home
 * and nothing else, and because a run's record should be readable without either of them.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface RunRequest {
  id: string;
  objective: string;
  agent?: string;
  budget?: number;
  requestedAt: string;
}

export type RunState = "queued" | "running" | "done" | "failed" | "stopped";

export interface RunStatus {
  id: string;
  state: RunState;
  objective: string;
  goalId?: string;
  outcome?: string;
  modelCalls?: number;
  tokens?: { input: number; output: number };
  model?: string;
  requestedAt: string;
  startedAt?: string;
  endedAt?: string;
  error?: string;
}

export const supervisorDir = (home: string) => join(home, "supervisor");
const queueDir = (home: string) => join(supervisorDir(home), "queue");
export const runDir = (home: string, id: string) => join(supervisorDir(home), "runs", id);

export function enqueue(home: string, request: Omit<RunRequest, "requestedAt">, now: Date = new Date()): RunRequest {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(request.id)) throw new Error("a run id is letters, digits, - and _");
  const full: RunRequest = { ...request, requestedAt: now.toISOString() };
  mkdirSync(queueDir(home), { recursive: true });
  writeFileSync(join(queueDir(home), `${request.id}.json.partial`), JSON.stringify(full));
  renameSync(join(queueDir(home), `${request.id}.json.partial`), join(queueDir(home), `${request.id}.json`));
  writeStatus(home, { id: full.id, state: "queued", objective: full.objective, requestedAt: full.requestedAt });
  return full;
}

/** The oldest waiting request, moved out of the queue so it is taken once. */
export function takeNext(home: string): RunRequest | undefined {
  if (!existsSync(queueDir(home))) return undefined;
  const files = readdirSync(queueDir(home)).filter(name => name.endsWith(".json")).sort();
  for (const name of files) {
    const path = join(queueDir(home), name);
    try {
      const request = JSON.parse(readFileSync(path, "utf8")) as RunRequest;
      mkdirSync(runDir(home, request.id), { recursive: true });
      renameSync(path, join(runDir(home, request.id), "request.json"));
      return request;
    } catch {
      renameSync(path, `${path}.unreadable`);
    }
  }
  return undefined;
}

export function writeStatus(home: string, status: RunStatus): void {
  mkdirSync(runDir(home, status.id), { recursive: true });
  const path = join(runDir(home, status.id), "status.json");
  writeFileSync(`${path}.partial`, JSON.stringify(status, null, 2));
  renameSync(`${path}.partial`, path);
}

export function readStatus(home: string, id: string): RunStatus | undefined {
  const path = join(runDir(home, id), "status.json");
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as RunStatus) : undefined;
}

export function listRuns(home: string): RunStatus[] {
  const dir = join(supervisorDir(home), "runs");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap(id => readStatus(home, id) ?? []).sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
}

export function requestStop(home: string, id: string): boolean {
  if (!existsSync(runDir(home, id))) return false;
  writeFileSync(join(runDir(home, id), "stop"), new Date().toISOString());
  return true;
}

export const stopRequested = (home: string, id: string) => existsSync(join(runDir(home, id), "stop"));
