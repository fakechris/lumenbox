/** Registry-owned context storage. One host is the writer; a switch has no async gap. */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ContextVersion {
  epoch: number;
}
interface Operation extends ContextVersion {
  id: string;
}
interface State extends ContextVersion {
  schema: 1;
  operations: Operation[];
  prepared?: Operation;
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
    if (!existsSync(this.statePath)) return { schema: 1, epoch: 0, operations: [] };
    const state = JSON.parse(readFileSync(this.statePath, "utf8")) as State;
    if (
      state.schema !== 1 ||
      !Number.isSafeInteger(state.epoch) ||
      state.epoch < 0 ||
      !Array.isArray(state.operations) ||
      state.operations.some((op, index) => typeof op?.id !== "string" || op.epoch !== index + 1) ||
      state.operations.length !== state.epoch ||
      (state.prepared !== undefined &&
        (typeof state.prepared.id !== "string" || state.prepared.epoch !== state.epoch + 1))
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
    renameSync(temp, this.statePath);
  }

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
    }
    const committed: State = {
      schema: 1,
      epoch: prepared.epoch,
      operations: [...state.operations, prepared],
    };
    this.save(committed);
    return committed;
  }

  current(): ContextVersion {
    return { epoch: this.read().epoch };
  }

  previousOperation(id: string): ContextVersion | undefined {
    const found = this.read().operations.find(op => op.id === id);
    return found === undefined ? undefined : { epoch: found.epoch };
  }

  advance(id: string, expectedRevision: number): ContextVersion {
    if (!id.trim()) throw new Error("Context operation id is required");
    const state = this.read();
    const previous = state.operations.find(op => op.id === id);
    if (previous !== undefined) return { epoch: previous.epoch };
    if (state.epoch !== expectedRevision) throw new Error("Context revision changed; retry against current state");
    const prepared: State = { ...state, prepared: { id, epoch: state.epoch + 1 } };
    this.save(prepared);
    this.afterPrepare?.();
    return { epoch: this.commit(prepared).epoch };
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
