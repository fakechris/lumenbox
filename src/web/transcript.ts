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
import { optionLabel } from "../host/ask-options.ts";

export interface DisplayTool {
  name: string;
  /** The argument that identifies the call, e.g. the command bash ran. */
  detail: string;
  /** Filled in from the matching tool_result, so a call and its outcome stay together. */
  result?: string;
  isError?: boolean;
  /** For AskUser: the question and its answers, so the page can draw the card again on reload. */
  question?: { question: string; options?: string[]; fallback?: string };
}

/**
 * What started this turn, when it was not a person typing.
 *
 * The harness opens turns with a bracketed cue as the first token — `[webhook]`, `[scheduled]`,
 * `[first run]`, `[resumed]`, `[system]`. `fromPerson` on the entry is the authority where it
 * exists; the cue is the fallback for turns recorded before that field did.
 */
export function triggerOf(text: string, fromPerson: boolean): string | undefined {
  if (fromPerson) return undefined;
  const cue = /^\[([a-z][a-z ]{2,20})\]/.exec(text.trimStart());
  if (cue === null) return undefined;
  const label = cue[1]!.trim();
  const known: Record<string, string> = {
    webhook: "started by a webhook",
    scheduled: "started by a timer",
    "first run": "first run",
    resumed: "picked up after a restart",
    system: "system",
    "template setup": "setting itself up",
  };
  return known[label] ?? `started by ${label}`;
}

/** The question an AskUser call carried, in the shape the page draws. */
export function questionOf(input: unknown): { question: string; options?: string[]; fallback?: string } | undefined {
  const args = (input ?? {}) as { question?: unknown; options?: unknown; default?: unknown };
  const question = typeof args.question === "string" ? args.question.trim() : "";
  if (question === "") return undefined;
  const options = Array.isArray(args.options)
    ? args.options.map(optionLabel).filter((option): option is string => option !== undefined)
    : [];
  const fallback = typeof args.default === "string" && args.default.trim() !== "" ? args.default.trim() : undefined;
  return {
    question,
    ...(options.length > 0 ? { options } : {}),
    ...(fallback !== undefined ? { fallback } : {}),
  };
}


/** The entry's own time, when the transcript kept one. */
function stamp(raw: unknown): { at?: string } {
  const at = (raw as { at?: unknown }).at;
  return typeof at === "string" && at !== "" ? { at } : {};
}

export type DisplayEntry =
  | {
      kind: "text";
      role: "user" | "assistant";
      text: string;
      /**
       * Prose that came in the same turn as tool calls: running commentary, not the
       * answer. Known here by construction — a `blocks` entry is by definition a round
       * that went on to call something — so a reload renders the same distinction the
       * live stream draws when a `tool_start` follows an open message.
       */
      aside?: true;
      /** When it was said, from the transcript; absent on entries written before it was kept. */
      at?: string;
    }
  /** A turn a teammate started: the messages, without the scaffolding around them. */
  | { kind: "peer"; messages: WakeMessage[] }
  /**
   * A turn nobody typed: a webhook fired, a timer came round, the process restarted.
   *
   * Stored with role "user" because that is what opens a turn, and drawn as the person's own
   * words until now — so a webhook's brief appeared in the chat as something Chris had said.
   * Harmless while both sides looked alike; glaring the moment the person's messages became a
   * filled bubble (docs/46), which is the usual way a display bug is finally seen.
   */
  | { kind: "trigger"; label: string; text: string; at?: string }
  | { kind: "tools"; tools: DisplayTool[] };

export interface RosterEntry {
  id: string;
  name: string;
}

/** What the live view shows for a tool call: the argument that identifies the call. */
function toolDetail(name: string, input: unknown, roster: readonly RosterEntry[]): string {
  const args = (input ?? {}) as Record<string, unknown>;

  if (name === "bash") return String(args.command ?? "");
  if (name === "SendToAgent") {
    // Named, not an id: this row is the sender's record of messaging a teammate, and
    // a uuid tells the reader nothing about who that was.
    const target = roster.find(entry => entry.id === String(args.target_id ?? ""));
    const to = target ? target.name : String(args.target_id ?? "someone");
    return `${to}: ${String(args.text ?? "")}`;
  }
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
  roster: readonly RosterEntry[]
): DisplayEntry[] {
  const display: DisplayEntry[] = [];
  const knownNames = roster.map(entry => entry.name);
  /** The ids of the calls in the entry just pushed, so results can be matched to it. */
  let awaiting: { entry: { tools: DisplayTool[] }; ids: string[] } | undefined;

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
      if (text) display.push({ kind: "text", role: "assistant", text, aside: true, ...stamp(raw) });

      const calls = blocks.filter(block => block.type === "tool_use");
      const tools: DisplayTool[] = calls.map(block => ({
        name: String(block.name ?? "tool"),
        detail: toolDetail(String(block.name ?? ""), block.input, roster),
        ...(block.name === "AskUser" && questionOf(block.input) !== undefined
          ? { question: questionOf(block.input)! }
          : {}),
      }));
      if (tools.length > 0) {
        const entryWithTools = { kind: "tools" as const, tools };
        display.push(entryWithTools);
        awaiting = {
          entry: entryWithTools,
          ids: calls.map(block => String(block.id ?? "")),
        };
      }
      continue;
    }

    if (entry.kind === "results") {
      // Folded into the call it answers rather than shown as its own row: a call and
      // its outcome are one thing to a reader, and one collapsed row to the page.
      for (const block of blocks) {
        const at = awaiting?.ids.indexOf(String(block.tool_use_id ?? "")) ?? -1;
        const tool = at >= 0 ? awaiting!.entry.tools[at] : undefined;
        if (!tool) continue;
        tool.result = resultText(block);
        tool.isError = block.is_error === true;
      }
      awaiting = undefined;
      continue;
    }

    const text = typeof entry.text === "string" ? entry.text : "";
    if (!text.trim()) continue;

    if (entry.role === "user") {
      const peers = parseWakePrompt(text, knownNames);
      if (peers) { display.push({ kind: "peer", messages: peers }); continue; }
      const trigger = triggerOf(text, (raw as { fromPerson?: boolean }).fromPerson === true);
      if (trigger !== undefined) {
        display.push({ kind: "trigger", label: trigger, text, ...stamp(raw) });
        continue;
      }
      display.push({ kind: "text", role: "user", text, ...stamp(raw) });
      continue;
    }

    display.push({ kind: "text", role: "assistant", text, ...stamp(raw) });
  }

  return display;
}
