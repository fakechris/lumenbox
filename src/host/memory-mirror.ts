/**
 * Keeps the memory mirror — and the standing files (INV-777) — in the box current.
 *
 * Best-effort by design: the host's record is the truth and the prompt reads it directly, so a
 * mirror that could not be written costs a stale file, never a turn. Writes go through the box's
 * own file service, which confines them to the work directory and creates the directories.
 */

import { createHash } from "node:crypto";
import type { AgentRegistry } from "../agents/registry.ts";
import { renderMemoryFiles } from "./memory.ts";
import { standingBoxFiles } from "./standing.ts";

export interface MemoryMirrorBox {
  writeFile(path: string, content: string): Promise<unknown>;
  readFile(path: string, range?: { startLine?: number; endLine?: number }): Promise<{ content: string }>;
}

/** Past every line a standing file can hold (8 KiB), so the read back is the whole file. */
const WHOLE_FILE = { startLine: 1, endLine: 1_000_000 };

function hashOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export interface MemoryMirrorDeps {
  registry: Pick<AgentRegistry, "readMemoryRecords" | "get" | "list" | "dirFor">;
  /** The agent's box now, or none: the mirror is written when there is somewhere to write it. */
  box: (agentId: string) => MemoryMirrorBox | undefined;
  log?: (line: string) => void;
}

export class MemoryMirror {
  /** What each path last held, so an unchanged file is not rewritten on every remembered fact. */
  private readonly written = new Map<string, string>();

  constructor(private readonly deps: MemoryMirrorDeps) {}

  /** Writes what changed for one agent. Resolves either way; failures are a log line. */
  async sync(agentId: string): Promise<{ written: number }> {
    const box = this.deps.box(agentId);
    const agent = this.deps.registry.get(agentId);
    if (box === undefined || agent === undefined) return { written: 0 };
    // The memory mirror is read-only in the box, so "what we last wrote" is what the box holds and
    // an unchanged file is skipped. The standing files (INV-777) ride the same sync but are
    // read-write there: a `bash` edit or delete moves the box copy without moving the host's, so
    // the last-write hash says nothing about them (INV-803). Each is read back every sync and
    // rewritten from the host copy — the canonical one — when it differs or is gone, with one line
    // of log; the box copy is never adopted.
    const memory = renderMemoryFiles(agent.profile.name, this.deps.registry.readMemoryRecords(agentId));
    const standing = standingBoxFiles(this.deps.registry.dirFor(agentId), agentId, agent.profile.name);
    let written = 0;
    for (const file of [...memory, ...standing]) {
      const digest = hashOf(file.content);
      const last = this.written.get(file.path);
      try {
        if (standing.includes(file)) {
          const boxCopy = await this.boxCopy(box, file.path);
          if (boxCopy === file.content) {
            this.written.set(file.path, digest);
            continue;
          }
          // The box copy is not what this sync last wrote: a shell edited or deleted it. Said once,
          // here; the host copy is still the one in the prompt and it goes back down.
          const shellMoved = last !== undefined && (boxCopy === undefined || hashOf(boxCopy) !== last);
          await box.writeFile(file.path, file.content);
          this.written.set(file.path, digest);
          written += 1;
          if (shellMoved) {
            this.deps.log?.(
              `${agent.profile.name}: ${file.path} was ${boxCopy === undefined ? "deleted" : "changed"} in the box ` +
                "outside the tools; restored the host copy, which is the one that counts"
            );
          }
          continue;
        }
        if (last === digest) continue;
        await box.writeFile(file.path, file.content);
        this.written.set(file.path, digest);
        written += 1;
      } catch (error) {
        this.deps.log?.(
          `${agent.profile.name}: could not write ${file.path} ` +
            `(${error instanceof Error ? error.message : String(error)}); the host record is unaffected`
        );
      }
    }
    return { written };
  }

  /** The box's text for a path, or undefined when it cannot be read — missing, or a box that cannot say. */
  private async boxCopy(box: MemoryMirrorBox, path: string): Promise<string | undefined> {
    try {
      return (await box.readFile(path, WHOLE_FILE)).content;
    } catch {
      return undefined;
    }
  }

  /** Every agent, for when the box (re)appears. A fresh box has none of the files. */
  async syncAll(): Promise<void> {
    this.written.clear();
    for (const agent of this.deps.registry.list()) await this.sync(agent.id);
  }
}
