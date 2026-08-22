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
  rmSync,
  writeFileSync,
  existsSync,
  statSync,
} from "node:fs";
import { appendLine } from "../host/jsonl.ts";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isTodoStatus, type DurableState, type TodoItem } from "../host/durable.ts";
import {
  compactMemoryLines,
  compactSharedShardLines,
  importMarkdown,
  MEMORY_COMPACT_AT,
  type MemoryRecord,
} from "../host/memory.ts";

export const AGENT_NAME_MAX_LENGTH = 72;
export const AGENT_DESCRIPTION_MAX_LENGTH = 2000;
export const PROFILE_FILENAME = "profile.json";
export const TRANSCRIPT_FILENAME = "conversation.jsonl";
/**
 * The conversation every agent always has: the one the web page, teammates and the
 * scheduler share. Outside chats get their own — context belongs to the room it
 * happened in, and two groups talking to one agent must not read each other.
 */
export const MAIN_CONVERSATION = "main";
export const CONVERSATIONS_DIRNAME = "conversations";
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
  /**
   * The tools this agent may be offered, by name. Absent means all of them.
   *
   * Four agents holding identical tools are four agents differing only in the prose that describes
   * them, which is a division of tone rather than of labour. A reviewer that *cannot* write is a
   * different thing from one that is asked not to.
   *
   * Withheld rather than refused: a tool an agent cannot use is not in its prompt. Offering it and
   * rejecting the call spends a round and teaches the model that its tool list is not true.
   *
   * An agent can never widen this — not for itself, and not by creating a colleague. See
   * `CreateAgent`, which passes its creator's set down.
   */
  tools?: readonly string[];
  /**
   * The scope this agent works in, if any. A scope confers a tool set and secret
   * grants as one named bundle — see host/scopes.ts. When set, the scope's tool list
   * is the agent's, replacing `tools`, because an agent in a scope is defined by it.
   */
  scopeId?: string;
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

  /**
   * Where a conversation's transcript lives.
   *
   * The main conversation keeps the original filename, so every transcript that
   * existed before conversations did *is* its agent's team room — no migration, and
   * an old install wakes up with its history where it always was.
   */
  transcriptPathFor(agentId: string, conversation = MAIN_CONVERSATION): string {
    if (conversation === MAIN_CONVERSATION) {
      return join(this.dirFor(agentId), TRANSCRIPT_FILENAME);
    }
    return join(this.dirFor(agentId), CONVERSATIONS_DIRNAME, `${conversation}.jsonl`);
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
    /** Which tools it may be offered. Absent means all; see AgentProfile.tools. */
    tools?: readonly string[];
    /** The scope to place it in. Its tool set and secrets then come from the scope. */
    scopeId?: string;
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
      ...(input.tools !== undefined ? { tools: [...input.tools] } : {}),
      ...(input.scopeId !== undefined && input.scopeId !== "" ? { scopeId: input.scopeId } : {}),
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
      /**
       * The tool set, `null` to lift the restriction entirely. Reached only from the
       * web UI's agent dialog — the model-facing UpdateAgent tool never passes this,
       * which is what keeps "nothing grants what the granter does not hold" true.
       */
      tools?: readonly string[] | null;
      /** The scope to place it in, `null`/`""` to remove it from one. UI path only. */
      scopeId?: string | null;
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
    if (changes.tools !== undefined) {
      if (changes.tools === null) delete profile.tools;
      else profile.tools = [...changes.tools];
    }
    if (changes.scopeId !== undefined) {
      if (changes.scopeId === null || changes.scopeId === "") delete profile.scopeId;
      else profile.scopeId = changes.scopeId;
    }

    profile.updatedAt = new Date().toISOString();
    this.writeProfile(agentId, profile);
    return { id: agentId, profile, dir: this.dirFor(agentId) };
  }

  /**
   * Removes an agent. A human action, reached only from the UI — no tool leads here.
   *
   * Two modes, because "delete the agent" and "delete everything it ever did" are
   * different decisions. Archiving moves the whole directory — transcript, memory,
   * plan — to `archive/agents/` beside the roster, where it is ordinary files a
   * person can read or restore by moving back. Deleting removes it outright.
   *
   * The agent's shard of *shared* memory stays either way: facts it shared belong to
   * the team, and withdrawing them because their author left would silently change
   * what everyone else remembers.
   */
  remove(agentId: string, options: { archive: boolean }): { archivedTo?: string } {
    const record = this.get(agentId);
    const dir = this.dirFor(agentId);

    if (!options.archive) {
      rmSync(dir, { recursive: true, force: true });
      return {};
    }

    const archiveRoot = join(dirname(this.root), "archive", "agents");
    mkdirSync(archiveRoot, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10);
    const dest = join(
      archiveRoot,
      `${record.profile.name.replace(/[^\p{L}\p{N}._-]+/gu, "_")}-${stamp}-${agentId.slice(0, 8)}`
    );
    renameSync(dir, dest);
    return { archivedTo: dest };
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

  /**
   * The plan and todo files, per conversation.
   *
   * The main conversation keeps the original filenames — so an old install's plan and
   * todos are its team room's, untouched — and side conversations (outside chats
   * running concurrently) get their own under the conversations directory, because two
   * threads of one agent working at once are two separate pieces of intent and must
   * not overwrite each other's list.
   */
  planPathFor(agentId: string, conversation = MAIN_CONVERSATION): string {
    if (conversation === MAIN_CONVERSATION) return join(this.dirFor(agentId), PLAN_FILENAME);
    return join(this.dirFor(agentId), CONVERSATIONS_DIRNAME, `${conversation}.plan.md`);
  }

  todosPathFor(agentId: string, conversation = MAIN_CONVERSATION): string {
    if (conversation === MAIN_CONVERSATION) return join(this.dirFor(agentId), TODOS_FILENAME);
    return join(this.dirFor(agentId), CONVERSATIONS_DIRNAME, `${conversation}.todos.json`);
  }

  /**
   * The plan and todo list, as the prompt needs them.
   *
   * Reads defensively and independently: a todo file someone edited into invalid JSON must not stop
   * the plan being shown, and neither must stop a turn. A lost list is recoverable — the agent will
   * write a new one — while a turn that will not start is not.
   */
  readDurableState(agentId: string, conversation = MAIN_CONVERSATION): DurableState {
    const state: DurableState = {};
    const planPath = this.planPathFor(agentId, conversation);
    if (existsSync(planPath)) {
      try {
        state.plan = readFileSync(planPath, "utf8");
        state.planUpdatedAt = statSync(planPath).mtime.toISOString();
      } catch {
        // Left absent, which renders as nothing rather than as an empty plan.
      }
    }
    const todosPath = this.todosPathFor(agentId, conversation);
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

  writePlan(agentId: string, plan: string, conversation = MAIN_CONVERSATION): void {
    this.writeAtomic(this.planPathFor(agentId, conversation), plan);
  }

  writeTodos(agentId: string, todos: readonly TodoItem[], conversation = MAIN_CONVERSATION): void {
    this.writeAtomic(this.todosPathFor(agentId, conversation), `${JSON.stringify(todos, null, 2)}\n`);
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
    for (const record of records) {
      appendLine(this.memoryRecordsPathFor(agentId), JSON.stringify(record));
    }
    this.maybeCompactOwnMemory(agentId);
  }

  /**
   * Line counts at which the last compaction attempt found nothing to drop, per path.
   *
   * Without this, a file whose records are all genuinely live — over the threshold with nothing to
   * shrink — would be re-read and re-judged on every append, forever. A file that could not shrink
   * at N lines is not retried until it has grown past N.
   */
  private readonly memoryCompactFloor = new Map<string, number>();

  /**
   * Rewrites an agent's memory file down to its live view, past a threshold.
   *
   * Memory was the one durable log that never bounded its own file: the *view* was bounded (dedupe,
   * decay, a character budget) so nothing ever noticed the file underneath only grew. The rewrite
   * keeps exactly the records every reader already sees, byte-for-byte and in order, so the view
   * before and after is identical — including decay, because the timestamps are untouched. The cost
   * accepted is the same one usage and policy already accept: "what was believed when" is only
   * recoverable back to the last compaction.
   */
  private maybeCompactOwnMemory(agentId: string): void {
    const path = this.memoryRecordsPathFor(agentId);
    try {
      const lines = readFileSync(path, "utf8")
        .split("\n")
        .filter(line => line.trim() !== "");
      if (lines.length <= MEMORY_COMPACT_AT) return;
      // The floor carries slack: a file that could not shrink at N lines grows by one on every
      // append, so "retry when bigger than N" would re-read and re-judge the whole file every
      // single time. An eighth's growth between attempts keeps the judging cost amortised.
      const floor = this.memoryCompactFloor.get(path);
      if (floor !== undefined && lines.length <= floor + Math.max(32, floor >> 3)) return;

      const kept = compactMemoryLines(lines);
      if (kept === undefined) {
        this.memoryCompactFloor.set(path, lines.length);
        return;
      }
      // Temp plus rename, so a reader never sees half a file — the same shape as every other log.
      const temp = `${path}.${process.pid}.tmp`;
      writeFileSync(temp, kept.length === 0 ? "" : `${kept.join("\n")}\n`, "utf8");
      renameSync(temp, path);
      this.memoryCompactFloor.delete(path);
    } catch {
      // Never fail an append over housekeeping: the worst case is the file stays big, which is the
      // behaviour it always had.
    }
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
    // Merged in timestamp order, not shard-enumeration order. Retraction correctness in dedupe
    // depends on a record being seen after the one it withdraws — and a retraction written to one
    // agent's shard withdraws a fact in another's, so reading shard-by-shard could process the
    // later retraction before the earlier fact and leave both. A stable sort by `at` restores the
    // global order the append-only design assumes.
    out.sort((a, b) => a.at.localeCompare(b.at));
    return out;
  }

  /** Appends to this agent's own shard, which is the only one it may write. */
  appendSharedMemory(agentId: string, records: readonly MemoryRecord[]): void {
    if (records.length === 0) return;
    mkdirSync(this.sharedMemoryDir(), { recursive: true });
    for (const record of records) {
      appendLine(this.sharedMemoryPathFor(agentId), JSON.stringify(record));
    }
    this.maybeCompactSharedMemory();
  }

  /**
   * Compacts every shard together, past a threshold on their combined size.
   *
   * Together, never one at a time: a retraction in one agent's shard withdraws a fact in another's,
   * and compacting a single shard by its own live view would drop the retraction while the fact it
   * killed still sits elsewhere — resurrecting it. The helper's rule (a retraction is only dropped
   * once nothing it could kill remains on disk) makes any interleaving of the shard writes safe,
   * so a crash between two rewrites cannot bring anything back either.
   */
  private maybeCompactSharedMemory(): void {
    const dir = this.sharedMemoryDir();
    try {
      const names = readdirSync(dir).filter(name => name.endsWith(".jsonl"));
      const shards = new Map<string, readonly string[]>();
      let total = 0;
      for (const name of names) {
        const lines = readFileSync(join(dir, name), "utf8")
          .split("\n")
          .filter(line => line.trim() !== "");
        shards.set(name, lines);
        total += lines.length;
      }
      if (total <= MEMORY_COMPACT_AT) return;
      const floor = this.memoryCompactFloor.get(dir);
      if (floor !== undefined && total <= floor + Math.max(32, floor >> 3)) return;

      const kept = compactSharedShardLines(shards);
      if (kept === undefined) {
        this.memoryCompactFloor.set(dir, total);
        return;
      }
      for (const [name, lines] of kept) {
        if (lines.length === (shards.get(name) ?? []).length) continue; // unchanged shard
        const path = join(dir, name);
        const temp = `${path}.${process.pid}.tmp`;
        writeFileSync(temp, lines.length === 0 ? "" : `${lines.join("\n")}\n`, "utf8");
        renameSync(temp, path);
      }
      this.memoryCompactFloor.delete(dir);
    } catch {
      // Housekeeping only; the file staying big is the old behaviour, not a failure.
    }
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

  appendTranscript(agentId: string, entry: unknown, conversation = MAIN_CONVERSATION): void {
    mkdirSync(dirname(this.transcriptPathFor(agentId, conversation)), { recursive: true });
    appendLine(this.transcriptPathFor(agentId, conversation), JSON.stringify(entry));
  }

  readTranscript(agentId: string, conversation = MAIN_CONVERSATION): unknown[] {
    const path = this.transcriptPathFor(agentId, conversation);
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

  /**
   * Every conversation this agent has, the team room first.
   *
   * "main" is the room the web page, teammates and the scheduler share; the others
   * are one per outside chat — a Telegram DM, a Feishu group — so two groups talking
   * to the same agent never see each other's context.
   */
  listConversations(agentId: string): { id: string; lastAt?: string }[] {
    const conversations: { id: string; lastAt?: string }[] = [];
    const main = this.transcriptPathFor(agentId);
    conversations.push({
      id: MAIN_CONVERSATION,
      ...(existsSync(main) ? { lastAt: statSync(main).mtime.toISOString() } : {}),
    });
    const dir = join(this.dirFor(agentId), CONVERSATIONS_DIRNAME);
    if (!existsSync(dir)) return conversations;
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
        conversations.push({
          id: entry.name.slice(0, -".jsonl".length),
          lastAt: statSync(join(dir, entry.name)).mtime.toISOString(),
        });
      }
    } catch {
      // A listing that cannot be read is an empty listing, not a broken page.
    }
    return conversations;
  }
}

/**
 * A conversation id from an outside chat's identity, safe as a filename.
 *
 * The identity is already `channel:id`; what changes is only what a filesystem
 * refuses. Distinct chats must stay distinct, so anything unsafe is replaced
 * one-for-one rather than collapsed.
 */
export function conversationIdFor(chatIdentity: string): string {
  return chatIdentity.replace(/[^\p{L}\p{N}._-]/gu, "-").slice(0, 120);
}
