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
import { type SurfaceDraw, surfaceDrawOf } from "../host/show-ui-catalog.ts";
import { type EditDiff, editDiffOf } from "./line-diff.ts";
import type { GateVerdict } from "../host/gate-verdict.ts";
import { entryChannel } from "../host/model-text.ts";
import { BUDGET_REPORT } from "../host/turn-budget.ts";
import type { HeardRow } from "../agents/heard-record.ts";
import { activityPhrases } from "../host/activity-phrase.ts";
import type { HistoryEntry } from "../host/compaction.ts";

export interface DisplayTool {
  turnId?: string;
  executionId?: string;
  attempt?: number;
  toolUseId?: string;
  name: string;
  /** What the step was, in words a person reads (activity-phrase.ts), in both languages: the page picks its own. */
  phrase?: { en: string; zh: string };
  /** The argument that identifies the call, e.g. the command bash ran. */
  detail: string;
  /** Filled in from the matching tool_result, so a call and its outcome stay together. */
  result?: string;
  isError?: boolean;
  /** For AskUser: the question and its answers, so the page can draw the card again on reload. */
  question?: { question: string; options?: string[]; fallback?: string };
  /** For ShowUI: the card as A2UI messages, so the page can draw it again on reload (docs/79). */
  surface?: SurfaceDraw;
  /** For edit_file: what changed, as `-`/`+` lines, so the row reads as a diff rather than two paragraphs (INV-112). */
  diff?: EditDiff;
  /** The policy gate's verdict on this step and why (INV-1664), joined from its ledger by the call's id. */
  gate?: GateVerdict;
}

/**
 * What started this turn, when it was not a person typing.
 *
 * The harness opens turns with a bracketed cue as the first token — `[webhook]`, `[scheduled]`,
 * `[first run]`, `[resumed]`, `[system]`. `fromPerson` on the entry is the authority where it
 * exists; the cue is the fallback for turns recorded before that field did.
 */
export function triggerOf(text: string, fromPerson: boolean): string | undefined {
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
  // The known cues are the harness's own vocabulary and win outright: nobody types
  // "[webhook] This turn was started by something calling this routine's URL". They have to
  // win, because turns recorded before the synthetic flag existed are stored as though a
  // person had opened them. Any other bracketed word is only a cue when nobody typed it.
  if (known[label] !== undefined) return known[label];
  return fromPerson ? undefined : `started by ${label}`;
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
function stamp(raw: unknown): { at?: string; turnId?: string; executionId?: string; textThrough?: number; causedBy?: string[] } {
  const entry = raw as { at?: unknown; turnId?: unknown; executionId?: unknown; textThrough?: unknown; causedBy?: unknown };
  return { ...(Array.isArray(entry.causedBy) ? { causedBy: entry.causedBy.filter((id): id is string => typeof id === "string") } : {}),
    ...(typeof entry.at === "string" && entry.at ? { at: entry.at } : {}),
    ...(typeof entry.turnId === "string" ? { turnId: entry.turnId } : {}),
    ...(typeof entry.executionId === "string" ? { executionId: entry.executionId } : {}),
    ...(typeof entry.textThrough === "number" ? { textThrough: entry.textThrough } : {}) };
}

export type DisplayEntry = (
  /** Something a chat door sent that the transcript does not hold: a notice, a card, a file (sent-in-thread.ts). */
  | { kind: "sent"; what: "text" | "image" | "file" | "card"; door: string; at: string; card?: string; text?: string; name?: string }
  | {
      kind: "text";
      role: "user" | "assistant"; provenance?: "unknown";
      text: string;
      /**
       * Prose that came in the same turn as tool calls: running commentary, not the
       * answer. Known here by construction — a `blocks` entry is by definition a round
       * that went on to call something — so a reload renders the same distinction the
       * live stream draws when a `tool_start` follows an open message.
       */
      aside?: true;
      /** Said to the person while the tools ran: the turn's opening line, a message in its own right. */
      opening?: true;
      /** When it was said, from the transcript; absent on entries written before it was kept. */
      at?: string;
      turnId?: string; executionId?: string; textThrough?: number; causedBy?: string[];
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
  | { kind: "trigger"; provenance?: "host" | "unknown"; label: string; text: string; at?: string; /** On the line that leads a shortened thread: how many entries came before it (INV-1624). */ skipped?: number }
  | { kind: "tools"; tools: DisplayTool[] }
  /** Something the host wrote in the agent's place when a turn ended early: a state of the turn, not something the agent said. */
  | { kind: "status"; what: "stopped" | "budget"; text: string; at?: string }
  /** Turns nobody asked for in this conversation, folded to a count (request-thread.ts). `first`/`last` index the unfolded entries. */
  | { kind: "background"; turns: number; steps: number; first: number; last: number; from?: string; to?: string }
) & {
  /** Part of a turn that no person's request opened: an audit the host dispatched, and what followed from it. */
  background?: true;
};

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

  const first = Object.values(args)[0];
  return first === undefined ? "" : readable(first);
}

/** An argument as a person can read it: a list of things with names is their names, never "[object Object]". */
function readable(value: unknown): string {
  if (typeof value !== "object" || value === null) return String(value);
  const named = (item: Record<string, unknown>) => String(item.text ?? item.title ?? item.name ?? JSON.stringify(item));
  if (Array.isArray(value)) return value.map(item => typeof item === "object" && item !== null ? named(item as Record<string, unknown>) : String(item)).join(" · ");
  return JSON.stringify(value);
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

/** How the host's audit request opens, stamped or not (audit.ts buildAuditPrompt). */
const AUDIT_DISPATCH = /^(\[from the host \(host:audit\)[^\]]*\]\s*)?Audit task t\d+:|^\[from the host \(host:audit\)/;

export function toDisplayEntries(
  entries: readonly unknown[],
  roster: readonly RosterEntry[],
  /** The gate's verdict for a call by its tool_use id, when the gate kept one (INV-1664). */
  verdictOf: (callId: string) => GateVerdict | undefined = () => undefined,
  /** The conversation is a chat's: what is filed as said there, and is not the host's or a cue, came through the door from a person. */
  fromChat = false,
  /** What the host knew about a message when the agent started on it (heard-record.ts): where it has a row, it decides. */
  heardOf: (messageId: string) => HeardRow | undefined = () => undefined
): DisplayEntry[] {
  const display: DisplayEntry[] = [];
  const knownNames = roster.map(entry => entry.name);
  /** The ids of the calls in the entry just pushed, so results can be matched to it. */
  let awaiting: { entry: { tools: DisplayTool[] }; ids: string[] } | undefined;
  /** A person opened the turn being read and has not been shown anything of it yet. */
  let owedOpening = false;
  /**
   * Whether what is being read belongs to no request made in this conversation. A person speaking, or a routine a
   * person set, opens a request. The host's audit dispatch never does. A teammate's message belongs to the request
   * only when the agent had asked that teammate something while working on it, and a job notice only when the job
   * was started while working on it: both are as often the tail of a request as noise from elsewhere, and the
   * record says which. The host's other notes arrive inside a turn and continue whatever it is.
   */
  let background = false;
  /** Teammates the agent wrote to, and jobs it started, while working on the request now open. */
  const asked = new Set<string>(), started = new Set<string>();
  const JOB_ID = /\bjob-[0-9a-f]{6,}\b/g;
  const push = (entry: DisplayEntry) => { display.push(background ? { ...entry, background: true } : entry); };

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
      const calls = blocks.filter(block => block.type === "tool_use");
      if (!background) for (const call of calls) {
        const input = (call.input ?? {}) as Record<string, unknown>;
        const mate = input.target_id ?? input.agent ?? input.to;
        if ((call.name === "SendToAgent" || call.name === "Delegate") && typeof mate === "string") { asked.add(mate); asked.add(roster.find(entry => entry.id === mate)?.name ?? mate); }
      }
      // The first thing an agent says beside its calls in a turn a person opened went to that person while the
      // tools ran (turn.ts, the opening line) — in a chat it is a message they received. It is what was said,
      // not commentary: measured on 2026-11-13, 29 of 246 chat requests had their longest answer drawn as nothing.
      const told = entry.told === true || (owedOpening && calls.length > 0 && entry.silent === undefined);
      if (text && told) owedOpening = false;
      if (text) push({ kind: "text", role: "assistant", text, ...(told ? { opening: true as const } : { aside: true as const }), ...stamp(raw) });

      const tools: DisplayTool[] = calls.map(block => ({
        ...(typeof entry.turnId === "string" && typeof block.id === "string" ? { turnId: entry.turnId, toolUseId: block.id, ...(typeof entry.executionId === "string" ? { executionId: entry.executionId } : {}), ...(typeof entry.attempt === "number" ? { attempt: entry.attempt } : {}) } : {}),
        name: String(block.name ?? "tool"), phrase: activityPhrases(String(block.name ?? "tool"), block.input),
        detail: toolDetail(String(block.name ?? ""), block.input, roster),
        ...(block.name === "AskUser" && questionOf(block.input) !== undefined
          ? { question: questionOf(block.input)! }
          : {}),
        ...(block.name === "ShowUI" && surfaceDrawOf(block.input) !== undefined
          ? { surface: surfaceDrawOf(block.input)! }
          : {}),
        ...(editDiffOf(String(block.name ?? ""), block.input) !== undefined ? { diff: editDiffOf(String(block.name ?? ""), block.input)! } : {}),
        ...(verdictOf(String(block.id ?? "")) !== undefined ? { gate: verdictOf(String(block.id ?? ""))! } : {}),
      }));
      if (tools.length > 0) {
        const entryWithTools = { kind: "tools" as const, tools };
        push(entryWithTools);
        awaiting = {
          entry: display.at(-1) as typeof entryWithTools,
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
        if (!background) for (const job of resultText(block).match(JOB_ID) ?? []) started.add(job);
        tool.result = resultText(block);
        tool.isError = block.is_error === true;
      }
      awaiting = undefined;
      continue;
    }

    const text = typeof entry.text === "string" ? entry.text : "";
    if (!text.trim()) continue;

    // A handoff that opened this context (INV-1190): host context, not the person speaking.
    // Folded like any other harness cue, so the page shows a quiet row that opens to the note.
    if (entry.kind === "summary" && typeof entry.handoff === "object" && entry.handoff !== null) {
      const lost = (entry.handoff as { lost?: unknown }).lost === true;
      push({ kind: "trigger", label: lost ? "handoff lost in the switch" : "carried over from the previous context", text, ...stamp(raw) });
      continue;
    }

    // What the host kept of an older stretch when it shortened the context: its own digest, filed
    // under the user role because that is where the model reads it. Never the person speaking.
    if (entry.kind === "summary") {
      push({ kind: "trigger", label: "summary of the earlier conversation", provenance: "host", text, ...stamp(raw) });
      continue;
    }

    const heard = entry.role === "user" && Array.isArray(entry.causedBy) ? (entry.causedBy as string[]).map(heardOf).filter((row): row is HeardRow => row !== undefined) : [];
    if (heard.length > 0) {
      // Who said it, as the host knew when the agent started on it (INV-1845): nothing here is read off the text.
      const by = (kind: string) => heard.some(row => row.speaker.by === kind);
      owedOpening = false;
      if (by("person")) {
        owedOpening = true; background = false; asked.clear();
        push({ kind: "text", role: "user", text, ...stamp(raw) });
      } else if (by("teammate")) {
        background = !heard.some(row => row.asked);
        push({ kind: "peer", messages: parseWakePrompt(text, knownNames) ?? heard.flatMap(row => row.speaker.by === "teammate" ? [{ from: row.speaker.from, priority: false, text }] : []) });
      } else {
        // A routine a person set opens a request; the host's own notes belong to one only when it stood behind them.
        background = by("routine") ? false : !heard.some(row => row.asked);
        push({ kind: "trigger", label: by("routine") ? triggerOf(text, false) ?? "started by a routine" : "System context", provenance: "host", text, ...stamp(raw) });
      }
      continue;
    }

    if (entry.role === "user") {
      // The flag where the entry has one; else the host's own openings, by the one table that
      // names them (model-text.ts), so a notice recorded before the flag is not shown as typed.
      const host = (raw as { host?: boolean }).host === true || entryChannel(raw as HistoryEntry) === "host", person = (raw as { fromPerson?: boolean }).fromPerson === true && !host;
      const peers = person ? undefined : parseWakePrompt(text, knownNames);
      if (peers) { owedOpening = false; background = !peers.some(message => asked.has(message.from)); push({ kind: "peer", messages: peers }); continue; }
      const trigger = host ? "System context" : triggerOf(text, person);
      if (trigger !== undefined) {
        // A teammate's message whose sender cannot be read (it left the roster) cannot be tied to a request either.
        if (AUDIT_DISPATCH.test(text) || text.startsWith("[agent]")) background = true;
        else if (/^\[(A command you started earlier|\d+ commands you started earlier)/.test(text)) background = !(text.match(JOB_ID) ?? []).some(job => started.has(job));
        else if (!host && triggerOf(text, person) !== undefined && !/^\[(resumed|system)\]/.test(text.trimStart())) background = false; // a routine, a webhook, a first run: a person set those
        owedOpening = false; // the host opened this one: its prose beside the calls goes to nobody
        push({ kind: "trigger", label: trigger, provenance: host ? "host" : "unknown", text, ...stamp(raw) });
        continue;
      }
      owedOpening = true; background = false; asked.clear();
      push({ kind: "text", role: "user", ...(!person && !fromChat ? { provenance: "unknown" as const } : {}), text, ...stamp(raw) });
      continue;
    }

    // Written by the host in the agent's place when the turn was cut short: said as a state, not as its words.
    const ended = /^A person stopped this turn\./.test(text) ? "stopped" as const : BUDGET_REPORT.test(text) ? "budget" as const : undefined;
    if (ended !== undefined) { push({ kind: "status", what: ended, text, ...stamp(raw) }); continue; }
    push({ kind: "text", role: "assistant", text, ...stamp(raw) });
  }

  return display;
}

/**
 * How much of a conversation the chat draws when it opens (INV-1624). The page renders every
 * entry it is sent, synchronously; on 2026-11-05 Vic's main chat was 13,943 entries (24 MB)
 * and opening it froze the window at 1.3 GB and full CPU, so a click on an approval never left
 * the page. The newest entries are what a person opens a chat to see; the rest stay on the
 * record and in History.
 */
export const DISPLAY_TAIL = 400;

/** The newest `limit` entries, led by one line saying how many earlier ones were left out. */
export function latestForDisplay(display: readonly DisplayEntry[], limit = DISPLAY_TAIL): DisplayEntry[] {
  if (display.length <= limit) return [...display];
  const left = display.length - limit;
  const tail = display.slice(left);
  const at = tail.find(entry => "at" in entry && typeof entry.at === "string") as { at?: string } | undefined;
  return [
    { kind: "trigger", label: "Earlier", skipped: left, text: `${left.toLocaleString("en-US")} earlier entries are not shown here, so the chat stays responsive. They are still on the record, and the agent's History tool reaches them.`, ...(at?.at !== undefined ? { at: at.at } : {}) },
    ...tail,
  ];
}
