/**
 * Session capsules for delegated engines: when to resume an engine's own thread, and when not.
 *
 * Claude Code keeps a conversation per session id and can pick it up with `--resume`. That is
 * worth having — the second brief on the same repository should not start from nothing — and
 * dangerous when anything that defined the thread has changed: a different model reads the
 * old thread as its own, a different working directory makes every remembered path wrong.
 * Argus keeps a capsule per role and rotates it with a named reason whenever role, objective,
 * workdir, branch, backend or model differ, and again at a turn or token ceiling. This is
 * that rule for one engine at a time: the capsule is keyed on everything that defines the
 * thread, so a change is a new capsule, and the old one's reason for ending is on record.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { agentboxHome } from "../config.ts";

export interface Capsule {
  id: string;
  agentId: string;
  conversation: string;
  preset: string;
  cwd: string;
  model: string;
  runs: number;
  createdAt: string;
  lastAt: string;
}

/** Runs before a thread is rotated regardless: a long thread is a full context, not a memory. */
export const CAPSULE_RUN_CEILING = 6;
/** Age before a thread is rotated regardless. */
export const CAPSULE_AGE_MS = 12 * 60 * 60_000;

export function delegateSessionsPath(): string {
  return process.env.AGENTBOX_DELEGATE_SESSIONS ?? join(agentboxHome(), "delegate-sessions.json");
}

export class DelegateSessions {
  private capsules: Record<string, Capsule> = {};

  constructor(private readonly path: string | null = delegateSessionsPath()) {
    if (path !== null && existsSync(path)) {
      try {
        this.capsules = JSON.parse(readFileSync(path, "utf8")) as Record<string, Capsule>;
      } catch {
        // A torn file is an empty one: a fresh session costs a re-read, a wrong resume costs more.
        this.capsules = {};
      }
    }
  }

  /**
   * The capsule to run this delegation under: resumed when the same agent, conversation,
   * engine, directory and model ran before and the thread is neither long nor old; fresh
   * otherwise, with the reason the previous one was not reused.
   */
  open(
    input: { agentId: string; conversation: string; preset: string; cwd: string; model: string },
    now = new Date()
  ): { id: string; resumed: boolean; rotated?: string } {
    const key = `${input.agentId}|${input.conversation}|${input.preset}`;
    const previous = this.capsules[key];
    let rotated: string | undefined;
    if (previous !== undefined) {
      if (previous.cwd !== input.cwd) rotated = `working directory changed (${previous.cwd} → ${input.cwd})`;
      else if (previous.model !== input.model) rotated = `model changed (${previous.model} → ${input.model})`;
      else if (previous.runs >= CAPSULE_RUN_CEILING) rotated = `${previous.runs} runs on one thread is the ceiling`;
      else if (now.getTime() - Date.parse(previous.createdAt) > CAPSULE_AGE_MS) rotated = "the thread is older than twelve hours";
      else {
        previous.runs += 1;
        previous.lastAt = now.toISOString();
        this.save();
        return { id: previous.id, resumed: true };
      }
    }
    const capsule: Capsule = {
      id: randomUUID(),
      agentId: input.agentId,
      conversation: input.conversation,
      preset: input.preset,
      cwd: input.cwd,
      model: input.model,
      runs: 1,
      createdAt: now.toISOString(),
      lastAt: now.toISOString(),
    };
    this.capsules[key] = capsule;
    this.save();
    return { id: capsule.id, resumed: false, ...(rotated !== undefined ? { rotated } : {}) };
  }

  /** Forget a thread: the engine said it could not resume it, so the next run starts fresh. */
  drop(id: string): void {
    for (const [key, capsule] of Object.entries(this.capsules)) {
      if (capsule.id === id) delete this.capsules[key];
    }
    this.save();
  }

  private save(): void {
    if (this.path === null) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(this.capsules, null, 2)}\n`, "utf8");
    renameSync(temp, this.path);
  }
}
