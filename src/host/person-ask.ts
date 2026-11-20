/**
 * What a member writes when it needs the person to act (INV-1923).
 *
 * The card that said "needs you" was assembled from a fixed table: one sentence per category of
 * reason, and the same three buttons whatever was in the way. A person could not tell what exactly
 * they were to do, why it had to be them, or whether the member had stopped working because of it.
 * The member knows all three. So it writes the card: a title that is the action, a sentence each for
 * what happened, why it is the person's turn, exactly how, and what it keeps doing meanwhile, and
 * what stays the person's to check.
 *
 * This file is the one home of that writing: the names, the sentence the prompt asks for it with,
 * the reading of a note back into a request, its short form, and the lines a chat is sent. The page card, the inbox
 * row and the chat all read it from here, so they say the same thing.
 *
 * Like a delivery (delivery-report.ts), it is stored as the note the member wrote and nothing is
 * validated or refused. A note with no title line is not a request and is shown as it was written,
 * under the fixed sentences that were there before.
 *
 * The title's name says what is in the way, and the buttons follow it: something the person does
 * elsewhere, a go-ahead, or a result to look at. It grants nothing: a go-ahead given on this card is
 * the person's word to the member, as a typed reply is. What the policy gate holds is asked for by
 * the gate, on its own card.
 */
import { isFence, opener, type NoteNames } from "./labelled-note.ts";
import type { Task } from "./tasks.ts";

/** What is in the way: the person does something elsewhere, gives a go-ahead, or looks at a result. */
export const ASK_KINDS = ["act", "approve", "check"] as const;
export type AskKind = (typeof ASK_KINDS)[number];

/** The sentences under the title, in the order they are shown. */
export const ASK_SENTENCES = ["happened", "why", "how", "meanwhile", "unverified"] as const;
export type AskSentence = (typeof ASK_SENTENCES)[number];

/** One sentence of a request, as the member wrote it under that name. */
export interface AskSaid { key: AskSentence; text: string }
/** A note read as a request: what is in the way, the action, the sentences in the fixed order, the language of its names. */
export interface PersonAsk { kind: AskKind; title: string; said: AskSaid[]; lang: "en" | "zh" }

const NAMES: NoteNames<AskKind | AskSentence> = {
  act: { en: ["Please do", "Your move", "Needs you"], zh: ["请你做", "需要你做", "需要你"] },
  approve: { en: ["Please approve", "Please allow"], zh: ["请你批准", "请批准", "请你放行"] },
  check: { en: ["Please check", "Please confirm", "Please review"], zh: ["请你确认", "请你过目", "请你检查"] },
  happened: { en: ["What happened", "Happened"], zh: ["发生了什么", "发生了"] },
  why: { en: ["Why you", "Why it is your turn", "Why it's your turn"], zh: ["为什么是你", "为什么轮到你"] },
  how: { en: ["How", "What to do", "How to do it"], zh: ["怎么做", "具体怎么做"] },
  meanwhile: { en: ["Meanwhile", "In the meantime"], zh: ["我同时在做", "与此同时", "同时"] },
  unverified: { en: ["Still yours to check", "Yours to check"], zh: ["仍归你检查", "仍归你的检查"] },
};

/** The name a title or a sentence is shown under, in a language. */
export const askLabel = (key: AskKind | AskSentence, lang: "en" | "zh"): string => NAMES[key][lang][0]!;

const both = (key: AskKind | AskSentence): string => `${askLabel(key, "en")} (${askLabel(key, "zh")})`;

/**
 * The rule as a member is told it, once, in the prompt's paragraph about asking. Built from the names
 * above so what is asked for is what is read.
 */
export const PERSON_ASK_RULE =
  "When work waits on the person, say so on its task — Tasks update to blocked, or submit — in a note that opens with the action, labelled in their language: " +
  `${both("act")}, ${both("approve")} or ${both("check")} — an imperative with its object. Then one line each: ` +
  `${both("happened")}; ${both("why")}; ${both("how")} — the exact step, with link or location; ${both("meanwhile")} — what you keep doing; ${both("unverified")}. ` +
  "For a go-ahead, `options` name its two buttons by what happens (\"Send it\", \"Don't send\"). While you wait, keep doing whatever else does not need them.";

const opening = opener(NAMES);
const isKind = (key: AskKind | AskSentence): key is AskKind => (ASK_KINDS as readonly string[]).includes(key);
const clip = (text: string, limit: number): string => (text.length > limit ? `${text.slice(0, limit)}…` : text);

/**
 * A note read as a request, and what is left of the note without it.
 *
 * A request is its title line; without one, the note is returned whole and nothing is read from it,
 * so a sentence that happens to start "Meanwhile:" stays where it was written. Each part is one
 * line: the first title and the first of each sentence are taken, anything said twice stays in the
 * note. Names inside a code block are code.
 */
export function splitAsk(text: string | undefined): { ask?: PersonAsk; rest: string } {
  const whole = text ?? "", kept: string[] = [], said = new Map<AskSentence, string>(), langs = { en: 0, zh: 0 };
  let title: { kind: AskKind; text: string } | undefined, fence = false;
  for (const line of whole.split("\n")) {
    if (isFence(line)) fence = !fence;
    const opened = fence ? undefined : opening(line);
    if (opened === undefined || opened.rest === "") { kept.push(line); continue; }
    if (isKind(opened.key)) {
      if (title !== undefined) { kept.push(line); continue; }
      title = { kind: opened.key, text: opened.rest };
    } else {
      if (said.has(opened.key)) { kept.push(line); continue; }
      said.set(opened.key, opened.rest);
    }
    langs[opened.lang]++;
  }
  if (title === undefined) return { rest: whole };
  const sentences = ASK_SENTENCES.flatMap(key => (said.has(key) ? [{ key, text: clip(said.get(key)!, 400) }] : []));
  return {
    ask: { kind: title.kind, title: clip(title.text, 160), said: sentences, lang: langs.zh > langs.en ? "zh" : "en" },
    rest: kept.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
  };
}

/**
 * A request at the level a person reads first: the member's sentences as one running paragraph, and
 * apart from it what stays the person's to check. The names the sentences were written under are how
 * a member writes, not something to read past on a card: they are shown one click away, in the work's
 * panel. Each sentence is closed if the member left it open, so two do not run into one. One name is
 * kept, in line: what the member does meanwhile is what tells a person the work has not stopped.
 *
 * Self-contained on purpose: the page runs this same source (next-need-ui.ts), so card and chat agree.
 */
export function askProse(ask: { said?: { key: string; text: string }[]; lang?: string }): { text: string; yours?: string } {
  const zh = ask.lang === "zh", closed = (text: string): string => (/[.!?。！？…:：;；)）`*]$/.test(text.trim()) ? text.trim() : text.trim() + (zh ? "。" : "."));
  const said = ask.said ?? [], yours = said.find(row => row.key === "unverified")?.text.trim();
  // What it keeps doing is a fragment without its name ("the September books."), so that one keeps it, in line.
  const lead = (key: string): string => (key !== "meanwhile" ? "" : zh ? "我同时在做：" : "Meanwhile: ");
  const text = said.filter(row => row.key !== "unverified" && row.text.trim() !== "").map(row => lead(row.key) + closed(row.text)).join(zh ? "" : " ");
  return yours ? { text, yours } : { text };
}

/** A request as the lines a chat is sent, by the rule the page card follows: the action, the running text, what stays the person's to check. */
export function askLines(ask: PersonAsk): string[] {
  const colon = ask.lang === "zh" ? "：" : ": ", prose = askProse(ask);
  return [
    `${askLabel(ask.kind, ask.lang)}${colon}${ask.title}`,
    ...(prose.text === "" ? [] : [prose.text]),
    ...(prose.yours === undefined ? [] : [`${askLabel("unverified", ask.lang)}${colon}${prose.yours}`]),
  ];
}

/** The request a member's newest word on a task carries, while the task waits on a person: blocked, or delivered for a look. */
export function askOf(task: Pick<Task, "status" | "history" | "assigneeId">): PersonAsk | undefined {
  if (task.status !== "blocked" && task.status !== "review") return undefined;
  const change = task.history.findLast(move => move.status === task.status);
  return change === undefined || change.by !== task.assigneeId ? undefined : splitAsk(change.note).ask;
}
