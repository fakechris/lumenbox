/**
 * Keeps the memory mirror — and the standing files (INV-777) — in the box current.
 *
 * Best-effort by design: the host's record is the truth and the prompt reads it directly, so a
 * mirror that could not be written costs a stale file, never a turn. Writes go through the box's
 * own file service, which confines them to the work directory and creates the directories.
 */

import { createHash } from "node:crypto";
import type { AgentRegistry } from "../agents/registry.ts";
import { legacyMemoryMirrorDir, renderMemoryFiles } from "./memory.ts";
import { standingBoxFiles } from "./standing.ts";

export interface MemoryMirrorBox {
  writeFile(path: string, content: string): Promise<unknown>;
  readFile(path: string, range?: { startLine?: number; endLine?: number }): Promise<{ content: string }>;
  /** Used once per box to remove the slug-keyed directories (INV-867); a box without it keeps them. */
  exec?(command: string, options?: { actor?: string; timeoutMs?: number }): Promise<unknown>;
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
  /**
   * Slug-keyed directories already removed from each box (the orchestrator hands out one client
   * per box), so each goes once per box however many agents' names map to it.
   */
  private readonly cleaned = new WeakMap<MemoryMirrorBox, Set<string>>();

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
    const memory = renderMemoryFiles(agentId, agent.profile.name, this.deps.registry.readMemoryRecords(agentId));
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
    const agents = this.deps.registry.list();
    // An agent removed while this runs (it is fired without being awaited) is skipped, not an
    // unhandled rejection: the mirror is best-effort, and a deleted agent has nothing to mirror.
    for (const agent of agents) {
      try {
        await this.removeLegacy(agent.id, agents);
        await this.sync(agent.id);
      } catch (error) {
        this.deps.log?.(`${agent.profile.name}: mirror skipped (${error instanceof Error ? error.message : String(error)})`);
      }
    }
  }

  /**
   * Removes the slug-keyed mirror directory an agent's name maps to (INV-867). Those directories are
   * where two agents' memories were mixed; they are derived from the host record, which the id-keyed
   * mirror rewrites in full, so nothing is lost. Only the exact directory is removed — its name is
   * `[a-z0-9-]` by construction — and never one that is some agent's id.
   */
  private async removeLegacy(agentId: string, agents: readonly { id: string; profile: { name: string } }[]): Promise<void> {
    const box = this.deps.box(agentId);
    const agent = agents.find(entry => entry.id === agentId);
    if (box?.exec === undefined || agent === undefined) return;
    const dir = legacyMemoryMirrorDir(agent.profile.name);
    if (agents.some(entry => dir.endsWith(`/${entry.id}`))) return;
    const done = this.cleaned.get(box) ?? new Set<string>();
    if (done.has(dir)) return;
    done.add(dir);
    this.cleaned.set(box, done);
    // Only where the old mirror is actually there: it always wrote profile.md. A fresh box, or one
    // already rid of it, gets no command at all.
    if ((await this.boxCopy(box, `${dir}/profile.md`)) === undefined) return;
    try {
      await box.exec(`rm -rf -- '${dir}'`, { actor: "host:memory-mirror", timeoutMs: 30_000 });
    } catch (error) {
      this.deps.log?.(`could not remove the old shared mirror ${dir} (${error instanceof Error ? error.message : String(error)})`);
    }
  }
}
