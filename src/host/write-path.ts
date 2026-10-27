/**
 * Declared write paths for browser writes (INV-1379).
 *
 * The box already refuses a click it reads as paying, publishing or deleting until a person
 * approves it (the 428 path), and a dispatch it could not confirm comes back `unknown`. What was
 * missing is the part after: a timeout, a page that redirected, and the agent clicks Submit again —
 * two orders. So a multi-step write declares its path up front, as the commit marks it will cross
 * in order (`writePath: ["add-to-cart", "pay"]` on the first `browser_act` that passes `commit`),
 * and each commit step names its mark. The host records which marks were entered; a mark already
 * entered — or whose click went out with an unknown result — cannot be pressed again until
 * `browser_verify_write` records `not_done` for it from the page. `unknown` keeps it refused and
 * says to ask the person. A path left unfinished at the end of the turn is reported as incomplete.
 *
 * In memory, per agent and conversation, for six hours: a restart forgets an open path, which
 * errs toward asking (the 428 gate still stands) rather than toward a silent repeat being allowed
 * by a stale record. Calls without `commit` are untouched.
 */

export type Verdict = "done" | "not_done" | "unknown";

interface PathState {
  marks: string[];
  entered: Set<string>;
  uncertain: Set<string>;
  verdicts: Map<string, { verdict: Verdict; page: string; at: number }>;
  at: number;
}

const TTL_MS = 6 * 60 * 60_000;
const MARK = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,62}$/;

export class WritePaths {
  private readonly paths = new Map<string, PathState>();
  constructor(private readonly now: () => number = Date.now) {}

  private open(key: string): PathState | undefined {
    const state = this.paths.get(key);
    if (state !== undefined && this.now() - state.at > TTL_MS) this.paths.delete(key);
    return this.paths.get(key);
  }

  /** Before a commit step: undefined to go ahead, or why not. */
  before(key: string, mark: string, declared: unknown): string | undefined {
    if (!MARK.test(mark)) return "commit must be a short name for this step (letters, digits, - _ . and spaces).";
    let state = this.open(key);
    const finished = state !== undefined && state.marks.every(m => state!.entered.has(m) && !state!.uncertain.has(m));
    if (Array.isArray(declared) && declared.length > 0) {
      const marks = declared.map(String);
      if (marks.some(m => !MARK.test(m)) || new Set(marks).size !== marks.length || marks.length > 12) return "writePath must be up to 12 distinct short step names, in order.";
      if (state !== undefined && !finished && marks.join("\u0000") !== state.marks.join("\u0000")) {
        return `A write path is already open (${state.marks.join(" → ")}; entered: ${[...state.entered].join(", ") || "none"}). Finish it, or verify where it stands with browser_verify_write, before declaring another.`;
      }
      if (state === undefined || finished) {
        state = { marks, entered: new Set(), uncertain: new Set(), verdicts: new Map(), at: this.now() };
        this.paths.set(key, state);
      }
    }
    if (state === undefined) return "This is a commit step but no write path is open: pass writePath — every commit mark this flow will cross, in order — on its first commit step.";
    if (!state.marks.includes(mark)) return `"${mark}" is not on the declared write path (${state.marks.join(" → ")}).`;
    if (state.entered.has(mark) || state.uncertain.has(mark)) {
      const verdict = state.verdicts.get(mark);
      if (verdict?.verdict === "not_done") {
        state.verdicts.delete(mark);
        state.entered.delete(mark);
        state.uncertain.delete(mark);
        return undefined;
      }
      if (verdict?.verdict === "unknown") return `"${mark}" was already pressed and whether it took effect is unknown. Do not press it again: tell the person what you see and ask.`;
      return `"${mark}" was already pressed${state.uncertain.has(mark) ? " (its result was not confirmed)" : ""}. Pressing it again could do it twice. Read the page and call browser_verify_write for "${mark}"; only not_done allows another try.`;
    }
    return undefined;
  }

  /** After a commit step went out: entered when it was confirmed, uncertain when the result is unknown. */
  after(key: string, mark: string, outcome: "entered" | "unknown" | "failed"): string {
    const state = this.open(key);
    if (state === undefined) return "";
    if (outcome === "entered") state.entered.add(mark);
    if (outcome === "unknown") state.uncertain.add(mark);
    state.at = this.now();
    return this.status(key);
  }

  /** The agent's reading of the page for one mark. */
  verify(key: string, mark: string, verdict: Verdict, page: string): string {
    const state = this.open(key);
    if (state === undefined || !state.marks.includes(mark)) return `No open write path has a step "${mark}".`;
    state.verdicts.set(mark, { verdict, page, at: this.now() });
    if (verdict === "done") {
      state.entered.add(mark);
      state.uncertain.delete(mark);
    }
    return `Recorded "${mark}" as ${verdict} (page: ${page}). ${verdict === "not_done" ? "You may press it once more." : verdict === "unknown" ? "Do not press it again; ask the person." : ""}\n${this.status(key)}`.trim();
  }

  /** One line on where the path stands, or "" when there is none. */
  status(key: string): string {
    const state = this.open(key);
    if (state === undefined) return "";
    const line = state.marks.map(m => `${m}${state.entered.has(m) && !state.uncertain.has(m) ? " ✓" : state.uncertain.has(m) ? " ?" : ""}`).join(" → ");
    const remaining = state.marks.filter(m => !state.entered.has(m) || state.uncertain.has(m));
    return remaining.length === 0 ? `Write path complete: ${line}.` : `Write path: ${line}. Not yet entered or unconfirmed: ${remaining.join(", ")}.`;
  }

  /** For the end of a turn: the incomplete note, or undefined when no path is open or it finished. */
  incomplete(key: string): string | undefined {
    const state = this.open(key);
    if (state === undefined) return undefined;
    const remaining = state.marks.filter(m => !state.entered.has(m) || state.uncertain.has(m));
    return remaining.length === 0 ? undefined : `incomplete (write_path): ${state.marks.join(" → ")} — not entered or unconfirmed: ${remaining.join(", ")}`;
  }
}

/** The installation's one record; the tools and the turn read it by agent and conversation. */
export const writePaths = new WritePaths();
export const writePathKey = (agentId: string, conversation: string | undefined) => `${agentId}\u0000${conversation ?? "main"}`;

/** Added to browser_act's schema, and the verify tool, without growing tools.ts (INV-1379). */
export function withWritePath(tools: { name: string; input_schema: unknown }[]): void {
  const act = tools.find(tool => tool.name === "browser_act");
  if (act === undefined) return;
  const schema = act.input_schema as { properties: Record<string, unknown> };
  schema.properties.commit = {
    type: "string",
    description:
      "Mark this step as one that submits, pays, books, sends or deletes, by a short name (\"pay\"). " +
      "A commit step that was pressed cannot be pressed again until browser_verify_write says not_done — so a timeout never becomes a second order.",
  };
  schema.properties.writePath = {
    type: "array",
    items: { type: "string" },
    description: "On the first commit step of a flow: every commit mark it will cross, in order, e.g. [\"add-to-cart\", \"pay\"]. A person approving the flow sees the whole path.",
  };
  tools.push({
    name: "browser_verify_write",
    description:
      "After a commit step whose result you are not sure of, or before pressing one again: read the page (browser_snapshot) and record " +
      "whether the step took effect — done, not_done or unknown. Only not_done lets the step be pressed again; unknown means ask the person.",
    input_schema: {
      type: "object",
      properties: {
        mark: { type: "string", description: "The commit mark, as declared in writePath." },
        verdict: { type: "string", enum: ["done", "not_done", "unknown"] },
        evidence: { type: "string", description: "What on the page says so: an order number, a 'Saved' banner, the unchanged form." },
      },
      required: ["mark", "verdict", "evidence"],
    },
  } as never);
}

/** After a browser_act: a commit step's outcome recorded and the path's status appended. */
export function afterCommit<T extends { text: string; isError?: boolean }>(key: string, input: Record<string, unknown>, result: T): T {
  if (typeof input.commit !== "string") return result;
  // Read from the verdict line every browser result starts with. A write is `ok` only when its
  // `expect` was met; refused never reached the page; failed or unknown may have, so it counts as
  // pressed but unconfirmed — the safe reading for "do not do it twice".
  const verdict = /^Outcome: (ok|refused|failed|unknown)/.exec(result.text)?.[1] ?? "unknown";
  if (verdict === "refused") return result;
  const status = writePaths.after(key, input.commit, verdict === "ok" ? "entered" : "unknown");
  return status === "" ? result : { ...result, text: `${result.text}\n\n${status}` };
}
