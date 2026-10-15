/** Registry-owned context storage. One host is the writer; a switch has no async gap. */
import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type ContextMode = "normal" | "clean" | "recover";

export interface ContextVersion {
  epoch: number;
  mode: ContextMode;
}
/** What the new epoch actually opened with (INV-1190): the reply about a switch is derived from it. */
export type OpeningOutcome = "handoff" | "placeholder";

interface Operation extends ContextVersion {
  id: string;
  /** Present only on a switch that carried a handoff; absent for a plain /new. */
  opening?: OpeningOutcome;
}
interface PreparedOperation extends ContextVersion {
  id: string;
  /** The staged opening this switch must install before the new epoch is published. */
  opening?: { path: string; sha256: string };
}
interface State extends ContextVersion {
  schema: 1;
  operations: Operation[];
  prepared?: PreparedOperation;
}

/** Thrown before anything durable happened, so the caller may fall back to a switch without a handoff. */
export class OpeningStagingError extends Error {}

/**
 * Written when a prepared switch's staged handoff is gone at install time. Never replaces an
 * opening that is already installed and intact; the switch completes either way, because a
 * durable prepare is an obligation to finish, not to roll back (INV-1190 review round 2).
 */
export const PLACEHOLDER_OPENING = {
  role: "user",
  kind: "summary",
  covers: 0,
  handoff: { lost: true },
  text: "[Handoff from the previous context was lost during the switch. The earlier conversation is still on record: use ReadHistory to look things up.]",
  at: new Date(0).toISOString(),
};

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** Writes a file and makes the write and its directory entry durable before returning. */
function writeDurably(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  writeFileSync(temp, content, { mode: 0o600 });
  syncPath(temp);
  renameSync(temp, path);
  syncPath(dirname(path));
}

function syncPath(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    fsyncSync(fd);
  } catch {
    // Directory fsync is not supported everywhere (some platforms refuse it); the rename
    // ordering still holds for a process crash, and power-loss durability is best effort.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export class ContextEpochStore {
  readonly root: string;
  private readonly statePath: string;

  constructor(
    private readonly legacy: Record<string, string> & { transcript: string },
    private readonly afterPrepare?: () => void
  ) {
    this.root = `${legacy.transcript}.epochs`;
    this.statePath = join(this.root, "state.json");
  }

  private read(): State {
    if (!existsSync(this.statePath)) return { schema: 1, epoch: 0, mode: "normal", operations: [] };
    const state = JSON.parse(readFileSync(this.statePath, "utf8")) as State;
    // Context epochs shipped before clean mode. Their absent mode means normal; this
    // migration is in-memory until the next atomic state write.
    state.mode ??= state.operations.at(-1)?.mode ?? "normal";
    for (const operation of state.operations) operation.mode ??= "normal";
    if (state.prepared !== undefined) state.prepared.mode ??= "normal";
    if (
      state.schema !== 1 ||
      !Number.isSafeInteger(state.epoch) ||
      state.epoch < 0 ||
      !Array.isArray(state.operations) ||
      state.operations.some((op, index) => typeof op?.id !== "string" || op.epoch !== index + 1 || !isMode(op.mode)) ||
      new Set(state.operations.map(op => op.id)).size !== state.operations.length ||
      state.operations.length !== state.epoch ||
      !isMode(state.mode) ||
      (state.epoch === 0 ? state.mode !== "normal" : state.operations.at(-1)?.mode !== state.mode) ||
      (state.prepared !== undefined &&
        (typeof state.prepared.id !== "string" || state.prepared.epoch !== state.epoch + 1 || !isMode(state.prepared.mode)))
    ) {
      throw new Error("Unsupported or corrupt context state; refusing legacy fallback");
    }
    return state.prepared === undefined ? state : this.commit(state);
  }

  private save(state: State): void {
    mkdirSync(this.root, { recursive: true });
    // The registry is the single synchronous writer. A fixed sibling keeps the atomic
    // rename without introducing another UUID minting site in the message path.
    const temp = `${this.statePath}.tmp`;
    writeFileSync(temp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    syncPath(temp);
    renameSync(temp, this.statePath);
    syncPath(this.root);
  }

  /**
   * Finishes a prepared switch. One sequence, also run by `read()` on restart: migrate the
   * legacy files (epoch 0 only), install the handoff opening if this switch carries one,
   * make every directory touched durable, and only then publish the new epoch. Nothing here
   * rolls back — a durable prepare is an obligation to finish (INV-1190).
   */
  private commit(state: State): State {
    const prepared = state.prepared!;
    if (state.epoch === 0) {
      mkdirSync(join(this.root, "0"), { recursive: true });
      for (const [name, original] of Object.entries(this.legacy)) {
        const archived = join(this.root, "0", name);
        if (!existsSync(original) || (name === "transcript" && statSync(original).isDirectory())) continue;
        if (existsSync(archived)) throw new Error("Context migration collision; refusing to overwrite history");
        renameSync(original, archived);
      }
      // A pre-epoch binary must fail reading/appending here, not silently resume the old topic.
      // This is an intentional downgrade fence, not an empty replacement transcript.
      mkdirSync(this.legacy.transcript, { recursive: true });
      for (const dir of new Set([join(this.root, "0"), this.root, ...Object.values(this.legacy).map(path => dirname(path))])) syncPath(dir);
    }
    let opening: OpeningOutcome | undefined;
    if (prepared.opening !== undefined) opening = this.installOpening(prepared.epoch, prepared.opening);
    const committed: State = {
      schema: 1,
      epoch: prepared.epoch,
      mode: prepared.mode,
      operations: [...state.operations, { id: prepared.id, epoch: prepared.epoch, mode: prepared.mode, ...(opening !== undefined ? { opening } : {}) }],
    };
    this.save(committed);
    if (prepared.opening !== undefined) {
      try { unlinkSync(prepared.opening.path); } catch { /* already gone */ }
    }
    return committed;
  }

  /** The handoff becomes entry 0 of the new epoch's transcript, before that epoch is current. */
  private installOpening(epoch: number, staged: { path: string; sha256: string }): OpeningOutcome {
    const target = join(this.root, String(epoch), "transcript");
    // Already installed and intact (a restart after install, before publish): keep it.
    if (existsSync(target) && sha256(readFileSync(target, "utf8")) === staged.sha256) return "handoff";
    if (existsSync(staged.path)) {
      const content = readFileSync(staged.path, "utf8");
      if (sha256(content) === staged.sha256) {
        writeDurably(target, content);
        return "handoff";
      }
    }
    writeDurably(target, `${JSON.stringify(PLACEHOLDER_OPENING)}\n`);
    return "placeholder";
  }

  current(): ContextVersion {
    const { epoch, mode } = this.read();
    return { epoch, mode };
  }

  previousOperation(id: string): (ContextVersion & { opening?: OpeningOutcome }) | undefined {
    const found = this.read().operations.find(op => op.id === id);
    return found === undefined ? undefined : { epoch: found.epoch, mode: found.mode, ...(found.opening !== undefined ? { opening: found.opening } : {}) };
  }

  /**
   * Switches to a new epoch. With `opening` (JSONL text), the new epoch opens with it: it is
   * staged and verified *before* prepare, so a failure there throws `OpeningStagingError` with
   * nothing durable changed and the caller may switch without it. A handoff only ever rides a
   * normal switch.
   */
  advance(id: string, expectedRevision: number, mode: ContextMode = "normal", options: { opening?: string } = {}): ContextVersion & { opening?: OpeningOutcome } {
    if (!id.trim()) throw new Error("Context operation id is required");
    if (!isMode(mode)) throw new Error("Unsupported context mode");
    if (options.opening !== undefined && mode !== "normal") throw new Error("A handoff only rides a normal switch");
    const state = this.read();
    const previous = state.operations.find(op => op.id === id);
    if (previous !== undefined) return { epoch: previous.epoch, mode: previous.mode, ...(previous.opening !== undefined ? { opening: previous.opening } : {}) };
    if (state.epoch !== expectedRevision) throw new Error("Context revision changed; retry against current state");
    let staged: { path: string; sha256: string } | undefined;
    if (options.opening !== undefined) {
      const path = join(this.root, "staging", `${id.replace(/[^\w.-]/g, "_")}.jsonl`);
      const digest = sha256(options.opening);
      try {
        writeDurably(path, options.opening);
        if (sha256(readFileSync(path, "utf8")) !== digest) throw new Error("staged handoff does not read back intact");
      } catch (error) {
        throw new OpeningStagingError(`Handoff not staged: ${error instanceof Error ? error.message : String(error)}`);
      }
      staged = { path, sha256: digest };
    }
    const prepared: State = { ...state, prepared: { id, epoch: state.epoch + 1, mode, ...(staged !== undefined ? { opening: staged } : {}) } };
    this.save(prepared);
    this.afterPrepare?.();
    const committed = this.commit(prepared);
    const done = committed.operations.at(-1)!;
    return { epoch: committed.epoch, mode: committed.mode, ...(done.opening !== undefined ? { opening: done.opening } : {}) };
  }

  path(name: string, epoch?: number): string {
    const state = this.read();
    const version = epoch ?? state.epoch;
    if (!Number.isSafeInteger(version) || version < 0 || version > state.epoch || this.legacy[name] === undefined) {
      throw new Error("Unknown context version or file");
    }
    return state.epoch === 0 ? this.legacy[name]! : join(this.root, String(version), name);
  }

  versions(): number[] {
    return Array.from({ length: this.read().epoch + 1 }, (_, epoch) => epoch);
  }
}

function isMode(value: unknown): value is ContextMode {
  return value === "normal" || value === "clean" || value === "recover";
}
