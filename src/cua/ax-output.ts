/**
 * What box-ax prints: the tree it read, or why it could not. Since INV-1481 a read that ran out
 * of budget is still a tree — `complete: false` and the containers it never entered (`cut`),
 * each with the child-index path a `--root` read can take back to it.
 */
export interface AxOutput {
  window: { title: string; app: string; truncated: boolean; identity?: string; id?: string };
  /** False when the control limit or the deadline stopped the read. */
  complete: boolean;
  /** The containers whose children were not reached, with the path to read each alone. */
  cut: { role: string; name: string; children_count: number; path: string }[];
  elements: { ref: string; identity?: string; role: string; name: string; x: number; y: number; width: number; height: number; states: string[]; operations?: string[] }[];
}

export function parseAxOutput(text: string): AxOutput | { error: string } | undefined {
  const line = text.trim().split("\n").pop() ?? "";
  if (line === "") return undefined;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (typeof parsed.error === "string") return { error: parsed.error };
  if (!Array.isArray(parsed.elements)) return undefined;
  const window = (parsed.window ?? {}) as Record<string, unknown>;
  return {
    window: {
      title: typeof window.title === "string" ? window.title : "",
      app: typeof window.app === "string" ? window.app : "",
      truncated: parsed.truncated === true,
      identity: typeof window.identity === "string" ? window.identity : undefined,
      id: typeof window.id === "string" ? window.id : undefined,
    },
    // An older box-ax prints neither field: its read was whole unless it said truncated.
    complete: typeof parsed.complete === "boolean" ? parsed.complete : parsed.truncated !== true,
    cut: (Array.isArray(parsed.cut) ? (parsed.cut as Record<string, unknown>[]) : [])
      .filter(c => typeof c.path === "string" && typeof c.role === "string")
      .map(c => ({ role: c.role as string, name: typeof c.name === "string" ? c.name : "", children_count: typeof c.children_count === "number" ? c.children_count : 0, path: c.path as string })),
    elements: (parsed.elements as Record<string, unknown>[])
      .filter(e => typeof e.ref === "string" && typeof e.role === "string")
      .map(e => ({
        ref: e.ref as string,
        identity: typeof e.identity === "string" ? e.identity : undefined,
        operations: Array.isArray(e.operations) ? e.operations.filter((op): op is string => op === "invoke" || op === "set_value") : [],
        role: e.role as string,
        name: typeof e.name === "string" ? e.name : "",
        x: Number(e.x ?? 0),
        y: Number(e.y ?? 0),
        width: Number(e.width ?? 0),
        height: Number(e.height ?? 0),
        states: Array.isArray(e.states) ? e.states.filter((s): s is string => typeof s === "string") : [],
      })),
  };
}
