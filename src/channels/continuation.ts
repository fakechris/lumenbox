/**
 * Whether a message sent while this conversation's work is running continues that work,
 * or is new work of its own.
 *
 * The first routing rule was "while something runs, a plain message is steering". It read
 * well for the case it was drawn from — "把毛利改成百分比" landing mid-report — and failed
 * the case people actually produce: a stream of unrelated links, fired while a three-minute
 * turn runs (2026-09-19, seq 17/18/19 in the inbox). Each was steered into the running turn,
 * none got a card or a board row, and after the turn ended nothing ran; from the chat it
 * looked like a queue that never started, when there was no queue at all.
 *
 * So the default is reversed. A message continues the running work only when it plainly
 * says so — the agent just asked this person something, or the words are a correction, an
 * addition, or a one-word acknowledgement. Everything else is new work, and new work
 * queues visibly: a card that says "排队中", a board row, and a turn of its own when the
 * conversation is free. The error this leaves is the cheap one — a follow-up that should
 * have joined the running turn waits a turn instead, in a card the person can see — where
 * the old error was the expensive one, an instruction swallowed with nobody told.
 */

/** Words that mark a correction or an addition to what is already being done. */
const CUE_PATTERN =
  /^(?:请)?(?:改成|改为|改一下|改回|换成|换个|不要|不用|去掉|删掉|加上|加个|补充|另外|顺便|还有|再加|等等|等一下|等下|稍等|重来|重新|不对|错了|不是这个|也要|同时|记得|对了|然后|先别|算上|漏了|改动|调整)/u;

/** A short named target followed by an edit, e.g. 毛利改成百分比. */
const SUBJECT_EDIT_PATTERN = /^[^\s。！？?!：:“”「」<>]{1,24}(?:改成|改为|改一下|改回|换成|去掉|删掉|加上)/u;

const ENGLISH_CUE_PATTERN =
  /^(also|actually|wait|instead|don't|dont|do not|rather|make it|change (it|that|the)|use the|add the|remove the|skip the|forget the|oh and|and also|one more|plus|never ?mind|hold on|scratch that)\b/i;

/** A whole message that only acknowledges: 好, 可以, ok — an answer, not a request. */
const ACKNOWLEDGEMENTS = new Set([
  "好", "好的", "好啊", "行", "可以", "嗯", "对", "是", "是的", "对的", "没错", "收到", "知道了", "明白", "没问题",
  "不", "不是", "不行", "不用", "不对",
  "ok", "okay", "k", "yes", "yep", "yeah", "no", "nope", "sure", "fine", "right", "correct", "wrong", "go", "go ahead",
]);

export interface ContinuationContext {
  /** The agent asked this person something and has not heard back. */
  awaitingAnswer: boolean;
}

/**
 * True when the message should join the running turn as steering; false when it should
 * open its own task and wait its turn.
 */
export function isContinuation(text: string, context: ContinuationContext): boolean {
  if (context.awaitingAnswer) return true;
  const trimmed = text.trim();
  if (trimmed === "") return true;
  const bare = trimmed.toLowerCase().replace(/[.!。!~,,、?？\s]+$/u, "");
  if (ACKNOWLEDGEMENTS.has(bare)) return true;
  // A message that names a reply option by number — "2", "第二个" — is an answer to
  // the question card that offered it, whether or not the card's own bookkeeping saw it.
  if (/^(第?[一二三四五六七八九十\d]+个?|[a-d])$/iu.test(bare)) return true;
  // A pasted article/question set is new work, even when its contents mention a
  // correction word. On 2026-09-20 “区别” in question 14 swallowed all 25 questions
  // into a running Jev lookup. Ambiguous, long or multi-line requests wait their
  // own turn; only short direct instructions qualify for lexical steering.
  if (trimmed.length > 200 || /[\r\n]/u.test(trimmed)) return false;
  if (/^(?:请问|为什么|为何|如何|什么|怎么|是否|能否|what\b|why\b|how\b|can\b|could\b)/iu.test(trimmed)) return false;
  // “别” is an imperative only at the start, never inside 区别 / 识别 / 特别.
  if (/^(?:请)?别(?!的)/u.test(trimmed)) return true;
  if (CUE_PATTERN.test(trimmed) || SUBJECT_EDIT_PATTERN.test(trimmed) || ENGLISH_CUE_PATTERN.test(trimmed)) return true;
  return false;
}
