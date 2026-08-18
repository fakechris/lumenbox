/**
 * File-based agent registry.
 *
 * Every agent is a sibling directory under the agents root:
 *
 *   <root>/<agentId>/profile.json      identity and persona
 *   <root>/<agentId>/conversation.jsonl transcript
 *   <root>/<agentId>/memory.md         long-term notes the agent maintains
 *
 * Keeping this on disk rather than in a database is a real feature, not laziness:
 * the agent can read and edit its teammates' profiles with the same shell tools it
 * uses for everything else, and so can a human with an editor.
 */

import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
  existsSync,
  appendFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const AGENT_NAME_MAX_LENGTH = 72;
export const AGENT_DESCRIPTION_MAX_LENGTH = 2000;
export const PROFILE_FILENAME = "profile.json";
export const TRANSCRIPT_FILENAME = "conversation.jsonl";
export const MEMORY_FILENAME = "memory.md";

export interface AgentProfile {
  name: string;
  description: string;
  /** Short subtitle shown next to the name, e.g. "release manager". */
  title?: string;
  avatarColor?: string;
  /** Removes the agent from listings without disabling it. */
  hidden?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRecord {
  id: string;
  profile: AgentProfile;
  dir: string;
}

/** Collapses whitespace and clamps, for values that must stay on one line. */
export function clampLine(raw: string, max: number): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, max);
}

export function clampBlock(raw: string, max: number): string {
  return raw.trim().slice(0, max);
}

export function defaultAgentsRoot(): string {
  return (
    process.env.AGENTBOX_AGENTS_DIR ??
    join(process.env.AGENTBOX_HOME ?? join(homedir(), ".agentbox"), "agents")
  );
}

export class AgentNotFoundError extends Error {
  constructor(readonly agentId: string) {
    super(`No agent found with id ${agentId}.`);
    this.name = "AgentNotFoundError";
  }
}

export class AgentRegistry {
  constructor(readonly root: string = defaultAgentsRoot()) {
    mkdirSync(this.root, { recursive: true });
  }

  dirFor(agentId: string): string {
    return join(this.root, agentId);
  }

  profilePathFor(agentId: string): string {
    return join(this.dirFor(agentId), PROFILE_FILENAME);
  }

  transcriptPathFor(agentId: string): string {
    return join(this.dirFor(agentId), TRANSCRIPT_FILENAME);
  }

  memoryPathFor(agentId: string): string {
    return join(this.dirFor(agentId), MEMORY_FILENAME);
  }

  /**
   * Writes a profile atomically.
   *
   * Temp file plus rename, because a reader that catches a half-written
   * profile.json would see invalid JSON — and the agent directory is read on
   * every prompt assembly, so that window gets hit.
   */
  private writeProfile(agentId: string, profile: AgentProfile): void {
    const dir = this.dirFor(agentId);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, PROFILE_FILENAME);
    const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temp, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
    renameSync(temp, path);
  }

  has(agentId: string): boolean {
    return existsSync(this.profilePathFor(agentId));
  }

  get(agentId: string): AgentRecord {
    const record = this.tryGet(agentId);
    if (!record) throw new AgentNotFoundError(agentId);
    return record;
  }

  tryGet(agentId: string): AgentRecord | undefined {
    const path = this.profilePathFor(agentId);
    if (!existsSync(path)) return undefined;
    try {
      const profile = JSON.parse(readFileSync(path, "utf8")) as AgentProfile;
      return { id: agentId, profile, dir: this.dirFor(agentId) };
    } catch {
      // A corrupt profile should not take down the whole roster.
      return undefined;
    }
  }

  /** All agents, including hidden ones, sorted by name. */
  list(): AgentRecord[] {
    let ids: string[];
    try {
      ids = readdirSync(this.root, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name);
    } catch {
      return [];
    }

    return ids
      .map(id => this.tryGet(id))
      .filter((record): record is AgentRecord => record !== undefined)
      .sort((a, b) => a.profile.name.localeCompare(b.profile.name));
  }

  /** Resolves an id, or a unique case-insensitive name match. */
  resolve(idOrName: string): AgentRecord {
    const direct = this.tryGet(idOrName);
    if (direct) return direct;

    const needle = idOrName.trim().toLowerCase();
    const matches = this.list().filter(
      record => record.profile.name.toLowerCase() === needle
    );
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) {
      throw new Error(
        `"${idOrName}" matches ${matches.length} agents. Use an id: ` +
          matches.map(m => m.id).join(", ")
      );
    }
    throw new AgentNotFoundError(idOrName);
  }

  create(input: {
    name: string;
    description?: string;
    title?: string;
    avatarColor?: string;
    hidden?: boolean;
  }): AgentRecord {
    const name = clampLine(input.name ?? "", AGENT_NAME_MAX_LENGTH);
    if (!name) throw new Error("An agent needs a non-empty name.");

    const now = new Date().toISOString();
    const id = randomUUID();
    const profile: AgentProfile = {
      name,
      description: clampBlock(input.description ?? "", AGENT_DESCRIPTION_MAX_LENGTH),
      title: input.title ? clampLine(input.title, 64) : undefined,
      avatarColor: input.avatarColor,
      hidden: input.hidden ?? false,
      createdAt: now,
      updatedAt: now,
    };

    this.writeProfile(id, profile);
    return { id, profile, dir: this.dirFor(id) };
  }

  /**
   * Merges changes into an existing profile.
   *
   * Only provided fields change; there is deliberately no way to blank a name or
   * delete an agent through this path, so a confused agent cannot destroy a
   * teammate. Deletion is a human action.
   */
  update(
    agentId: string,
    changes: {
      name?: string;
      description?: string;
      title?: string;
      avatarColor?: string;
      hidden?: boolean;
    }
  ): AgentRecord {
    const existing = this.get(agentId);
    const profile: AgentProfile = { ...existing.profile };

    if (changes.name !== undefined) {
      const name = clampLine(changes.name, AGENT_NAME_MAX_LENGTH);
      if (name) profile.name = name;
    }
    if (changes.description !== undefined) {
      profile.description = clampBlock(
        changes.description,
        AGENT_DESCRIPTION_MAX_LENGTH
      );
    }
    if (changes.title !== undefined) profile.title = clampLine(changes.title, 64);
    if (changes.avatarColor !== undefined) profile.avatarColor = changes.avatarColor;
    if (changes.hidden !== undefined) profile.hidden = changes.hidden;

    profile.updatedAt = new Date().toISOString();
    this.writeProfile(agentId, profile);
    return { id: agentId, profile, dir: this.dirFor(agentId) };
  }

  readMemory(agentId: string): string {
    const path = this.memoryPathFor(agentId);
    if (!existsSync(path)) return "";
    try {
      return readFileSync(path, "utf8");
    } catch {
      return "";
    }
  }

  writeMemory(agentId: string, content: string): void {
    mkdirSync(this.dirFor(agentId), { recursive: true });
    const path = this.memoryPathFor(agentId);
    const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temp, content, "utf8");
    renameSync(temp, path);
  }

  appendTranscript(agentId: string, entry: unknown): void {
    mkdirSync(this.dirFor(agentId), { recursive: true });
    appendFileSync(
      this.transcriptPathFor(agentId),
      `${JSON.stringify(entry)}\n`,
      "utf8"
    );
  }

  readTranscript(agentId: string): unknown[] {
    const path = this.transcriptPathFor(agentId);
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(line => line.trim() !== "")
      .flatMap(line => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
  }
}
