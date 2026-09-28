/**
 * Whether a final answer is an answer at all (INV-761).
 *
 * The incident, 2026-09-26, turn 0c87cb81: a clean context offered the model no tools, the
 * prompt still read like a harness full of them, and MiniMax-M3 wrote its call as text —
 * `]<]minimax[>[<tool_call>` then `{"name": "web_search", …}` — and kept writing one line
 * per query, drifting ("long horizon radiant", "luminous", "dazzling") until the 32 000-token
 * cap. The loop took 109 586 characters of that as the reply, delivered it, and the channel
 * marked the task done. Nothing between the model and the person asked whether it read as
 * an answer.
 *
 * Two shapes, both cheap to see and both rare in real prose:
 *
 * - **A leaked tool call.** Native call markup outside any code span. Such text is never
 *   executed here — this host only runs structured `tool_use` blocks — so its presence means
 *   the model believed it was acting and nothing happened. Hermes strips closed blocks of
 *   this kind from what it shows (run_agent.py `_strip_think_blocks`), OpenClaw strips a
 *   MiniMax variant (`stripMinimaxToolCallXml`); neither would have caught an unclosed one,
 *   and both still treat what is left as the answer.
 * - **Degeneration at the cap.** A `max_tokens` stop whose tail is the same line again and
 *   again. A long honest answer that reaches the cap is kept, as it always was; a loop is not
 *   an answer however long it is. Hermes's reply to a length stop is "continue", which pays
 *   again for more of the loop, so that is the one thing this never does.
 *
 * What a response is *about* is not judged here — that is the answer reviewer's business.
 */

export type MalformedKind = "leaked-tool-call" | "degenerate";

export interface MalformedOutput {
  kind: MalformedKind;
  /** For the log: which marker, or how repetitive. */
  detail: string;
}

/**
 * Call markup as models emit it natively. Each needs the structure that follows a marker, not
 * the marker alone, so an answer that mentions `<tool_call>` in a sentence does not trip it —
 * and anything in backticks or a fence is masked out before these run.
 */
const LEAK_PATTERNS: readonly { name: string; pattern: RegExp }[] = [
  { name: "minimax", pattern: /\]<\]minimax\[>\[|<\/?minimax:tool_call>/ },
  { name: "tool_call", pattern: /<tool_call>\s*[{[]/ },
  { name: "function_calls", pattern: /<function_calls>\s*<invoke\b/ },
  { name: "function=", pattern: /^<function=[\w.-]+>/m },
  { name: "special-token", pattern: /<[|｜]tool[_▁]calls?[_▁](?:section[_▁])?begin[|｜]>|<\|tool_call\|>|<\|python_tag\|>/ },
  { name: "TOOL_CALLS", pattern: /\[TOOL_CALLS\]\s*\[/ },
  // Bare call objects, one per line, two or more: the shape that followed the marker here.
  { name: "call-json", pattern: /^\s*\{"name":\s*"[\w.-]+",\s*"(?:arguments|parameters)":.*\n\s*\{"name":\s*"[\w.-]+",\s*"(?:arguments|parameters)":/m },
];

/** Code spans and fences replaced by spaces, so indices still point into the original. */
function maskCode(text: string): string {
  const blank = (match: string) => match.replace(/[^\n]/g, " ");
  return text.replace(/```[\s\S]*?(?:```|$)/g, blank).replace(/`[^`\n]*`/g, blank);
}

/** Where leaked call markup starts, if any: the cut point for a history that already holds one. */
export function leakedToolCall(text: string): { at: number; name: string } | undefined {
  const masked = maskCode(text);
  let found: { at: number; name: string } | undefined;
  for (const { name, pattern } of LEAK_PATTERNS) {
    const match = pattern.exec(masked);
    if (match !== null && (found === undefined || match.index < found.at)) found = { at: match.index, name };
  }
  return found;
}

/** How many of the last lines must there be before repetition is judged at all. */
const REPEAT_WINDOW = 40;
const REPEAT_MIN_LINES = 20;
/** Share of distinct line openings below which the tail is a loop. Prose sits far above. */
const REPEAT_MAX_DISTINCT = 0.3;
const LINE_KEY_CHARS = 24;

/**
 * A loop in the tail. Line openings rather than whole lines, because a runaway list keeps its
 * frame and drifts in its arguments — every line here began `{"name": "web_search", "argum`.
 * A loop with no newlines at all is caught by its last stretch recurring throughout.
 */
function repetition(text: string): string | undefined {
  const lines = text.split("\n").map(line => line.trim()).filter(line => line !== "").slice(-REPEAT_WINDOW);
  if (lines.length >= REPEAT_MIN_LINES) {
    const distinct = new Set(lines.map(line => line.replace(/\s+/g, " ").slice(0, LINE_KEY_CHARS))).size;
    if (distinct / lines.length < REPEAT_MAX_DISTINCT) return `${distinct} distinct openings in the last ${lines.length} lines`;
  }
  const tail = text.trimEnd().slice(-60);
  if (tail.length === 60 && text.split(tail).length - 1 >= 5) return "the last 60 characters recur 5+ times";
  return undefined;
}

/** The gate. `stopReason` is the response's own, before any classification. */
export function malformedOutput(text: string, stopReason: string | null | undefined): MalformedOutput | undefined {
  const leak = leakedToolCall(text);
  if (leak !== undefined) return { kind: "leaked-tool-call", detail: `${leak.name} markup at char ${leak.at}` };
  if (stopReason === "max_tokens") {
    const loop = repetition(text);
    if (loop !== undefined) return { kind: "degenerate", detail: `max_tokens with ${loop}` };
  }
  return undefined;
}

/**
 * The one retry's instruction. Where no tools were offered, the model is told so and given the
 * person's way back, rather than told to use an interface it does not have — which is how the
 * incident started.
 */
export function malformedNudge(kind: MalformedKind, toolsOffered: boolean, chinese: boolean): string {
  if (kind === "degenerate") {
    return chinese
      ? "[harness] 你上一条回复陷入了重复，已被丢弃，对方没有看到。不要重复，也不要接着写：给出一条简短、完整的回答。"
      : "[harness] Your last reply fell into repetition and was discarded; the person did not see it. Do not repeat it or continue it: give one short, complete answer.";
  }
  if (!toolsOffered) {
    return chinese
      ? "[harness] 你上一条回复把工具调用写成了文字，已被丢弃，对方没有看到。这个上下文没有任何工具，文字写出的调用永远不会执行。直接用文字回答你能回答的部分；需要搜索、读文件或看代码的部分，如实说明当前是隔离上下文、无法使用工具，并告诉对方发送 /new 回到正常上下文后即可继续。"
      : "[harness] Your last reply wrote a tool call as text and was discarded; the person did not see it. This context has no tools, and a call written as text is never executed. Answer what you can in words; for anything that needs a search, files or code, say plainly that this is an isolated context without tools, and that sending /new returns to a normal one.";
  }
  return chinese
    ? "[harness] 你上一条回复把工具调用写成了文字，已被丢弃，对方没有看到。文字写出的调用不会执行：要调用工具，就通过工具接口发出调用。"
    : "[harness] Your last reply wrote a tool call as text and was discarded; the person did not see it. Calls written as text are never executed: to use a tool, issue it through the tool interface.";
}

/**
 * A stored reply that already holds leaked markup, cut before it reaches a model again. The
 * record on disk is left alone — it is what makes the incident checkable — but feeding it back
 * teaches the next round that this is how this conversation answers.
 */
export function sanitizeHistoryText(text: string): string {
  const leak = leakedToolCall(text);
  if (leak === undefined) return text;
  const kept = text.slice(0, leak.at).trimEnd();
  return `${kept}${kept === "" ? "" : "\n\n"}[harness: the rest of this reply was a tool call written as text; it never ran and was not an answer]`;
}
