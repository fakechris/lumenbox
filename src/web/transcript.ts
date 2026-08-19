/**
 * Turns a stored transcript into something a person can read.
 *
 * The transcript is written for the model: turn prompts carry the orchestrator's
 * scaffolding, and tool traffic is stored as raw content blocks — which is the point,
 * since blocks are what make an agent's claim of work checkable. None of it is a
 * conversation, and the UI showed it as one: wake prompts appeared as if the user had
 * typed them, and every tool round became an empty bubble because a blocks entry has
 * no text field.
 *
 * The mapping happens here rather than in the page because it is a real parse of a
 * real format, and doing it in the browser puts it out of reach of the tests.
 */

import { parseWakePrompt, type WakeMessage } from "../host/prompt.ts";

export type DisplayEntry =
  | { kind: "text"; role: "user" | "assistant"; text: string }
  /** A turn a teammate started: the messages, without the scaffolding around them. */
  | { kind: "peer"; messages: WakeMessage[] }
  | { kind: "tools"; tools: { name: string; detail: string }[] }
  | { kind: "results"; results: { text: string; isError: boolean }[] };

/** What the live view shows for a tool call: the argument that identifies the call. */
function toolDetail(name: string, input: unknown): string {
  const args = (input ?? {}) as Record<string, unknown>;

  if (name === "bash") return String(args.command ?? "");
  if (name === "SendToAgent") return String(args.text ?? "");
  if (name === "computer") {
    const actions = Array.isArray(args.actions) ? args.actions : [];
    return actions
      .map(action => String((action as { action?: unknown }).action ?? ""))
      .join(" + ");
  }

  const values = Object.values(args).map(value => String(value));
  return values.length > 0 ? values[0]! : "";
}

function resultText(block: Record<string, unknown>): string {
  const content = block.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .filter(part => (part as { type?: unknown }).type === "text")
    .map(part => String((part as { text?: unknown }).text ?? ""))
    .join("\n");
}

export function toDisplayEntries(
  entries: readonly unknown[],
  knownNames: readonly string[]
): DisplayEntry[] {
  const display: DisplayEntry[] = [];

  for (const raw of entries) {
    const entry = (raw ?? {}) as Record<string, unknown>;
    const blocks = Array.isArray(entry.blocks)
      ? (entry.blocks as Record<string, unknown>[])
      : [];

    if (entry.kind === "blocks") {
      // An assistant turn that called tools: its prose first, then the calls.
      const text = blocks
        .filter(block => block.type === "text")
        .map(block => String(block.text ?? ""))
        .join("")
        .trim();
      if (text) display.push({ kind: "text", role: "assistant", text });

      const tools = blocks
        .filter(block => block.type === "tool_use")
        .map(block => ({
          name: String(block.name ?? "tool"),
          detail: toolDetail(String(block.name ?? ""), block.input),
        }));
      if (tools.length > 0) display.push({ kind: "tools", tools });
      continue;
    }

    if (entry.kind === "results") {
      const results = blocks.map(block => ({
        text: resultText(block),
        isError: block.is_error === true,
      }));
      if (results.length > 0) display.push({ kind: "results", results });
      continue;
    }

    const text = typeof entry.text === "string" ? entry.text : "";
    if (!text.trim()) continue;

    if (entry.role === "user") {
      const peers = parseWakePrompt(text, knownNames);
      if (peers) display.push({ kind: "peer", messages: peers });
      else display.push({ kind: "text", role: "user", text });
      continue;
    }

    display.push({ kind: "text", role: "assistant", text });
  }

  return display;
}
