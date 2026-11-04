/**
 * Everything a job started, for stopping it (INV-1556).
 *
 * Killing a job's process group is not enough: `timeout` and `setsid` put what they run in a group
 * of its own, so a `timeout 2400 python3 scan.py` job killed by group left the scan running, adopted
 * by init (2026-11-04: 1.8 GB and 1.0 GB scans outlived their jobs). The tree is read from /proc
 * *before* anything is signalled — once a parent dies its children are re-parented and the link is
 * gone — and every process in it is killed, with each group whose leader is in it.
 */

import { readdirSync, readFileSync } from "node:fs";

export interface ProcessRow {
  pid: number;
  ppid: number;
  pgid: number;
}

/** The processes under `root` (not `root` itself) and the groups led from inside the tree. */
export function treeOf(root: number, table: readonly ProcessRow[]): { pids: number[]; groups: number[] } {
  const children = new Map<number, number[]>();
  for (const row of table) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row.pid]);
  const pids: number[] = [];
  const queue = [...(children.get(root) ?? [])];
  while (queue.length > 0) {
    const pid = queue.shift()!;
    if (pid === root || pids.includes(pid)) continue;
    pids.push(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  const inTree = new Set([root, ...pids]);
  // A group is killed only when its leader is this job's own process: never a group the job merely joined.
  const groups = [...new Set(table.filter(row => inTree.has(row.pid) && inTree.has(row.pgid)).map(row => row.pgid))];
  return { pids, groups };
}

/** This machine's processes from /proc; empty where there is no /proc (macOS), so callers fall back. */
export function readProcessTable(proc = "/proc"): ProcessRow[] {
  let entries: string[];
  try {
    entries = readdirSync(proc);
  } catch {
    return [];
  }
  const rows: ProcessRow[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      // "pid (comm) state ppid pgrp …" — comm may hold spaces and parentheses, so read after the last ")".
      const stat = readFileSync(`${proc}/${entry}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      rows.push({ pid: Number(entry), ppid: Number(fields[1]), pgid: Number(fields[2]) });
    } catch {
      // Ended while being read.
    }
  }
  return rows;
}

/** SIGKILLs `root`'s group, its whole tree and the groups led inside it. Returns how many processes it reached. */
export function killTree(root: number, table: readonly ProcessRow[] = readProcessTable()): number {
  const { pids, groups } = treeOf(root, table);
  let reached = 0;
  const signal = (target: number) => {
    try {
      process.kill(target, "SIGKILL");
      reached++;
    } catch {
      // Already gone.
    }
  };
  signal(-root);
  for (const group of groups) if (group !== root) signal(-group);
  for (const pid of pids) signal(pid);
  if (reached === 0) signal(root);
  return reached;
}
