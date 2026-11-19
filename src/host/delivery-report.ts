/**
 * What a member writes when it hands work over, in one fixed order (INV-1922).
 *
 * A person reading a delivery could not tell where to look or what had not been checked: the note
 * was whatever the member thought to say, and "done" covered a batch with one item missed as well
 * as it covered a finished one. So a delivery has six parts, always in this order, and the fifth —
 * what was not done, not verified, and the known limits — is written even when it is "none".
 *
 * This file is the one home of that order: the names of the parts, the sentence the prompt and the
 * Tasks tool say it with, and the reading of a note back into parts. The result card and panel, the
 * lines a chat is owed, and whatever is drawn from a delivery later all read it from here.
 *
 * Stored, a delivery is still the note the member wrote: free text on the task's history. Nothing
 * is validated and nothing is refused. A note that does not follow the order reads as `undefined`
 * and is shown as it was written, which is what happened before.
 */
import { isFence, opener, type NoteNames } from "./labelled-note.ts";
import { askLines, splitAsk } from "./person-ask.ts";
import type { Task } from "./tasks.ts";

/** The parts, in the order they are written and shown. */
export const DELIVERY_SECTIONS = ["result", "main", "other", "verified", "limits", "next"] as const;
export type DeliverySection = (typeof DELIVERY_SECTIONS)[number];

/** The short form: what a chat message carries and what the page shows before anything is opened. */
export const DELIVERY_BRIEF: readonly DeliverySection[] = ["result", "main", "limits", "next"];

/** One part of a delivery, as the member wrote it under that name. */
export interface DeliveryPart { key: DeliverySection; text: string }
/** A note read as a delivery: its parts in the fixed order, and the language its names were written in. */
export interface DeliveryReport { parts: DeliveryPart[]; lang: "en" | "zh" }

/** The names a part is written under. The first of each language is the one we write; the rest are what members write instead. */
const LABELS: NoteNames<DeliverySection> = {
  result: { en: ["Result", "Conclusion", "Summary"], zh: ["结论", "结果"] },
  main: { en: ["Main change", "Main changes", "What changed", "Look at"], zh: ["主要改动", "主要变更", "主要修改"] },
  other: { en: ["Other changes", "Other change", "Also changed"], zh: ["其他改动", "其它改动", "其他变更"] },
  verified: { en: ["Verified", "Verification", "What was verified", "Checked", "Tested"], zh: ["已验证", "验证了什么", "验证"] },
  limits: {
    en: ["Not done or limits", "Not done, not verified, limits", "Not done / limits", "Not done", "Not verified", "Known limits", "Limitations", "Limits"],
    zh: ["未做与局限", "没做的与局限", "没做的、没验证的、已知局限", "未做", "没做的", "未验证", "没验证的", "已知局限", "局限"],
  },
  next: { en: ["Next", "Next step", "Next steps"], zh: ["下一步", "接下来", "后续"] },
};

/** The name a part is shown under, in a language. */
export const deliveryLabel = (key: DeliverySection, lang: "en" | "zh"): string => LABELS[key][lang][0]!;

/**
 * The rule as a member is told it, once: the closing-message paragraph of the prompt carries it and
 * the Tasks tool points at it by name. Built from the names above so what is asked for is what is read.
 */
export const DELIVERY_ORDER =
  "When you hand over work rather than an answer, the closing message and a Tasks submit note follow the delivery order, one line each, labelled in their language: " +
  `${both("result")} — one sentence; ${both("main")} — and the one place most worth a close look, with file or location; ` +
  `${both("other")} — optional; ${both("verified")} — what, how, on which version, a batch counted against its list; ` +
  `${both("limits")} — also not verified, "none" if none; ${both("next")} — who does what. ` +
  `In a chat keep ${DELIVERY_BRIEF.map(key => deliveryLabel(key, "en")).join(", ")}.`;

function both(key: DeliverySection): string {
  return `${deliveryLabel(key, "en")} (${deliveryLabel(key, "zh")})`;
}

/** Whether a line opens a part, and which (labelled-note.ts). */
const opening = opener(LABELS);

/**
 * A note read as a delivery, or undefined when it is not written as one.
 *
 * What stands before the first name is the result: a member that leads with its conclusion and then
 * names the rest has followed the order. One named line in a note is a sentence that happened to
 * start that way, so a delivery is two parts or more. Parts come back in the fixed order whatever
 * order they were written in, and a name used twice is one part. A request to the person written in
 * the same note (person-ask.ts) is read by its own reader and is no part of the delivery.
 */
export function parseDelivery(text: string | undefined): DeliveryReport | undefined {
  const found = new Map<DeliverySection, string[]>(), langs = { en: 0, zh: 0 };
  let current: DeliverySection | undefined, fence = false;
  for (const line of splitAsk(text).rest.split("\n")) {
    if (isFence(line)) fence = !fence;
    const opened = fence ? undefined : opening(line);
    if (opened !== undefined) { current = opened.key; langs[opened.lang]++; }
    else if (current === undefined) { if (line.trim() === "") continue; current = "result"; }
    const lines = found.get(current!) ?? [];
    lines.push(opened !== undefined ? opened.rest : line);
    found.set(current!, lines);
  }
  const parts = DELIVERY_SECTIONS.flatMap(key => {
    const said = (found.get(key) ?? []).join("\n").trim();
    return said === "" ? [] : [{ key, text: said }];
  });
  if (langs.en + langs.zh === 0 || parts.length < 2) return undefined;
  return { parts, lang: langs.zh > langs.en ? "zh" : "en" };
}

/** Whether a part says there is nothing to say: "none", "无", "n/a". */
export function saysNone(text: string): boolean {
  return /^(none|nothing|n\/a|无|没有|暂无)[\s.。!！]*$/i.test(text.trim());
}

/** The note a member delivered a task with: on its newest move to review or done, by its assignee. */
function deliveredWith(task: Task): { at: string; note: string } | undefined {
  const change = task.history.findLast(move => move.by === task.assigneeId && (move.status === "review" || move.status === "done") && (move.note ?? "").trim() !== "");
  return change === undefined ? undefined : { at: change.at, note: change.note! };
}

/**
 * What a chat is owed under a reply, once per delivery (channel and page say the same thing).
 *
 * The page shows the limits of a delivery whatever else it folds away, and the member's request to
 * the person as the card (person-ask.ts, INV-1923). A chat shows the member's reply, and a reply that
 * says "done" over a note that says "not verified on the live site" tells the person in the chat less
 * than the page tells them. So what the note carries and the reply does not follows the reply: the
 * request, when the reply does not say its action, and the part that names something not done or not
 * verified. Nothing is added for "none", for a note that carries neither, or a second time.
 */
export function owedToChat(taskOf: (id: string) => Task | undefined): (taskId: string, reply: string) => string | undefined {
  const said = new Set<string>();
  return (taskId, reply) => {
    const task = taskOf(taskId), delivered = task === undefined ? undefined : deliveredWith(task);
    if (task === undefined || delivered === undefined || said.has(`${task.id}@${delivered.at}`)) return undefined;
    const report = parseDelivery(delivered.note), ask = splitAsk(delivered.note).ask, limits = report?.parts.find(part => part.key === "limits");
    const unsaid = limits !== undefined && !saysNone(limits.text) && parseDelivery(reply)?.parts.some(part => part.key === "limits") !== true && !reply.includes(limits.text);
    const lines = [
      ...(ask !== undefined && !reply.includes(ask.title) ? askLines(ask) : []),
      ...(unsaid ? [`${deliveryLabel("limits", report!.lang)}${report!.lang === "zh" ? "：" : ": "}${limits.text}`] : []),
    ];
    if (ask !== undefined || (limits !== undefined && !saysNone(limits.text))) said.add(`${task.id}@${delivered.at}`);
    return lines.length === 0 ? undefined : lines.join("\n");
  };
}
