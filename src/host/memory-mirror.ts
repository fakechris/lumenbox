/**
 * Keeps the memory mirror in the box current.
 *
 * Best-effort by design: the host's record is the truth and the prompt reads it directly, so a
 * mirror that could not be written costs a stale file, never a turn. Writes go through the box's
 * own file service, which confines them to the work directory and creates the directories.
 */

import { createHash } from "node:crypto";
import type { AgentRegistry } from "../agents/registry.ts";
import { renderMemoryFiles } from "./memory.ts";

export interface MemoryMirrorBox {
  writeFile(path: string, content: string): Promise<unknown>;
}

export interface MemoryMirrorDeps {
  registry: Pick<AgentRegistry, "readMemoryRecords" | "get" | "list">;
  /** The box now, or none: the mirror is written when there is somewhere to write it. */
  box: () => MemoryMirrorBox | undefined;
  log?: (line: string) => void;
}

export class MemoryMirror {
  /** What each path last held, so an unchanged file is not rewritten on every remembered fact. */
  private readonly written = new Map<string, string>();

  constructor(private readonly deps: MemoryMirrorDeps) {}

  /** Writes what changed for one agent. Resolves either way; failures are a log line. */
  async sync(agentId: string): Promise<{ written: number }> {
    const box = this.deps.box();
    const agent = this.deps.registry.get(agentId);
    if (box === undefined || agent === undefined) return { written: 0 };
    const files = renderMemoryFiles(agent.profile.name, this.deps.registry.readMemoryRecords(agentId));
    let written = 0;
    for (const file of files) {
      const digest = createHash("sha256").update(file.content).digest("hex");
      if (this.written.get(file.path) === digest) continue;
      try {
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

  /** Every agent, for when the box (re)appears. A fresh box has none of the files. */
  async syncAll(): Promise<void> {
    this.written.clear();
    for (const agent of this.deps.registry.list()) await this.sync(agent.id);
  }
}
