/**
 * Tell (INV-1853): a member says one thing to the person in the middle of a turn and keeps working.
 *
 * A long turn in a chat showed three things: the opening line, a progress card, the reply. Between
 * them there was no way to say "the March figures are wrong at the source", to hand over a file that
 * is already finished, or to say the plan changed. Plain text is still the reply, and stays visible
 * as it is written; this is the one outward door beside it.
 *
 * It goes where this turn's person is: the page, and — for a turn that came from a chat — that chat,
 * as an ordinary message through the same push every host message takes (`tryPushToChat`), with its
 * files leaving through the chat's outbox like any other file. Nothing here is a second delivery path.
 *
 * Whether a Tell may go is decided in one function, `admitTell`. What is delivered is recorded where
 * the conversation is read from (the heard record) and on the work it belongs to; it is never the
 * reply, never a filed answer, and no evidence that anything was finished.
 */

import { MAIN_CONVERSATION } from "../agents/registry.ts";
import { outcomeLine } from "../protocol/index.ts";
import { workDir } from "./box-paths.ts";
import { checkDeliverable } from "./deliverables.ts";
import { chatFilesRoot } from "./prompt.ts";
import type { PushBudget } from "./push-budget.ts";
import { DELIVERABLE_LIMIT_BYTES, readSnapshot } from "./task-deliverables.ts";
import type { ToolContext, ToolOutcome } from "./tools.ts";
import type { TurnEvent } from "./turn-events.ts";

export const TELL = "Tell";

/** What a turn hands the tool, as part of `ToolContext`. */
export interface TellContext {
  /** Says one thing to the person mid-turn. Absent: nobody is reachable, and the tool says so. */
  tell?: Pick<Teller, "tell">;
  /** A person started this turn and is waiting on it; false for a wake nobody is watching. Decides whether a Tell spends the daily allowance. */
  personWaiting?: boolean;
}
/** Tells in one turn. Past this the turn is narrating, and the rest belongs in the reply. */
export const TELLS_PER_TURN = 3;
/** Minutes between two Tells of one turn, unless the installation sets another. */
export const TELL_GAP_MINUTES = 2;
export const TELL_MAX_CHARS = 4_000;
export const TELL_MAX_FILES = 4;

/** A file a Tell carries: where the page can fetch it from, a path in the box or a task's kept deliverable. */
export interface TellFile {
  name: string;
  path?: string;
  deliverable?: { task: string; id: string };
}

/** What this turn has put to the person that they have not answered. */
export type Awaiting = "AskUser" | "ShowUI";

export interface TellSituation {
  /** Tells this turn has already made. */
  told: number;
  /** When the last of them went, in ms. */
  lastAt?: number;
  now: number;
  gapMs: number;
  awaiting?: Awaiting;
  /** A person started this turn and is waiting on it. */
  waited: boolean;
  /** Unprompted messages the member has left today; undefined where nothing counts them. */
  pushesLeft?: number;
}

export type TellVerdict = { allow: true; counted: boolean } | { allow: false; reason: string };

/**
 * Whether a Tell may go now — the one place that decides, read top to bottom in the order a member
 * most needs to hear. A turn a person started and is waiting on spends none of the daily allowance
 * (INV-1576); every other turn does. A rule about *when* to speak is added here, as one more input.
 */
export function admitTell(situation: TellSituation): TellVerdict {
  if (situation.awaiting !== undefined) {
    const asked = situation.awaiting === "AskUser" ? "asked the person a question" : "showed the person a card with a choice on it";
    return { allow: false, reason: `you ${asked} this turn and they have not answered. Nothing more goes to them until they do; keep it for your reply` };
  }
  if (situation.told >= TELLS_PER_TURN) return { allow: false, reason: `this turn has already told the person ${TELLS_PER_TURN} things, which is the most one turn may. Put the rest in your reply` };
  const since = situation.lastAt === undefined ? undefined : situation.now - situation.lastAt;
  if (since !== undefined && since < situation.gapMs) {
    const minutes = Math.round(situation.gapMs / 6_000) / 10, left = Math.max(1, Math.ceil((situation.gapMs - since) / 1_000));
    return { allow: false, reason: `the last Tell went ${Math.floor(since / 1_000)}s ago and two are at least ${minutes} min apart. Keep working; say it in ${left}s if it still matters, or in your reply` };
  }
  if (!situation.waited && situation.pushesLeft !== undefined && situation.pushesLeft <= 0) {
    return { allow: false, reason: "nobody is waiting on this turn and today's allowance of unprompted messages is used. Put it in your reply, which goes out with the daily digest" };
  }
  return { allow: true, counted: !situation.waited };
}

export interface TellRequest {
  agentId: string;
  agentName: string;
  conversation: string;
  turnId?: string;
  /** The tool call, so two Tells with the same words are two messages. */
  callId?: string;
  text: string;
  waited: boolean;
  awaiting?: Awaiting;
  /** Reads and checks the files, once the Tell is admitted. A string is why one of them cannot go. */
  attach?: () => Promise<TellAttachments | string>;
}

export interface TellAttachments {
  files: TellFile[];
  /** Puts them in the chat's outbox, where a chat's files leave from. */
  stage: () => Promise<void>;
  /** The ones still in the outbox afterwards: not sent. */
  left: () => Promise<string[]>;
}

export type TellOutcome =
  | { delivered: true; where: string; text: string; files: TellFile[]; unsent: string[] }
  | { delivered: false; why: string };

export interface TellerDeps {
  /** What members may push unprompted in a day (INV-1576). Absent: nothing is counted. */
  budget?: Pick<PushBudget, "admit" | "counts">;
  gapMinutes?: number;
  now?: () => number;
  /** Held values never leave in words a person reads (INV-1360). */
  redact?: (text: string) => string;
  /** The chat a conversation came from; undefined for the page's own conversations. */
  chatOf: (conversation: string) => string | undefined;
  /** An ordinary message into a chat, its outbox files following. */
  toChat?: (chatKey: string, text: string, about: string) => Promise<{ delivered: boolean; why?: string }>;
  /** The page, live. */
  toPage: (event: TurnEvent) => void;
}

/** Decides and delivers. One per host: it remembers what each running turn has told. */
export class Teller {
  private readonly turns = new Map<string, { told: number; lastAt?: number }>();

  constructor(private readonly deps: TellerDeps) {}

  async tell(request: TellRequest): Promise<TellOutcome> {
    const now = this.deps.now?.() ?? Date.now();
    const key = request.turnId ?? `${request.agentId}/${request.conversation}`;
    const before = this.turns.get(key) ?? { told: 0 };
    const counts = this.deps.budget?.counts(request.agentId);
    const verdict = admitTell({
      told: before.told, ...(before.lastAt !== undefined ? { lastAt: before.lastAt } : {}), now,
      gapMs: (this.deps.gapMinutes ?? TELL_GAP_MINUTES) * 60_000, waited: request.waited,
      ...(request.awaiting !== undefined ? { awaiting: request.awaiting } : {}),
      ...(counts !== undefined ? { pushesLeft: counts.perDay - counts.sent } : {}),
    });
    if (!verdict.allow) return { delivered: false, why: verdict.reason };
    // Taken before anything is awaited, so two Tells in one batch cannot both be the third.
    this.turns.delete(key);
    this.turns.set(key, { told: before.told + 1, lastAt: now });
    while (this.turns.size > 500) this.turns.delete(this.turns.keys().next().value!);
    const back = (why: string): TellOutcome => { this.turns.set(key, before); return { delivered: false, why }; };

    const attached = await request.attach?.();
    if (typeof attached === "string") return back(attached);
    const text = this.deps.redact?.(request.text) ?? request.text;
    const chatKey = this.deps.chatOf(request.conversation);
    let where = "in the app";
    if (chatKey !== undefined) {
      if (this.deps.toChat === undefined) return back("no chat door is running to carry it");
      try {
        await attached?.stage();
      } catch (error) {
        return back(`the files could not be put in this chat's outbox (${error instanceof Error ? error.message : String(error)})`);
      }
      const sent = await this.deps.toChat(chatKey, text, `tell ${request.callId ?? `${key}#${before.told + 1}`}`);
      if (!sent.delivered) return back(sent.why ?? "the chat did not take it");
      where = `in the ${chatKey.split(":")[0]} chat`;
    }
    const unsent = chatKey === undefined || attached === undefined ? [] : await attached.left();
    const files = attached?.files ?? [];
    const event = { type: "told" as const, agentId: request.agentId, agentName: request.agentName, conversation: request.conversation, text };
    this.deps.toPage({ ...event, ...(files.length > 0 ? { files } : {}), ...(request.turnId !== undefined ? { turnId: request.turnId } : {}) });
    // Counted only once it reached somebody: a push that failed is not attention anybody spent (INV-530).
    if (verdict.counted) this.deps.budget?.admit({ agentId: request.agentId, chatKey: chatKey ?? `app:${request.conversation}`, text });
    return { delivered: true, where, text, files, unsent };
  }
}

export function withTellTool(tools: { name: string; input_schema: unknown }[]): void {
  tools.push({
    name: TELL,
    description:
      "Tell the person one thing now and keep working: a finding, a file, a changed plan. It reaches them where they are, " +
      `at once. Not for narrating steps, and not the reply — that is still your final text. At most ${TELLS_PER_TURN} a turn.`,
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "What they should know, in words that stand alone." },
        files: { type: "array", items: { type: "string" }, description: "Files to attach: paths in your box, or a deliverable's id." },
      },
      required: ["text"],
    },
  } as never);
}

/** Whether a ShowUI call put a choice in front of the person: a card with something to press. */
function offersChoice(input: unknown): boolean {
  const card = (input ?? {}) as { close?: unknown; components?: unknown };
  return card.close !== true && /"action"\s*:/.test(JSON.stringify(card.components ?? null));
}

/**
 * What this turn has put to the person that is still open, read from the transcript: its calls are on
 * disk before they run (INV-774). A question in the same batch as the Tell counts as asked; one that
 * was refused does not; anything the person has said since closes it.
 */
export function awaitingAnswer(context: Pick<ToolContext, "registry" | "agent" | "conversation" | "turnId" | "toolUseId">): Awaiting | undefined {
  if (context.turnId === undefined) return undefined;
  type Entry = { role?: string; kind?: string; turnId?: string; fromPerson?: boolean; blocks?: { type?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; is_error?: boolean }[] };
  let entries: Entry[];
  try {
    entries = context.registry.readTranscript(context.agent.id, context.conversation ?? MAIN_CONVERSATION) as Entry[];
  } catch {
    return undefined;
  }
  const refused = new Set<string>();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] ?? {};
    if (typeof entry.turnId === "string" && entry.turnId !== context.turnId) break;
    if (entry.kind === "results") {
      for (const block of entry.blocks ?? []) if (block.is_error === true && typeof block.tool_use_id === "string") refused.add(block.tool_use_id);
      continue;
    }
    if (entry.role === "user" && entry.fromPerson === true) return undefined;
    if (entry.kind !== "blocks") continue;
    for (const block of entry.blocks ?? []) {
      if (block.type !== "tool_use" || block.id === context.toolUseId || refused.has(block.id ?? "")) continue;
      if (block.name === "AskUser") return "AskUser";
      if (block.name === "ShowUI" && offersChoice(block.input)) return "ShowUI";
    }
  }
  return undefined;
}

/** The files a Tell names, read and held to the rules a deliverable is: under the work directory, within the cap, openable. */
async function attachments(context: ToolContext, named: readonly string[], conversation: string): Promise<TellAttachments | string> {
  const box = context.box;
  if (box === undefined) return "there is no box to take a file from";
  const place = { kind: context.boxKind, workDir: context.boxWorkDir }, work = workDir(place);
  const loaded: { file: TellFile; bytes: Buffer }[] = [];
  for (const entry of named) {
    let file: TellFile, bytes: Buffer;
    if (entry.startsWith("/")) {
      if (!entry.startsWith(`${work}/`) || entry.split("/").includes("..")) return `${entry} is not a file under ${work}/`;
      try {
        const got = await box.downloadFile(entry);
        if (got.size > DELIVERABLE_LIMIT_BYTES) return `${entry} is ${got.size} bytes, past the 25MB limit; split or compress it`;
        bytes = Buffer.from(got.base64, "base64");
      } catch (error) {
        return `${entry} could not be read (${error instanceof Error ? error.message : String(error)})`;
      }
      file = { name: entry.split("/").pop()!, path: entry };
    } else {
      const board = context.tasks, task = board?.get(context.taskBinding?.taskId ?? "");
      const item = task?.deliverables?.find(delivered => delivered.id === entry || delivered.name === entry);
      const kept = item === undefined || task === undefined || board?.path == null ? undefined : readSnapshot(board.path, task.id, item);
      if (item === undefined || task === undefined || kept === undefined) return `${entry} is neither a path under ${work}/ nor a deliverable of the task this turn is on`;
      file = { name: item.name, deliverable: { task: task.id, id: item.id } };
      bytes = kept;
    }
    if (bytes.length > DELIVERABLE_LIMIT_BYTES) return `${file.name} is past the 25MB limit; split or compress it`;
    const broken = checkDeliverable(file.name, bytes).filter(problem => problem.severity === "broken");
    if (broken.length > 0) return `${file.name} cannot be opened as its name says: ${broken.map(problem => problem.detail).join("; ")}. Regenerate it in the real format first`;
    loaded.push({ file, bytes });
  }
  const outbox = `${chatFilesRoot(conversation, place)}/outbox`;
  return {
    files: loaded.map(item => item.file),
    stage: async () => {
      await box.exec(`mkdir -p '${outbox.replace(/'/g, `'\\''`)}'`, { actor: "host:tell" });
      for (const { file, bytes } of loaded) if (file.path?.startsWith(`${outbox}/`) !== true) await box.uploadFile(`${outbox}/${file.name}`, bytes.toString("base64"));
    },
    left: async () => {
      try {
        const there = new Set((await box.listDir(outbox)).entries.map(entry => entry.name));
        return loaded.map(item => item.file.name).filter(name => there.has(name));
      } catch {
        return [];
      }
    },
  };
}

export async function tellTool(context: ToolContext, input: Record<string, unknown>): Promise<ToolOutcome> {
  const refused = (reason: string): ToolOutcome => ({ text: outcomeLine("refused", `not told: ${reason}`), isError: true });
  const text = String(input.text ?? "").trim();
  if (text === "") return refused("`text` says what the person should know");
  if (text.length > TELL_MAX_CHARS) return refused(`that is ${text.length} characters; a Tell is one thing, under ${TELL_MAX_CHARS}. The long version is a file, or your reply`);
  const named = Array.isArray(input.files) ? input.files.map(entry => String(entry ?? "").trim()).filter(entry => entry !== "") : [];
  if (named.length > TELL_MAX_FILES) return refused(`${named.length} files is past the ${TELL_MAX_FILES} one Tell carries; zip them, or deliver them with your reply`);
  if (context.tell === undefined) return refused("there is nobody to tell on this run. Put it in your reply");
  const conversation = context.conversation ?? MAIN_CONVERSATION;
  const awaiting = awaitingAnswer(context);
  const outcome = await context.tell.tell({
    agentId: context.agent.id, agentName: context.agent.profile.name, conversation, text, waited: context.personWaiting === true,
    ...(context.turnId !== undefined ? { turnId: context.turnId } : {}), ...(context.toolUseId !== undefined ? { callId: context.toolUseId } : {}),
    ...(awaiting !== undefined ? { awaiting } : {}),
    ...(named.length > 0 ? { attach: () => attachments(context, named, conversation) } : {}),
  });
  if (!outcome.delivered) return refused(outcome.why);
  // Said, and filed as said: the conversation is drawn from this record, and the work it belongs to keeps the line.
  if (context.turnId !== undefined) context.bus.heard?.said(context.agent.id, conversation, context.turnId, outcome.text, "told", context.work?.id, outcome.files);
  if (context.work !== undefined) context.bus.workAttention?.told(context.work, context.agent.id, outcome.text);
  const sent = outcome.files.map(file => file.name).filter(name => !outcome.unsent.includes(name));
  return {
    text:
      `${outcomeLine("ok")} ${JSON.stringify({ delivered: true, where: outcome.where, ...(sent.length > 0 ? { files: sent } : {}) })}` +
      (outcome.unsent.length > 0 ? `\nNot sent: ${outcome.unsent.join(", ")} — still in this chat's outbox, and goes out with your reply.` : "") +
      "\nKeep working. Your reply is still to be written, and does not repeat this.",
  };
}
