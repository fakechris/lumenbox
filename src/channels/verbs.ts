/** The two whole-message verbs a person says to work in a chat: stop it, and accept it. Each is the whole message or nothing. */

/**
 * A whole message that means "stop what you are doing".
 *
 * The same discipline as approval replies: the message must be *only* the verb. "停下来
 * 改用另一个文件夹" is an instruction that mentions stopping, and reading it as a stop
 * would throw away the half that says what to do instead.
 */
export function parseStopRequest(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[.!。!~]+$/, "");
  return ["停", "停下", "停下来", "先停", "取消", "算了", "别做了", "stop", "cancel", "/stop"].includes(t);
}

/**
 * A whole message that means "I accept this work".
 *
 * The walkthrough drew the person saying "好了"; real people say 可以, 收到, 没问题, OK.
 * Whole-message only, like every verb here — "可以再快点吗" is a question that contains
 * an acceptance word, and accepting on it would close work the person was pushing back on.
 */
export function parseAcceptance(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[.!。!~,,]+$/, "");
  return ["可以", "好了", "好的", "好", "收到", "没问题", "通过", "验收通过", "就这样", "ok", "okay", "lgtm", "辛苦了"].includes(t);
}
