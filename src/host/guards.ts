/**
 * Bounded runtime guards on how a person-opened turn may end (docs/31 layer 1e).
 *
 * The engine minds two things the prompt was asked to carry and could not: whether a verdict
 * about the world was reached with no tool touched, and whether a promise to act was made
 * with no action in the same response. Both references run guards of this kind — Grok Bot's
 * are structural (delivery owed, ack then silence), Hermes's textual (a trailing intent, an
 * intent-ack) — and both bound them: once or twice per turn, logged, the nudge kept out of
 * the durable record. So here.
 *
 * The incident these exist for, from Bob's transcript on 2026-09-0x: a person-opened turn,
 * zero tool calls, and "Qwen 没有 27B … GLM 目前公开到 4.x，没有 5.3-flash" — both released
 * two weeks earlier. The structural signal is the strong one: *no tool ran, and the reply
 * rules on a named, datable thing*. The phrases below are the weak one, kept in one file with
 * a test per phrase so they are tuned from the `[conduct]` log rather than argued about.
 *
 * `AGENTBOX_GUARDS=0` switches every guard off, for the ablation run R28 established.
 */

/** Which guard fired, for the log and the counter. */
export type GuardReason = "verdict-without-check" | "offers-to-check" | "trailing-intent";

/** How many times the guards may send the model back in one turn. Hermes: 2. */
export const MAX_GUARD_NUDGES = 2;

export function guardsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AGENTBOX_GUARDS !== "0";
}

/**
 * A ruling on the existence, currency or reality of a named thing.
 *
 * Deliberately narrow: "does not exist", "no such version", "not yet released", "only up to
 * 4.x", "you probably mean" — the shapes an answer from weights takes when the world moved.
 * Not "I don't know", which is honest and needs no tool.
 */
const VERDICT_PATTERNS: readonly RegExp[] = [
  /不存在|并不存在|没有这个|没有.{0,16}(型号|版本|模型|产品|规格)|尚未(发布|推出|公开)|还没有(发布|推出|公开)/u,
  /目前(公开|发布|最新|只)(到|有|是)/u,
  /(有水分|虚构|臆测|杜撰|编造|写错了|拼错了|应该是指|你可能(是)?指|你说的.{0,8}其实是)/u,
  /\b(does not|doesn't|did not|didn't) exist\b/i,
  /\bthere (is|was) no (such )?\b/i,
  /\bnot (yet )?(been )?(released|announced|public)\b/i,
  /\b(only|latest|current) (public )?(version|release)s? (is|are|go(es)? up to)\b/i,
  /\b(probably|likely|must) (mean|meant)\b/i,
  /\b(fictional|made[- ]up|a typo|inflated)\b/i,
];

/** An offer to use a tool instead of using it. */
const OFFER_PATTERNS: readonly RegExp[] = [
  /要不要我(现在|去|再|帮你|来|就)*(查|核|搜|看|翻|确认)/u,
  /需要的话我(就|去|再|可以|来|现在)*(查|核|搜|看|翻|确认)/u,
  /如果.{0,10}我(就|再|可以|马上|去|来|现在)*(查|核|搜|看|翻|确认)/u,
  /我可以(帮你|去|再)?(查|核实|核对|搜|翻|确认)一下/u,
  /(要|想)我(现在)?(开干|动手|开始)/u,
  /\b(want|would you like|shall I|should I|do you want) me to (check|verify|look|search|confirm|dig)/i,
  /\bI (can|could) (check|verify|look (it|that|this) up|search|confirm) (if|when|should) you\b/i,
  /\bif you('d| would) like,? I('ll| will| can) (check|verify|look|search)/i,
  /\blet me know if (you want|I should) (me to )?(check|verify|look|search)/i,
];

/** A short reply that ends by announcing a first-person action it did not take. */
const TRAILING_INTENT_PATTERNS: readonly RegExp[] = [
  /(我先|让我|我这就|我马上|我现在就|我去)[^。！？\n]{0,30}(查|核|搜|看|翻|读|跑|试|确认|验证)[^。！？\n]{0,12}[。！]?\s*$/u,
  /\b(let me|I'll|I will|I'm going to|I am going to)( now)? (check|verify|look|search|read|run|try|confirm|fetch|pull)[^.!?\n]{0,40}[.!]?\s*$/i,
];

const TRAILING_INTENT_MAX_CHARS = 400;

export function verdictWithoutCheck(text: string): boolean {
  return VERDICT_PATTERNS.some(pattern => pattern.test(text));
}

export function offersToCheck(text: string): boolean {
  return OFFER_PATTERNS.some(pattern => pattern.test(text));
}

export function trailingIntent(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > TRAILING_INTENT_MAX_CHARS) return false;
  return TRAILING_INTENT_PATTERNS.some(pattern => pattern.test(trimmed));
}

/**
 * Which guard, if any, a final text trips.
 *
 * The structural condition comes first and is the only one that unlocks the verdict and
 * offer families: a turn that already used a tool has checked *something*, and a ruling
 * after evidence is the model's to make. The trailing-intent family applies regardless —
 * "I'll check now" with nothing following is wrong at any point in a turn.
 */
export function guardFor(text: string, toolCallsThisTurn: number): GuardReason | undefined {
  if (toolCallsThisTurn === 0) {
    if (verdictWithoutCheck(text)) return "verdict-without-check";
    if (offersToCheck(text)) return "offers-to-check";
  }
  if (trailingIntent(text)) return "trailing-intent";
  return undefined;
}

/** What the model is told, per reason. Not written to the durable record (Hermes's rule). */
export function nudgeFor(reason: GuardReason, chinese: boolean): string {
  switch (reason) {
    case "verdict-without-check":
      return chinese
        ? "[harness] 你刚才对一个具体事物的存在、版本或真伪下了结论，但这一轮没有调用任何工具。你的权重和记忆是过去；先用工具（WebSearch 等）核实，再回答。不要重复刚才的话。"
        : "[harness] You ruled on whether a named thing exists, its version or its reality, and no tool ran this turn. Your weights and memory are the past; check it with a tool (WebSearch, for one) before answering. Do not repeat what you just said.";
    case "offers-to-check":
      return chinese
        ? "[harness] 你在问要不要查，而不是去查。你持有工具，不需要征求许可：现在就调用工具核实，然后把结果告诉对方。"
        : "[harness] You offered to check instead of checking. You hold the tools and need no permission: call them now, then report what you found.";
    case "trailing-intent":
      return chinese
        ? "[harness] 你说你要去做，但这条回复里没有任何工具调用。就在这一条里做：发出对应的调用。"
        : "[harness] You said you would act, and this response contains no tool call. Do it in this response: issue the call.";
    default:
      return "[harness] Act, do not describe acting.";
  }
}

/** What Grok Bot calls a closing send: the person saw an acknowledgement and then nothing. */
export function closingNudge(chinese: boolean): string {
  return chinese
    ? "[harness] 你开头向对方打了招呼，然后跑了工具，最后什么都没说。对方最后看到的只有那句招呼。现在把结果告诉他们——短一点也行，但必须是结果。"
    : "[harness] You acknowledged the person, ran tools, and ended without a word. The last thing they saw is the acknowledgement. Deliver the result now — short is fine, but it must be the result.";
}

/** Whether a text reads as Chinese: enough CJK to decide which nudge to write. */
export function readsAsChinese(text: string): boolean {
  const cjk = (text.match(/[一-鿿]/g) ?? []).length;
  return cjk >= 8 || (cjk > 0 && cjk * 4 >= text.replace(/\s/g, "").length);
}
