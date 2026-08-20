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

import { randomBytes, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
  existsSync,
  appendFileSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isTodoStatus, type DurableState, type TodoItem } from "../host/durable.ts";
import { importMarkdown, type MemoryRecord } from "../host/memory.ts";

export const AGENT_NAME_MAX_LENGTH = 72;
export const AGENT_DESCRIPTION_MAX_LENGTH = 2000;
export const PROFILE_FILENAME = "profile.json";
export const TRANSCRIPT_FILENAME = "conversation.jsonl";
export const MEMORY_FILENAME = "memory.md";

/**
 * Where the agent's plan and todo list live.
 *
 * Beside the memory and the transcript, because they are the same kind of thing: state the agent
 * maintains that has to outlive a conversation. Separate files rather than one, so a malformed todo
 * list cannot take the plan with it.
 */
/**
 * Structured memory, one record per line.
 *
 * Alongside `memory.md` rather than replacing it: an existing agent's markdown is imported once, and
 * the original file is left on disk. Deleting someone's memory to upgrade the format would be the
 * worst possible way to introduce a feature about not losing things.
 */
export const MEMORY_RECORDS_FILENAME = "memory.jsonl";

/**
 * The team's memory, sharded by whichever agent wrote it.
 *
 * `<root>/shared-memory/<agentId>.jsonl`. Sharded rather than one file for a concrete reason: agents
 * run concurrently, and two appends to one file are not reliably atomic once a line exceeds the
 * pipe-buffer size. One writer per file removes the question entirely, and merging on read is cheap.
 *
 * Beside the per-agent directories rather than inside one, because removing an agent must not remove
 * what it taught the team — that is the whole point of a shared tier. Under the same root so a custom
 * root (a test, a second installation) keeps everything together, which means `list()` has to exclude
 * it explicitly.
 */
export const SHARED_MEMORY_DIRNAME = "shared-memory";

export const PLAN_FILENAME = "plan.md";
export const TODOS_FILENAME = "todos.json";
export const BOX_OWNER_FILENAME = "box-owner";

export interface AgentProfile {
  name: string;
  description: string;
  /** Short subtitle shown next to the name, e.g. "release manager". */
  title?: string;
  avatarColor?: string;
  /** Removes the agent from listings without disabling it. */
  hidden?: boolean;
  /**
   * The agent's own desktop in the box.
   *
   * One display per agent, never shared: X sends synthetic input to whichever
   * window has focus, so agents on one display type into each other's windows and
   * screenshot each other's work. Assigned at creation and stable thereafter, so
   * an agent returns to the desktop it left.
   */
  displayIndex?: number;
  /**
   * The person who created it, when the box was told who that was.
   *
   * Undefined for an agent made before this existed, or by an automation, or on a box driven
   * directly with no gateway in front. Absent means shared, which is the right default: the reason a
   * tenant is a team is that agents work together, and defaulting to private would mean every
   * collaboration starts with a permissions change.
   */
  ownerUserId?: string;
  /**
   * Who may drive it.
   *
   * **Not a security boundary**, and the code says so where the check is made. Everyone in a tenant
   * shares a filesystem and passwordless sudo, so a determined member can read another member's
   * transcript from a shell. This prevents accidents and answers "whose agent is this" — see
   * docs/09-tenancy.md §3.2.
   */
  visibility?: "shared" | "private";
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

/**
 * Clamps, and says so when it had to.
 *
 * For anything a person or an agent *wrote*, as opposed to a field with a length rule. A message
 * used to be cut at 8,000 characters in silence: a pasted specification whose acceptance criteria
 * were at the end arrived without them, the sender was told "Sent", and the model had no way to
 * know it was reading part of a request. Losing the text is survivable; not knowing it was lost is
 * not, because the model then answers the truncated question confidently.
 */
export function clampMessage(raw: string, max: number): string {
  const text = raw.trim();
  if (text.length <= max) return text;
  const dropped = text.length - max;
  return (
    `${text.slice(0, max)}\n\n[This message was cut here: ${dropped} more characters were not ` +
    `delivered. You are reading part of it. Say so, and ask for the rest — in a file if it is long, ` +
    `since a file has no length limit.]`
  );
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
        .map(entry => entry.name)
        // Not everything under the root is an agent. The shared-memory directory lives here so a
        // custom root keeps all of an installation's state together, and it is excluded by name
        // rather than left to `tryGet` returning undefined — that worked, but only by accident, and
        // an accident is not a rule the next directory added here would follow.
        .filter(name => name !== SHARED_MEMORY_DIRNAME);
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

  /** The lowest display index no agent holds, so a deleted agent's slot is reused. */
  private nextDisplayIndex(): number {
    const taken = new Set(
      this.list()
        .map(record => record.profile.displayIndex)
        .filter((index): index is number => typeof index === "number")
    );
    for (let index = 1; index <= 32; index++) {
      if (!taken.has(index)) return index;
    }
    throw new Error("No free desktop: all 32 display slots are assigned.");
  }

  create(input: {
    name: string;
    description?: string;
    title?: string;
    avatarColor?: string;
    hidden?: boolean;
    /** Who created it, when the box knows. */
    ownerUserId?: string;
    visibility?: "shared" | "private";
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
      displayIndex: this.nextDisplayIndex(),
      ...(input.ownerUserId !== undefined ? { ownerUserId: input.ownerUserId } : {}),
      visibility: input.visibility ?? "shared",
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

  /**
   * The agent's desktop, assigning one if it predates per-agent displays.
   *
   * Backfilled rather than defaulted, so an older agent gets a desktop of its own
   * instead of quietly sharing display 1 with everyone else.
   */
  displayIndexFor(agentId: string): number {
    const record = this.get(agentId);
    if (typeof record.profile.displayIndex === "number") {
      return record.profile.displayIndex;
    }

    const assigned = this.nextDisplayIndex();
    this.writeProfile(agentId, {
      ...record.profile,
      displayIndex: assigned,
      updatedAt: new Date().toISOString(),
    });
    return assigned;
  }

  /**
   * The agent's claim on its own desktop.
   *
   * Bound to a display in the box, which then refuses input carrying anyone else's token.
   * The reason it is needed: BOXD_TOKEN is what authorises a box request, and an agent
   * with a shell can reach the daemon directly — so nothing stopped one agent from
   * naming another's display and typing into it. Demonstrated, not theorised.
   *
   * Kept on the host, next to the agent's other state, because the box must not be able
   * to read it. Persisted rather than per-process so a restarted host rebinds the same
   * token instead of being locked out of a display it already owns.
   *
   * This is an accident guard, not a security boundary. Agents share a filesystem by
   * design and can already read each other's profiles or kill each other's processes;
   * what this removes is a whole class of silent interference.
   */
  boxOwnerTokenFor(agentId: string): string {
    const path = join(this.dirFor(agentId), BOX_OWNER_FILENAME);
    if (existsSync(path)) {
      const existing = readFileSync(path, "utf8").trim();
      if (existing) return existing;
    }

    const token = randomBytes(16).toString("hex");
    mkdirSync(this.dirFor(agentId), { recursive: true });
    writeFileSync(path, `${token}\n`, { encoding: "utf8", mode: 0o600 });
    return token;
  }

  /**
   * The token for whichever agent owns this desktop, if any.
   *
   * Here so host-side callers — the CLI, the web UI, the smoke test — can present the
   * right claim. The host holds every token; the box holds none. That asymmetry is the
   * whole design: a person driving their own box is never locked out of it, while an
   * agent inside the box cannot produce a claim it was not given.
   */
  boxOwnerTokenForDisplay(index: number): string | undefined {
    const owner = this.list().find(record => record.profile.displayIndex === index);
    return owner ? this.boxOwnerTokenFor(owner.id) : undefined;
  }

  planPathFor(agentId: string): string {
    return join(this.dirFor(agentId), PLAN_FILENAME);
  }

  todosPathFor(agentId: string): string {
    return join(this.dirFor(agentId), TODOS_FILENAME);
  }

  /**
   * The plan and todo list, as the prompt needs them.
   *
   * Reads defensively and independently: a todo file someone edited into invalid JSON must not stop
   * the plan being shown, and neither must stop a turn. A lost list is recoverable — the agent will
   * write a new one — while a turn that will not start is not.
   */
  readDurableState(agentId: string): DurableState {
    const state: DurableState = {};
    const planPath = this.planPathFor(agentId);
    if (existsSync(planPath)) {
      try {
        state.plan = readFileSync(planPath, "utf8");
        state.planUpdatedAt = statSync(planPath).mtime.toISOString();
      } catch {
        // Left absent, which renders as nothing rather than as an empty plan.
      }
    }
    const todosPath = this.todosPathFor(agentId);
    if (existsSync(todosPath)) {
      try {
        const parsed = JSON.parse(readFileSync(todosPath, "utf8")) as unknown;
        if (Array.isArray(parsed)) {
          state.todos = parsed.filter(
            (item): item is TodoItem =>
              typeof item === "object" &&
              item !== null &&
              typeof (item as TodoItem).text === "string" &&
              isTodoStatus(String((item as TodoItem).status))
          );
        }
      } catch {
        // Same: an unreadable list is no list.
      }
    }
    return state;
  }

  writePlan(agentId: string, plan: string): void {
    this.writeAtomic(this.planPathFor(agentId), plan);
  }

  writeTodos(agentId: string, todos: readonly TodoItem[]): void {
    this.writeAtomic(this.todosPathFor(agentId), `${JSON.stringify(todos, null, 2)}\n`);
  }

  /** Temp plus rename, so a reader never sees half a file. */
  private writeAtomic(path: string, content: string): void {
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temp, content, "utf8");
    renameSync(temp, path);
  }

  memoryRecordsPathFor(agentId: string): string {
    return join(this.dirFor(agentId), MEMORY_RECORDS_FILENAME);
  }

  /**
   * Every memory this agent has, oldest first.
   *
   * Imports a legacy `memory.md` the first time, so an agent that has been running keeps what it
   * knew. A torn or unparseable line costs that one record, not the file.
   */
  readMemoryRecords(agentId: string): MemoryRecord[] {
    const path = this.memoryRecordsPathFor(agentId);
    if (!existsSync(path)) {
      const legacy = this.readMemory(agentId);
      if (legacy.trim() === "") return [];
      const imported = importMarkdown(legacy);
      if (imported.length > 0) this.appendMemoryRecords(agentId, imported);
      return imported;
    }
    try {
      return readFileSync(path, "utf8")
        .split("\n")
        .filter(line => line.trim() !== "")
        .flatMap(line => {
          try {
            const parsed = JSON.parse(line) as MemoryRecord;
            return typeof parsed.text === "string" && typeof parsed.at === "string" ? [parsed] : [];
          } catch {
            return [];
          }
        });
    } catch {
      return [];
    }
  }

  appendMemoryRecords(agentId: string, records: readonly MemoryRecord[]): void {
    if (records.length === 0) return;
    mkdirSync(this.dirFor(agentId), { recursive: true });
    appendFileSync(
      this.memoryRecordsPathFor(agentId),
      records.map(record => `${JSON.stringify(record)}\n`).join(""),
      "utf8"
    );
  }

  private sharedMemoryDir(): string {
    return join(this.root, SHARED_MEMORY_DIRNAME);
  }

  sharedMemoryPathFor(agentId: string): string {
    return join(this.sharedMemoryDir(), `${agentId}.jsonl`);
  }

  /**
   * Every shard merged, each record tagged with the agent that wrote it.
   *
   * `via` is stamped on read from the filename rather than trusted from the record, so a shard cannot
   * claim to have been written by a different agent.
   */
  readSharedMemory(): MemoryRecord[] {
    const dir = this.sharedMemoryDir();
    if (!existsSync(dir)) return [];
    const out: MemoryRecord[] = [];
    let names: string[];
    try {
      names = readdirSync(dir).filter(name => name.endsWith(".jsonl"));
    } catch {
      return [];
    }
    for (const name of names) {
      const agentId = name.slice(0, -".jsonl".length);
      try {
        for (const line of readFileSync(join(dir, name), "utf8").split("\n")) {
          if (line.trim() === "") continue;
          try {
            const parsed = JSON.parse(line) as MemoryRecord;
            if (typeof parsed.text !== "string" || typeof parsed.at !== "string") continue;
            out.push({ ...parsed, via: agentId });
          } catch {
            // One torn line costs one record.
          }
        }
      } catch {
        // A shard that cannot be read is one agent's contribution, not the whole tier.
      }
    }
    return out;
  }

  /** Appends to this agent's own shard, which is the only one it may write. */
  appendSharedMemory(agentId: string, records: readonly MemoryRecord[]): void {
    if (records.length === 0) return;
    mkdirSync(this.sharedMemoryDir(), { recursive: true });
    appendFileSync(
      this.sharedMemoryPathFor(agentId),
      records.map(record => `${JSON.stringify(record)}\n`).join(""),
      "utf8"
    );
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
