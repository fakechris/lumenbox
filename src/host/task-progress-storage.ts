/** A durable state checkpoint of the existing task file, with the counter preserved. */
import { closeSync, fsyncSync, openSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Task } from "./tasks.ts";
export function checkpointTasks(path: string, counter: number, tasks: Iterable<Task>): void {
  const temporary = `${path}.${process.pid}.tmp`;
  const text = [JSON.stringify({ kind: "counter", value: counter }), ...Array.from(tasks, task => JSON.stringify({ kind: "task", task }))].join("\n") + "\n";
  const fd = openSync(temporary, "w", 0o600);
  try { writeFileSync(fd, text, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}
